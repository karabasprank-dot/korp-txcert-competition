import { describe, it, expect } from "vitest";
import { createLiveTestnet } from "../src/live-testnet.js";
import sample from "../examples/request.json";
const rpc = (chain = "0x14a34") =>
  (async () =>
    Response.json(
      [chain, "0x1", "0x0", "0x0"].map((result, i) => ({ id: i + 1, result })),
    )) as typeof fetch;
describe("live testnet isolation", () => {
  it("reads fresh state without signing", async () => {
    const r = await createLiveTestnet(rpc()).request("/api/check", {
      method: "POST",
      body: JSON.stringify(sample),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      chain: { chainId: 84532 },
      certificate: null,
      broadcast: false,
    });
  });
  it("rejects mainnet before RPC", async () => {
    let called = false;
    const app = createLiveTestnet((async () => {
      called = true;
      throw Error();
    }) as typeof fetch);
    const r = await app.request("/api/check", {
      method: "POST",
      body: JSON.stringify({ ...sample, chainId: 8453 }),
    });
    expect(r.status).toBe(400);
    expect(called).toBe(false);
  });
  it("fails closed when RPC is on wrong chain", async () => {
    const r = await createLiveTestnet(rpc("0x2105")).request("/api/check", {
      method: "POST",
      body: JSON.stringify(sample),
    });
    expect(r.status).toBe(503);
  });
  it("evaluates overspending dynamically", async () => {
    const r = await createLiveTestnet(rpc()).request("/api/check", {
      method: "POST",
      body: JSON.stringify({
        ...sample,
        transaction: { ...sample.transaction, value: "1001" },
      }),
    });
    expect(await r.json()).toMatchObject({ evaluation: { decision: "BLOCK" } });
  });
});

it.each([84532, 11155111, 421614, 11155420])(
  "pins network %i to its RPC response",
  async (chainId) => {
    const app = createLiveTestnet(rpc("0x" + chainId.toString(16)));
    const r = await app.request("/api/check", {
      method: "POST",
      body: JSON.stringify({ ...sample, chainId }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      chain: { chainId },
      evaluation: { chainId },
    });
  },
);

it("blocks overspend during a provider outage without calling RPC", async () => {
  let calls = 0;
  const app = createLiveTestnet((async () => {
    calls++;
    throw Error("offline");
  }) as typeof fetch);
  const r = await app.request("/api/check", {
    method: "POST",
    body: JSON.stringify({
      ...sample,
      transaction: { ...sample.transaction, value: "1001" },
    }),
  });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({
    evaluation: { decision: "BLOCK" },
    chain: null,
    networkState: "not-requested",
  });
  expect(calls).toBe(0);
});
it("retries throttling once and recovers", async () => {
  let calls = 0;
  const app = createLiveTestnet((async () =>
    ++calls === 1
      ? new Response("", { status: 429 })
      : rpc()("https://unused.invalid")) as typeof fetch);
  const r = await app.request("/api/check", {
    method: "POST",
    body: JSON.stringify(sample),
  });
  expect(r.status).toBe(200);
  expect(calls).toBe(2);
});
it("bounds retries and never reports unavailable chain state as verified", async () => {
  let calls = 0;
  const app = createLiveTestnet((async () => {
    calls++;
    throw Error("offline");
  }) as typeof fetch);
  const r = await app.request("/api/check", {
    method: "POST",
    body: JSON.stringify(sample),
  });
  expect(r.status).toBe(503);
  expect(calls).toBe(2);
  expect(await r.json()).toMatchObject({
    networkState: "unavailable",
    chain: null,
    certificate: null,
    broadcast: false,
  });
});
it.each([
  [
    { id: 1, result: "0x14a34" },
    { id: 1, result: "0x1" },
    { id: 3, result: "0x0" },
    { id: 4, result: "0x0" },
  ],
  [
    { id: 1, result: "0x14a34" },
    { id: 2, result: "0x01" },
    { id: 3, result: "0x0" },
    { id: 4, result: "0x0" },
  ],
  [
    { id: 1, result: "0x14a34" },
    { id: 2, result: "0x1" },
    { id: 3, result: "0x0", error: { code: -1 } },
    { id: 4, result: "0x0" },
  ],
])("rejects malformed RPC responses without retry", async (...rows) => {
  let calls = 0;
  const app = createLiveTestnet((async () => {
    calls++;
    return Response.json(rows);
  }) as typeof fetch);
  const r = await app.request("/api/check", {
    method: "POST",
    body: JSON.stringify(sample),
  });
  expect(r.status).toBe(503);
  expect(calls).toBe(1);
});
it("rejects extra fields and non-native payloads before any RPC", async () => {
  let calls = 0;
  const app = createLiveTestnet((async () => {
    calls++;
    throw Error();
  }) as typeof fetch);
  for (const input of [
    { ...sample, privateKey: "not-accepted" },
    { ...sample, transaction: { ...sample.transaction, data: "0x1234" } },
  ]) {
    const r = await app.request("/api/check", {
      method: "POST",
      body: JSON.stringify(input),
    });
    expect(r.status).toBe(400);
  }
  expect(calls).toBe(0);
});
