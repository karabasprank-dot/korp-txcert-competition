import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestSchema } from "./schemas/index.js";
import { z } from "zod";
import { verifyPromiseBreach } from "./core/promise-receipt.js";
import promiseDemo from "../live-testnet/assets/promise-receipt-demo.json";
import {
  evaluateOutcome,
  outcomeContractSchema,
} from "./core/outcome-contract.js";
import {
  baseSepolia,
  sepolia,
  arbitrumSepolia,
  optimismSepolia,
} from "viem/chains";
const networks = [baseSepolia, sepolia, arbitrumSepolia, optimismSepolia];
const liveSchema = requestSchema.extend({ chainId: z.number().int().safe() });
const rpcRowsSchema = z
  .array(
    z.object({
      id: z.number().int().min(1).max(4),
      result: z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i),
      error: z.never().optional(),
    }),
  )
  .length(4);
// Retry transport/throttling once, never malformed data or a wrong chain.
async function readRpc(rpcFetch: typeof fetch, endpoint: string, body: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await rpcFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(4500),
      });
    } catch {
      if (attempt === 0) continue;
      throw new Error("RPC_TRANSPORT");
    }
    if (!response.ok) {
      if (
        attempt === 0 &&
        (response.status === 429 || response.status >= 500)
      ) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      throw new Error("RPC_HTTP");
    }
    return rpcRowsSchema.parse(await response.json());
  }
  throw new Error("RPC_UNAVAILABLE");
}

// Separate, read-only testnet service. No private keys, mainnet or broadcasting.
export function createLiveTestnet(rpcFetch: typeof fetch = fetch) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });
  app.use("/api/*", bodyLimit({ maxSize: 16384 }));
  app.post("/api/promise-check", async (c) => {
    try {
      const { scenario } = z
        .strictObject({
          scenario: z.enum([
            "original",
            "rewritten-promise",
            "fabricated-response",
          ]),
        })
        .parse(await c.req.json());
      const proof =
        scenario === "original"
          ? promiseDemo.proof
          : scenario === "rewritten-promise"
            ? promiseDemo.tamperedProofs.rewrittenMerchantPromise
            : promiseDemo.tamperedProofs.fabricatedBuyerResponse;
      const result = await verifyPromiseBreach(proof, promiseDemo.trust);
      return c.json({
        scenario,
        result,
        mode: "fixed synthetic evidence; expired test authorization; no payments",
        settlementVerified: false,
      });
    } catch {
      return c.json({ error: "INVALID_PROMISE_SCENARIO" }, 400);
    }
  });
  app.post("/api/outcome-check", async (c) => {
    const schema = z.strictObject({
      contract: outcomeContractSchema,
      body: z.string().max(8192).nullable(),
      httpStatus: z.number().int().min(100).max(599).nullable(),
    });
    try {
      const r = schema.parse(await c.req.json());
      return c.json(
        evaluateOutcome(
          r.contract,
          r.body,
          r.httpStatus,
          Math.floor(Date.now() / 1000),
        ),
      );
    } catch {
      return c.json({ error: "INVALID_OUTCOME_REQUEST" }, 400);
    }
  });
  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      networks: networks.map((n) => ({ chainId: n.id, name: n.name })),
      mode: "live-policy-check",
      broadcasts: false,
      certificates: false,
    }),
  );
  app.post("/api/check", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "INVALID_JSON" }, 400);
    }
    const parsed = liveSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const request = parsed.data;
    const network = networks.find((n) => n.id === request.chainId);
    if (!network) return c.json({ error: "TESTNET_ONLY" }, 400);
    if (
      request.transaction.data !== "0x" ||
      request.policy.expectedAction !== "native-transfer"
    )
      return c.json({ error: "NATIVE_TRANSFER_ONLY" }, 400);
    const burn = [
      "0x0000000000000000000000000000000000000000",
      "0x000000000000000000000000000000000000dead",
    ];
    const checks = [
      {
        id: "SENDER_NOT_BURN",
        pass: !burn.includes(request.from.toLowerCase()),
      },
      {
        id: "TARGET_NOT_BURN",
        pass: !burn.includes(request.transaction.to.toLowerCase()),
      },
      {
        id: "NATIVE_VALUE_LIMIT",
        pass:
          BigInt(request.transaction.value) <=
          BigInt(request.policy.maxNativeValueWei),
      },
      {
        id: "RECIPIENT_ALLOWED",
        pass: request.policy.allowedRecipients.some(
          (a) => a.toLowerCase() === request.transaction.to.toLowerCase(),
        ),
      },
    ];
    const evaluation = {
      decision: checks.every((c) => c.pass) ? "PASS" : "BLOCK",
      chainId: request.chainId,
      checks,
    };
    if (evaluation.decision === "BLOCK")
      return c.json({
        evaluation,
        chain: null,
        observedAt: null,
        networkState: "not-requested",
        certificate: null,
        broadcast: false,
        notice:
          "Rejected by supplied policy before any RPC request. No chain state was read and no funds were sent.",
      });
    try {
      const rows = await readRpc(
        rpcFetch,
        network.rpcUrls.default.http[0],
        JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
          { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
          {
            jsonrpc: "2.0",
            id: 3,
            method: "eth_getBalance",
            params: [request.from, "latest"],
          },
          {
            jsonrpc: "2.0",
            id: 4,
            method: "eth_getTransactionCount",
            params: [request.from, "pending"],
          },
        ]),
      );
      const values = new Map(rows.map((row) => [row.id, row.result]));
      if (values.size !== 4) throw new Error("RPC_DUPLICATE_ID");
      const value = (id: number) => {
        const v = values.get(id);
        if (!v) throw new Error("RPC_MISSING");
        return BigInt(v);
      };
      if (value(1) !== BigInt(network.id)) throw new Error("RPC_CHAIN");
      return c.json({
        evaluation,
        networkState: "available",
        observedAt: new Date().toISOString(),
        chain: {
          chainId: network.id,
          block: value(2).toString(),
          balanceWei: value(3).toString(),
          pendingNonce: value(4).toString(),
        },
        certificate: null,
        broadcast: false,
        notice:
          "Policy evaluation only. No certificate, signature, budget enforcement or transfer. RPC state can change.",
      });
    } catch {
      return c.json(
        {
          error: "TESTNET_RPC_UNAVAILABLE",
          evaluation,
          chain: null,
          observedAt: null,
          networkState: "unavailable",
          certificate: null,
          broadcast: false,
          notice:
            "Policy result only. Network state could not be verified; do not treat this as transaction approval.",
        },
        503,
      );
    }
  });
  return app;
}
export default createLiveTestnet();
