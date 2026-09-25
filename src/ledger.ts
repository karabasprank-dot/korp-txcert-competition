import { z } from "zod";
import { keccak256, toHex } from "viem";
import { transactionHash, policyHash } from "./core/canonicalize.js";
import type { CheckRequest } from "./schemas/index.js";
import { NETWORKS, type Config } from "./config.js";

type SavedResponse = {
  status: number;
  body: string;
  headers: Record<string, string>;
};
type Entry = { fingerprint: string; response?: SavedResponse };
const digest = z.string().regex(/^0x[0-9a-f]{64}$/);
const identitySchema = z.object({
  x402Version: z.literal(2),
  accepted: z.object({
    network: z.string(),
    asset: z.string(),
    payTo: z.string(),
    amount: z.literal("10000"),
    scheme: z.literal("exact"),
  }),
  payload: z.object({
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    authorization: z.object({
      from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      validBefore: z.string().regex(/^\d{1,16}$/),
    }),
  }),
});
export function paymentIdentity(
  header: string,
  request: CheckRequest,
  config: Config,
) {
  const p = identitySchema.parse(JSON.parse(atob(header)));
  if (
    p.accepted.network !== config.NETWORK ||
    p.accepted.asset.toLowerCase() !==
      NETWORKS[config.NETWORK].usdc.toLowerCase() ||
    p.accepted.payTo.toLowerCase() !== config.PAY_TO_ADDRESS.toLowerCase() ||
    p.payload.authorization.to.toLowerCase() !==
      config.PAY_TO_ADDRESS.toLowerCase()
  )
    throw new Error("Wrong payment destination/network");
  const a = p.payload.authorization;
  return {
    id: keccak256(
      toHex(
        JSON.stringify([
          config.NETWORK,
          p.accepted.asset.toLowerCase(),
          a.from.toLowerCase(),
          a.nonce.toLowerCase(),
        ]),
      ),
    ),
    fingerprint: keccak256(
      toHex(
        JSON.stringify([
          header,
          transactionHash(request),
          policyHash(request.policy),
        ]),
      ),
    ),
    validBefore: Number(a.validBefore),
  };
}

// One SQLite-backed object per EIP-3009 nonce. Accessible only through a Worker binding.
// Persist the claim BEFORE settlement. A crash/uncertain settlement keeps the claim
// locked; it never authorizes a new result. Successful retries return original bytes.
export class PaymentLedger {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    const body = z
      .object({
        fingerprint: digest,
        response: z
          .object({
            status: z.number().int().min(200).max(599),
            body: z.string().max(65536),
            headers: z.record(z.string(), z.string()),
          })
          .optional(),
      })
      .parse(await request.json());
    const action = new URL(request.url).pathname;
    return this.state.blockConcurrencyWhile(async () => {
      const entry = await this.state.storage.get<Entry>("entry");
      if (entry && entry.fingerprint !== body.fingerprint)
        return Response.json(
          { error: "PAYMENT_BOUND_TO_DIFFERENT_REQUEST" },
          { status: 409 },
        );
      if (action === "/finish") {
        if (!entry || !body.response || entry.response)
          return Response.json(
            { error: "INVALID_LEDGER_TRANSITION" },
            { status: 409 },
          );
        await this.state.storage.put("entry", {
          ...entry,
          response: body.response,
        });
        return new Response(null, { status: 204 });
      }
      if (entry?.response) {
        const headers = new Headers(entry.response.headers);
        headers.set("X-Korp-Idempotent-Replay", "true");
        headers.set("Cache-Control", "no-store");
        return new Response(entry.response.body, {
          status: entry.response.status,
          headers,
        });
      }
      if (entry)
        return Response.json(
          {
            error: "PAYMENT_IN_PROGRESS_OR_UNCERTAIN",
            retry:
              "Retry the identical authorization. Do not create a new payment until its onchain outcome is known.",
          },
          { status: 409 },
        );
      if (action === "/peek") return new Response(null, { status: 204 });
      if (action !== "/claim") return new Response(null, { status: 404 });
      await this.state.storage.put("entry", { fingerprint: body.fingerprint });
      await this.state.storage.setAlarm(Date.now() + 86400000);
      return new Response(null, { status: 201 });
    });
  }
  async alarm() {
    await this.state.storage.deleteAll();
  }
}

export async function saveResponse(
  stub: DurableObjectStub,
  fingerprint: string,
  response: Response,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
  };
  for (const name of [
    "PAYMENT-RESPONSE",
    "PAYMENT-REQUIRED",
    "EXTENSION-RESPONSES",
  ]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  const result = await stub.fetch("https://ledger/finish", {
    method: "POST",
    body: JSON.stringify({
      fingerprint,
      response: {
        status: response.status,
        body: await response.clone().text(),
        headers,
      },
    }),
  });
  if (!result.ok) throw new Error("Response journal unavailable");
}
