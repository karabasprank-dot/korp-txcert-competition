import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { FacilitatorClient } from "@x402/core/server";
import type { Hex } from "viem";
import { parseConfig, type Bindings, type Config } from "./config.js";
import {
  requestSchema,
  verifySchema,
  type CheckRequest,
} from "./schemas/index.js";
import { verifyCertificate } from "./core/certificate.js";
import { issueCertificate } from "./core/issue-certificate.js";
import { evaluate } from "./core/policy.js";
import {
  agentCard,
  openapi,
  llms,
  developmentChallenge,
  publicExamples,
} from "./discovery.js";
import signerSdk from "./generated/signer-sdk.json";
import reliabilitySample from "../docs/reliability-latest.json";
import { paymentGate } from "./payment.js";
type Env = {
  Bindings: Bindings;
  Variables: { config: Config; request: CheckRequest };
};
export function createApp(
  dependencies: { facilitator?: FacilitatorClient; now?: () => number } = {},
) {
  const app = new Hono<Env>();
  let cached:
    { key: string; config: Config; gate: MiddlewareHandler } | undefined;
  // Best-effort isolate-local limits: bounded memory, no durable database or raw IP logs.
  const rates = new Map<string, { start: number; count: number }>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  app.use("*", async (c, next) => {
    try {
      const key = JSON.stringify(c.env);
      if (!cached || cached.key !== key) {
        const config = parseConfig(c.env);
        cached = {
          key,
          config,
          gate: paymentGate(config, dependencies.facilitator),
        };
      }
      c.set("config", cached.config);
    } catch {
      return c.json({ error: "SERVICE_NOT_CONFIGURED" }, 503);
    }
    await next();
  });
  app.use("*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const ip = c.req.header("cf-connecting-ip") ?? "local",
      now = Date.now();
    let entry = rates.get(ip);
    if (!entry || now - entry.start >= 60000) {
      entry = { start: now, count: 0 };
      if (rates.size >= 4096) rates.delete(rates.keys().next().value!);
      rates.set(ip, entry);
    }
    if (++entry.count > 60) {
      c.header("Retry-After", "60");
      return c.json({ error: "RATE_LIMITED" }, 429);
    }
    if (
      c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    )
      return c.json({ error: "JSON_REQUIRED" }, 415);
    if ((c.req.header("PAYMENT-SIGNATURE")?.length ?? 0) > 16384)
      return c.json({ error: "PAYMENT_HEADER_TOO_LARGE" }, 431);
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 32768,
      onError: (c) => c.json({ error: "BODY_TOO_LARGE" }, 413),
    }),
  );
  const checkPaths = ["/v1/certify", "/v1/tx/check"];
  for (const path of checkPaths) {
    // Catalog crawlers probe with GET. Advertise the POST requirements only;
    // never verify/settle a supplied payment or issue a certificate on GET.
    app.get(path, (c) => {
      const challenge = developmentChallenge(c.get("config"), path);
      c.header("PAYMENT-REQUIRED", btoa(JSON.stringify(challenge)));
      return c.json(challenge, 402);
    });
    app.post(
      path,
      async (c, next) => {
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ error: "INVALID_JSON" }, 400);
        }
        const parsed = requestSchema.safeParse(body);
        if (!parsed.success)
          return c.json(
            {
              error: "INVALID_REQUEST",
              issues: parsed.error.issues.map((i) => ({
                path: i.path,
                code: i.code,
              })),
            },
            422,
          );
        if (parsed.data.chainId !== c.get("config").chainId)
          return c.json(
            {
              error: c.get("config").mainnet
                ? "NETWORK_MISMATCH"
                : "MAINNET_DISABLED",
            },
            400,
          );
        c.set("request", parsed.data);
        await next();
      },
      async (c, next) => cached!.gate(c, next),
      async (c) => {
        const r = c.get("request"),
          config = c.get("config"),
          analysis = evaluate(r);
        const certificate =
          analysis.decision === "PASS"
            ? await issueCertificate(
                r,
                config.ATTESTOR_PRIVATE_KEY as Hex,
                config.SERVICE_URL,
                dependencies.now?.(),
              )
            : null;
        return c.json({ ...analysis, certificate });
      },
    );
  }
  app.post("/v1/certificate/verify", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "INVALID_JSON" }, 400);
    }
    const parsed = verifySchema.safeParse(body);
    if (!parsed.success)
      return c.json({ error: "INVALID_VERIFICATION_REQUEST" }, 422);
    const config = c.get("config");
    if (parsed.data.request.chainId !== config.chainId)
      return c.json({ valid: false, reason: "NETWORK_MISMATCH" });
    return c.json(
      await verifyCertificate(
        parsed.data.certificate,
        parsed.data.request,
        config.attestor,
        config.SERVICE_URL,
        dependencies.now?.(),
      ),
    );
  });
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      version: "0.2.0",
      network: c.get("config").NETWORK,
      paymentMode: c.get("config").X402_MODE,
      mainnetEnabled: c.get("config").mainnet,
      readiness: "configuration-valid; facilitator checked on paid routes",
    }),
  );
  app.get("/v1/attestor", (c) =>
    c.json({
      attestor: c.get("config").attestor,
      service: c.get("config").SERVICE_URL,
      scheme: "EIP-712",
      certificateTtlSeconds: 60,
      chainId: c.get("config").chainId,
    }),
  );
  app.get("/v1/policies", (c) =>
    c.json({
      mode: "caller-supplied",
      supportedActions: [
        "native-transfer",
        "transfer",
        "transferFrom",
        "approve",
      ],
      unknownCalls:
        "BLOCK by default; WARN if explicitly allowed; never certified",
      permits: "unsupported; BLOCK",
      chainIds: [c.get("config").chainId],
      certificateTtlSeconds: 60,
    }),
  );
  app.get("/openapi.json", (c) => c.json(openapi(c.get("config"))));
  app.get("/examples.json", (c) => c.json(publicExamples(c.get("config"))));
  app.get("/reliability.json", (c) => c.json(reliabilitySample));
  app.get("/integration.md", (c) => c.text(signerSdk.guide));
  app.get("/sdk/korp-signer.mjs", (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    return c.body(signerSdk.code);
  });
  app.get("/sdk/owner-demo.mjs", (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    return c.body(signerSdk.demo);
  });
  app.get("/sdk/manifest.json", (c) =>
    c.json({
      version: 1,
      dependencies: { viem: "2.56.5", zod: "4.6.5" },
      files: {
        "korp-signer.mjs": signerSdk.sha256,
        "owner-demo.mjs": signerSdk.demoSha256,
      },
      hashAlgorithm: "sha256",
      scope:
        "Offline verification and independent signer adapter. No remote signing or custody.",
    }),
  );
  app.get("/llms.txt", (c) => c.text(llms(c.get("config"))));
  for (const path of [
    "/.well-known/agent-card.json",
    "/.well-known/agent.json",
  ])
    app.get(path, (c) => c.json(agentCard(c.get("config"))));
  app.get("/.well-known/x402", (c) =>
    c.json({
      version: 1,
      description:
        "Supplementary service manifest. Bazaar indexing depends on facilitator support and payment metadata.",
      resources: checkPaths.map((path) => c.get("config").SERVICE_URL + path),
      paymentRequirements: checkPaths.map((path) =>
        developmentChallenge(c.get("config"), path),
      ),
    }),
  );
  app.get("/", (c) =>
    c.json({
      name: "Korp TxCert",
      description: "Policy certificates for autonomous crypto transactions.",
      status: c.get("config").mainnet ? "Base mainnet" : "Base Sepolia testnet",
      price: c.get("config").mainnet
        ? "0.01 USDC per completed analysis"
        : "0.01 test USDC per completed analysis",
      workflow: [
        "Prepare transaction and policy",
        "Pay for deterministic check",
        "PASS receives certificate",
        "Wallet verifies and signs independently",
      ],
      documentation: c.get("config").SERVICE_URL + "/openapi.json",
      integration: c.get("config").SERVICE_URL + "/integration.md",
      examples: c.get("config").SERVICE_URL + "/examples.json",
      health: "/health",
    }),
  );
  app.notFound((c) => c.json({ error: "NOT_FOUND" }, 404));
  app.onError(
    () =>
      new Response(JSON.stringify({ error: "INTERNAL_ERROR" }), {
        status: 500,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      }),
  );
  return app;
}
export default createApp();

export { PaymentLedger } from "./ledger.js";
