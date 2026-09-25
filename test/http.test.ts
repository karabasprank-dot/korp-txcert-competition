import { describe, it, expect, vi } from "vitest";
import type { PaymentRequired } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import Ajv from "ajv/dist/2020.js";
import { createApp } from "../src/index.js";
import { env, localEnv, native, erc20 } from "./fixtures.js";
import { responseSchema } from "../src/schemas/index.js";
import { NETWORKS } from "../src/config.js";
import { openapi } from "../src/discovery.js";
const payer = privateKeyToAccount(generatePrivateKey());
import { TestFacilitator } from "./facilitator.js";
function setup(f = new TestFacilitator()) {
  const app = createApp({ facilitator: f });
  const localFetch: typeof fetch = async (input, init) =>
    app.fetch(new Request(input, init), env);
  const paid = wrapFetchWithPayment(
    localFetch,
    new x402Client().register("eip155:84532", new ExactEvmScheme(payer)),
  );
  return { app, f, localFetch, paid };
}
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
describe("HTTP x402 SDK integration (facilitator boundary simulated)", () => {
  it.each(["/v1/certify", "/v1/tx/check"])(
    "advertises POST requirements on GET %s without processing payment",
    async (path) => {
      const { localFetch, f } = setup();
      const res = await localFetch(env.SERVICE_URL + path, {
        headers: { "PAYMENT-SIGNATURE": "must-not-be-processed" },
      });
      expect(res.status).toBe(402);
      const challenge = await res.json();
      expect(JSON.parse(atob(res.headers.get("PAYMENT-REQUIRED")!))).toEqual(
        challenge,
      );
      expect(challenge).toMatchObject({
        extensions: { bazaar: { info: { input: { method: "POST" } } } },
      });
      const postChallenge = await localFetch(
        env.SERVICE_URL + path,
        post(native()),
      );
      expect(challenge).toEqual(await postChallenge.json());
      expect(f.verified).toBe(0);
      expect(f.settled).toBe(0);
      expect(challenge).not.toHaveProperty("certificate");
    },
  );
  it("provides discoverable paid routes and excludes free operations", async () => {
    const { localFetch } = setup();
    const manifest = (await (
      await localFetch(env.SERVICE_URL + "/.well-known/x402")
    ).json()) as { version: number; resources: string[] };
    expect(manifest.version).toBe(1);
    expect(manifest.resources).toEqual(
      ["/v1/certify", "/v1/tx/check"].map((p) => env.SERVICE_URL + p),
    );
    const api = (await (
      await localFetch(env.SERVICE_URL + "/openapi.json")
    ).json()) as ReturnType<typeof openapi>;
    for (const path of ["/v1/certify", "/v1/tx/check"] as const) {
      expect(api.paths[path].post["x-payment-info"]).toEqual({
        protocols: ["x402"],
        price: { mode: "fixed", currency: "USD", amount: "0.01" },
      });
      expect(api.paths[path].post.responses[402]).toBeDefined();
    }
    expect(api.paths["/v1/certificate/verify"].post.security).toEqual([]);
    expect(api.paths["/health"].get.security).toEqual([]);
    expect(api.paths["/v1/attestor"].get.security).toEqual([]);
  });
  it.each(["/v1/certify", "/v1/tx/check"])(
    "returns correct v2 challenge for %s",
    async (path) => {
      const { localFetch } = setup(),
        res = await localFetch(env.SERVICE_URL + path, post(native()));
      expect(res.status).toBe(402);
      const body = (await res.json()) as PaymentRequired;
      expect(JSON.parse(atob(res.headers.get("PAYMENT-REQUIRED")!))).toEqual(
        body,
      );
      expect(body.x402Version).toBe(2);
      expect(body.resource.url).toBe(env.SERVICE_URL + path);
      expect(body.accepts[0]).toMatchObject({
        scheme: "exact",
        network: "eip155:84532",
        amount: "10000",
        asset: NETWORKS["eip155:84532"].usdc,
        payTo: env.PAY_TO_ADDRESS,
      });
      expect(body.extensions?.bazaar).toBeDefined();
      expect(body.resource.serviceName).toBe("Korp TxCert");
      const bazaar = body.extensions!.bazaar as {
        info: unknown;
        schema: object;
      };
      const ajv = new Ajv({ strict: false, validateFormats: false });
      expect(ajv.compile(bazaar.schema)(bazaar.info)).toBe(true);
    },
  );
  it("real SDK buyer signs test payment and receives verifiable certificate", async () => {
    const { paid, localFetch, f } = setup(),
      request = native();
    const res = await paid(env.SERVICE_URL + "/v1/certify", post(request));
    expect(res.status).toBe(200);
    expect(f.verified).toBe(1);
    expect(f.settled).toBe(1);
    const body = responseSchema.parse(await res.json());
    expect(body.decision).toBe("PASS");
    expect(body.certificate).not.toBeNull();
    const payment = JSON.parse(atob(res.headers.get("PAYMENT-RESPONSE")!));
    expect(payment.success).toBe(true);
    const verification = await localFetch(
      env.SERVICE_URL + "/v1/certificate/verify",
      post({ request, certificate: body.certificate }),
    );
    expect(await verification.json()).toEqual({
      valid: true,
      reason: "VERIFIED",
    });
  });
  it("charges completed BLOCK analysis but returns no certificate", async () => {
    const { paid, f } = setup();
    const r = erc20("approve", 101n);
    const res = await paid(env.SERVICE_URL + "/v1/certify", post(r));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      decision: "BLOCK",
      certificate: null,
    });
    expect(f.settled).toBe(1);
  });
  it("returns WARN without certificate", async () => {
    const { paid } = setup();
    const r = native();
    r.transaction.data = "0x12345678";
    r.policy.expectedAction = "unknown";
    r.policy.allowUnknownCalls = true;
    const res = await paid(env.SERVICE_URL + "/v1/certify", post(r));
    expect(await res.json()).toMatchObject({
      decision: "WARN",
      certificate: null,
    });
  });
  it("rejects bad signature without settling", async () => {
    const { paid, f } = setup();
    f.reject = true;
    const res = await paid(env.SERVICE_URL + "/v1/certify", post(native()));
    expect(res.status).toBe(402);
    expect(f.settled).toBe(0);
    expect(await res.json()).not.toHaveProperty("certificate");
  });
  it("never releases certificate if settlement fails", async () => {
    const { paid, f } = setup();
    f.failSettlement = true;
    const res = await paid(env.SERVICE_URL + "/v1/certify", post(native()));
    expect(res.status).not.toBe(200);
    expect(await res.json()).not.toHaveProperty("certificate");
  });
  it("rejects reused authorization at settlement", async () => {
    const { localFetch } = setup();
    const challenge = await localFetch(
      env.SERVICE_URL + "/v1/certify",
      post(native()),
    );
    const required = (await challenge.json()) as PaymentRequired;
    const client = new x402Client().register(
      "eip155:84532",
      new ExactEvmScheme(payer),
    );
    const payload = await client.createPaymentPayload(required);
    const init = post(native());
    init.headers = {
      ...init.headers,
      "PAYMENT-SIGNATURE": btoa(JSON.stringify(payload)),
    } as typeof init.headers;
    expect(
      (await localFetch(env.SERVICE_URL + "/v1/certify", init)).status,
    ).toBe(200);
    expect(
      (await localFetch(env.SERVICE_URL + "/v1/certify", init)).status,
    ).not.toBe(200);
  });
  it("unavailable facilitator fails closed and can recover", async () => {
    const { localFetch, f } = setup();
    f.unavailable = true;
    expect(
      (await localFetch(env.SERVICE_URL + "/v1/certify", post(native())))
        .status,
    ).toBe(503);
    f.unavailable = false;
    expect(
      (await localFetch(env.SERVICE_URL + "/v1/certify", post(native())))
        .status,
    ).toBe(402);
  });
  it("rejects malformed input before facilitator contact", async () => {
    const { localFetch, f } = setup();
    const res = await localFetch(env.SERVICE_URL + "/v1/certify", post({}));
    expect(res.status).toBe(422);
    expect(f.verified).toBe(0);
    expect(f.settled).toBe(0);
  });
  it("rejects malformed payment header", async () => {
    const { localFetch, f } = setup();
    const init = post(native());
    const res = await localFetch(env.SERVICE_URL + "/v1/certify", {
      ...init,
      headers: { ...init.headers, "PAYMENT-SIGNATURE": "bad" },
    });
    expect(res.status).not.toBe(200);
    expect(f.settled).toBe(0);
  });
  it("blocks mainnet request", async () => {
    const { localFetch } = setup();
    expect(
      (
        await localFetch(
          env.SERVICE_URL + "/v1/certify",
          post({ ...native(), chainId: 8453 }),
        )
      ).status,
    ).toBe(400);
  });
  for (const path of [
    "/",
    "/health",
    "/v1/attestor",
    "/v1/policies",
    "/openapi.json",
    "/llms.txt",
    "/.well-known/agent-card.json",
    "/.well-known/agent.json",
    "/.well-known/x402",
    "/examples.json",
    "/integration.md",
    "/sdk/korp-signer.mjs",
    "/sdk/owner-demo.mjs",
    "/sdk/manifest.json",
  ])
    it(`${path} is free`, async () => {
      const { localFetch, f } = setup();
      expect((await localFetch(env.SERVICE_URL + path)).status).toBe(200);
      expect(f.verified).toBe(0);
    });
  it("rejects oversized streamed bodies without content length", async () => {
    const { localFetch } = setup();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(33000)));
        controller.close();
      },
    });
    const res = await localFetch(env.SERVICE_URL + "/v1/certify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });
  it("requires JSON content type", async () => {
    const { localFetch } = setup();
    expect(
      (
        await localFetch(env.SERVICE_URL + "/v1/certify", {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(415);
  });
  it("does not log request bodies or secrets", async () => {
    const spy = vi.spyOn(console, "error");
    const { localFetch } = setup();
    await localFetch(
      env.SERVICE_URL + "/v1/certify",
      post({ seedPhrase: "must not log" }),
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("rate limits repeated malformed requests", async () => {
    const { localFetch } = setup();
    let last: Response | undefined;
    for (let i = 0; i < 61; i++)
      last = await localFetch(env.SERVICE_URL + "/v1/certify", post({}));
    expect(last!.status).toBe(429);
  });
});
describe("local simulation isolation", () => {
  it("marks simulation explicitly", async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request(localEnv.SERVICE_URL + "/v1/certify", {
        ...post(native()),
        headers: {
          "content-type": "application/json",
          "X-Korp-Development-Payment": localEnv.DEVELOPMENT_PAYMENT_TOKEN,
        },
      }),
      localEnv,
    );
    expect(res.status).toBe(200);
    expect(
      JSON.parse(atob(res.headers.get("PAYMENT-RESPONSE")!)).simulated,
    ).toBe(true);
  });
  it("blocks local simulation exposed at public origin", async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request("https://remote.test/v1/certify", post(native())),
      localEnv,
    );
    expect(res.status).toBe(403);
  });
  it("blocks simulation forwarded through Cloudflare", async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request(localEnv.SERVICE_URL + "/v1/certify", {
        ...post(native()),
        headers: { "content-type": "application/json", "cf-ray": "test" },
      }),
      localEnv,
    );
    expect(res.status).toBe(403);
  });
});
