import { it, expect } from "vitest";
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { PaymentRequired } from "@x402/core/types";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PaymentLedger } from "../src/ledger.js";
import { createApp } from "../src/index.js";
import { parseConfig, NETWORKS, type Bindings } from "../src/config.js";
import { TestFacilitator } from "./facilitator.js";
import { env, native } from "./fixtures.js";

// Exercise the actual ledger with serialized storage across app/isolate restarts.
function namespace() {
  const objects = new Map<string, PaymentLedger>();
  let failFinish = false;
  const ns = {
    idFromName: (id: string) => id,
    get: (id: string) => {
      if (!objects.has(id)) {
        const data = new Map<string, unknown>();
        let queue = Promise.resolve();
        const state = {
          storage: {
            get: async (key: string) => data.get(key),
            put: async (key: string, value: unknown) => {
              data.set(key, structuredClone(value));
            },
            setAlarm: async () => {},
            deleteAll: async () => {
              data.clear();
            },
          },
          blockConcurrencyWhile: <T>(fn: () => Promise<T>) => {
            const result = queue.then(fn);
            queue = result.then(
              () => {},
              () => {},
            );
            return result;
          },
        };
        objects.set(
          id,
          new PaymentLedger(state as unknown as DurableObjectState),
        );
      }
      return {
        fetch: (url: string, init: RequestInit) => {
          if (failFinish && url.endsWith("/finish"))
            throw new Error("storage unavailable");
          return objects.get(id)!.fetch(new Request(url, init));
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  return {
    ns,
    breakFinish: () => {
      failFinish = true;
    },
  };
}
const mainnet = (ledger: DurableObjectNamespace): Bindings => ({
  ...env,
  ENVIRONMENT: "mainnet",
  NETWORK: "eip155:8453",
  ENABLE_MAINNET: "true",
  X402_FACILITATOR_URL: "https://facilitator.payai.network",
  PAYMENT_LEDGER: ledger,
});
const payer = privateKeyToAccount(generatePrivateKey());
async function setup() {
  const storage = namespace();
  const bindings = mainnet(storage.ns);
  const facilitator = new TestFacilitator("eip155:8453");
  facilitator.idempotent = true;
  let app = createApp({ facilitator });
  const request = { ...native(), chainId: 8453 };
  const send = (header?: string, body = request) =>
    app.fetch(
      new Request(env.SERVICE_URL + "/v1/certify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(header ? { "PAYMENT-SIGNATURE": header } : {}),
        },
        body: JSON.stringify(body),
      }),
      bindings,
    );
  const challenge = await send();
  expect(challenge.status).toBe(402);
  const required = (await challenge.json()) as PaymentRequired;
  expect(required.accepts[0]).toMatchObject({
    network: "eip155:8453",
    asset: NETWORKS["eip155:8453"].usdc,
    amount: "10000",
    payTo: env.PAY_TO_ADDRESS,
  });
  const client = new x402Client().register(
    "eip155:8453",
    new ExactEvmScheme(payer),
  );
  const payload = await client.createPaymentPayload(required);
  const header = btoa(JSON.stringify(payload));
  return {
    send,
    header,
    payload,
    request,
    facilitator,
    bindings,
    storage,
    restart: () => {
      app = createApp({ facilitator });
    },
  };
}
it("requires explicit, consistent mainnet configuration and persistent ledger", () => {
  const good = mainnet(namespace().ns);
  expect(parseConfig(good).chainId).toBe(8453);
  for (const change of [
    { PAYMENT_LEDGER: undefined },
    { ENABLE_MAINNET: "false" },
    { NETWORK: "eip155:84532" },
    { ENVIRONMENT: "testnet" },
    { X402_FACILITATOR_URL: "https://x402.org/facilitator" },
    { X402_MODE: "development" },
  ]) {
    expect(() => parseConfig({ ...good, ...change })).toThrow();
  }
});
it("recovers identical result after Worker restart; prevents different request reusing payment", async () => {
  const t = await setup();
  const first = await t.send(t.header);
  expect(first.status).toBe(200);
  const body = await first.text();
  expect(JSON.parse(body).certificate.chainId).toBe(8453);
  t.restart();
  const retry = await t.send(t.header);
  expect(retry.status).toBe(200);
  expect(retry.headers.get("X-Korp-Idempotent-Replay")).toBe("true");
  expect(await retry.text()).toBe(body);
  const changed = await t.send(t.header, {
    ...t.request,
    transaction: { ...t.request.transaction, value: "999" },
  });
  expect(changed.status).toBe(409);
  expect(t.facilitator.settled).toBe(1);
  expect(t.facilitator.verified).toBe(1);
});
it("serializes concurrent copies of one authorization to one settlement", async () => {
  const t = await setup();
  const results = await Promise.all([t.send(t.header), t.send(t.header)]);
  expect(results.some((r) => r.status === 200)).toBe(true);
  expect(results.every((r) => [200, 409].includes(r.status))).toBe(true);
  expect(t.facilitator.settled).toBe(1);
});
it("does not claim a rejected signature", async () => {
  const t = await setup();
  t.facilitator.reject = true;
  expect((await t.send(t.header)).status).toBe(402);
  t.facilitator.reject = false;
  expect((await t.send(t.header)).status).toBe(200);
  expect(t.facilitator.settled).toBe(1);
});
it("keeps an uncertain settlement locked without leaking a certificate", async () => {
  const t = await setup();
  t.facilitator.failSettlement = true;
  const result = await t.send(t.header);
  expect(result.status).not.toBe(200);
  expect(await result.json()).not.toHaveProperty("certificate");
  t.facilitator.failSettlement = false;
  expect((await t.send(t.header)).status).toBe(409);
  expect(t.facilitator.settled).toBe(1);
});
it("fails closed when response persistence fails after settlement", async () => {
  const t = await setup();
  t.storage.breakFinish();
  const result = await t.send(t.header);
  expect(result.status).toBe(503);
  expect(await result.json()).not.toHaveProperty("certificate");
  expect((await t.send(t.header)).status).toBe(409);
  expect(t.facilitator.settled).toBe(1);
});
it("rejects expired/long-lived authorizations and incorrect token before settlement", async () => {
  const t = await setup();
  const mutate = (fn: (p: typeof t.payload) => void) => {
    const p = structuredClone(t.payload);
    fn(p);
    return btoa(JSON.stringify(p));
  };
  for (const seconds of [-1, 600]) {
    const header = mutate((p) => {
      (p.payload.authorization as { validBefore: string }).validBefore = String(
        Math.floor(Date.now() / 1000) + seconds,
      );
    });
    expect((await t.send(header)).status).toBe(402);
  }
  const header = mutate((p) => {
    p.accepted.asset = NETWORKS["eip155:84532"].usdc;
  });
  expect((await t.send(header)).status).toBe(503);
  expect(t.facilitator.settled).toBe(0);
});
it("rejects a testnet transaction on the mainnet endpoint", async () => {
  const t = await setup();
  expect((await t.send(undefined, native())).status).toBe(400);
  expect(t.facilitator.settled).toBe(0);
});
