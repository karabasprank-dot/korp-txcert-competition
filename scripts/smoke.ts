import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import { address } from "../src/schemas/index.js";
import { example } from "../src/discovery.js";
import { NETWORKS } from "../src/config.js";
import { serviceOrigin } from "./client.js";
import signerSdk from "../src/generated/signer-sdk.json";
import { evaluate } from "../src/core/policy.js";
import { requestSchema } from "../src/schemas/index.js";
export async function smoke(
  origin: string,
  payTo: string,
  attestor: string,
  network: keyof typeof NETWORKS = "eip155:84532",
) {
  address.parse(payTo);
  address.parse(attestor);
  const get = (path: string, init?: RequestInit) =>
    fetch(origin + path, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  for (const path of [
    "/",
    "/health",
    "/openapi.json",
    "/llms.txt",
    "/v1/policies",
    "/.well-known/agent-card.json",
    "/.well-known/agent.json",
    "/.well-known/x402",
    "/examples.json",
    "/integration.md",
    "/sdk/manifest.json",
  ])
    assert.equal((await get(path)).status, 200, path);
  const health = (await (await get("/health")).json()) as {
    network: string;
    mainnetEnabled: boolean;
    paymentMode: string;
  };
  assert.equal(health.network, network);
  assert.equal(health.mainnetEnabled, network === "eip155:8453");
  const signer = (await (await get("/v1/attestor")).json()) as {
    attestor: string;
    service: string;
  };
  assert.equal(signer.attestor.toLowerCase(), attestor.toLowerCase());
  assert.equal(signer.service, origin);
  assert.equal(
    await (await get("/sdk/korp-signer.mjs")).text(),
    signerSdk.code,
    "Published SDK matches reviewed build",
  );
  assert.equal(
    await (await get("/sdk/owner-demo.mjs")).text(),
    signerSdk.demo,
    "Published demo matches tested source",
  );
  const examples = (await (await get("/examples.json")).json()) as {
    cases: { request: unknown; expected: unknown }[];
  };
  assert.equal(examples.cases.length, 3);
  for (const item of examples.cases) {
    const request = requestSchema.parse(item.request);
    assert.equal(request.chainId, NETWORKS[network].chainId);
    assert.deepEqual(
      evaluate(request),
      item.expected,
      "Public example reproduces locally",
    );
  }
  for (const path of ["/v1/certify", "/v1/tx/check"]) {
    const res = await get(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...example, chainId: NETWORKS[network].chainId }),
    });
    assert.equal(res.status, 402);
    const body = (await res.json()) as {
      x402Version: number;
      resource: { url: string; serviceName: string; tags: string[] };
      accepts: {
        scheme: string;
        network: string;
        amount: string;
        asset: string;
        payTo: string;
      }[];
      extensions: { bazaar: { info: unknown; schema: object } };
    };
    assert.deepEqual(
      body,
      JSON.parse(atob(res.headers.get("PAYMENT-REQUIRED")!)),
    );
    assert.equal(body.x402Version, 2);
    assert.equal(body.resource.url, origin + path);
    assert.equal(body.resource.serviceName, "Korp TxCert");
    assert(body.resource.tags.length > 0);
    const offer = body.accepts[0]!;
    assert.equal(offer.scheme, "exact");
    assert.equal(offer.network, network);
    assert.equal(offer.amount, "10000");
    assert.equal(
      offer.asset.toLowerCase(),
      NETWORKS[network].usdc.toLowerCase(),
    );
    assert.equal(offer.payTo.toLowerCase(), payTo.toLowerCase());
    const probe = await get(path);
    assert.equal(probe.status, 402, "Catalog GET probe");
    assert.deepEqual(
      await probe.json(),
      body,
      "GET and POST requirements agree",
    );
    const ajv = new Ajv({ strict: false, validateFormats: false });
    assert(
      ajv.compile(body.extensions.bazaar.schema)(body.extensions.bazaar.info),
    );
  }
  const invalidVerify = await get("/v1/certificate/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(invalidVerify.status, 422);
  return {
    status: "PASS",
    network: health.network,
    mode: health.paymentMode,
    scope:
      "Discovery and unpaid requirements only; no settlement or marketplace listing proven",
  };
}
if (process.argv[1]?.endsWith("smoke.ts")) {
  const [url, payTo, attestor, network = "eip155:84532"] =
    process.argv.slice(2);
  if (network !== "eip155:84532" && network !== "eip155:8453")
    throw new Error("Unsupported network");
  if (!url || !payTo || !attestor)
    throw new Error(
      "Usage: npm run smoke -- SERVICE_URL EXPECTED_PAY_TO EXPECTED_ATTESTOR",
    );
  console.log(
    JSON.stringify(
      await smoke(serviceOrigin(url), payTo, attestor, network),
      null,
      2,
    ),
  );
}
