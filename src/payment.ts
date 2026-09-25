import { HonoAdapter } from "@x402/hono";
import {
  HTTPFacilitatorClient,
  x402ResourceServer,
  x402HTTPResourceServer,
  type FacilitatorClient,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import type { Context, MiddlewareHandler } from "hono";
import type { Config } from "./config.js";
import { loopback } from "./config.js";
import { routeConfig, developmentChallenge } from "./discovery.js";
import { paymentIdentity, saveResponse } from "./ledger.js";
const paths = ["/v1/certify", "/v1/tx/check"];
export function paymentGate(
  config: Config,
  facilitator?: FacilitatorClient,
): MiddlewareHandler {
  const server = new x402ResourceServer(
    facilitator ??
      new HTTPFacilitatorClient({
        url: config.X402_FACILITATOR_URL,
        timeoutMs: 10000,
      }),
  )
    .register(config.NETWORK, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  const http = new x402HTTPResourceServer(
    server,
    Object.fromEntries(paths.map((p) => ["POST " + p, routeConfig(config, p)])),
  );
  let initialized: Promise<void> | undefined;
  return async (c, next) => {
    if (config.X402_MODE === "development") {
      if (!loopback(new URL(c.req.url)) || c.req.header("cf-ray"))
        return c.json({ error: "LOCAL_SIMULATION_ONLY" }, 403);
      c.header("X-Korp-Payment-Mode", "development-simulation");
      if (
        c.req.header("X-Korp-Development-Payment") !==
        config.DEVELOPMENT_PAYMENT_TOKEN
      ) {
        const challenge = developmentChallenge(config, c.req.path);
        c.header("PAYMENT-REQUIRED", btoa(JSON.stringify(challenge)));
        return c.json(challenge, 402);
      }
      await next();
      if (c.res.status < 400)
        c.header(
          "PAYMENT-RESPONSE",
          btoa(
            JSON.stringify({
              success: true,
              simulated: true,
              network: config.NETWORK,
              transaction: "",
            }),
          ),
        );
      return;
    }
    let journal: { stub: DurableObjectStub; fingerprint: string } | undefined;
    const header = c.req.header("PAYMENT-SIGNATURE");
    if (header && c.env.PAYMENT_LEDGER) {
      try {
        const identity = paymentIdentity(header, c.get("request"), config);
        const ns = c.env.PAYMENT_LEDGER as DurableObjectNamespace;
        const stub = ns.get(ns.idFromName(identity.id));
        journal = { stub, fingerprint: identity.fingerprint };
        const previous = await stub.fetch("https://ledger/peek", {
          method: "POST",
          body: JSON.stringify({ fingerprint: identity.fingerprint }),
        });
        if (previous.status !== 204) return previous;
        const now = Math.floor(Date.now() / 1000);
        if (identity.validBefore <= now || identity.validBefore > now + 120)
          return c.json({ error: "INVALID_PAYMENT_WINDOW" }, 402);
      } catch {
        return c.json({ error: "PAYMENT_OR_LEDGER_UNAVAILABLE" }, 503);
      }
    }
    // Initialization is lazy (inside a request), retryable, and shared per isolate.
    try {
      initialized ??= http.initialize().catch((e) => {
        initialized = undefined;
        throw e;
      });
      await initialized;
    } catch {
      return c.json({ error: "FACILITATOR_UNAVAILABLE" }, 503);
    }
    const context = {
      adapter: new HonoAdapter(c),
      path: c.req.path,
      method: c.req.method,
      paymentHeader: c.req.header("PAYMENT-SIGNATURE"),
    };
    try {
      const result = await http.processHTTPRequest(context);
      if (result.type === "payment-error")
        return paymentError(c, result.response);
      if (result.type !== "payment-verified")
        return c.json({ error: "PAYMENT_GATE_MISMATCH" }, 503);
      if (journal) {
        const claim = await journal.stub.fetch("https://ledger/claim", {
          method: "POST",
          body: JSON.stringify({ fingerprint: journal.fingerprint }),
        });
        if (claim.status !== 201) {
          await result.cancellationDispatcher.cancel({
            reason: "after_verify_aborted",
          });
          return claim;
        }
      }
      try {
        await next();
      } catch {
        await result.cancellationDispatcher.cancel({ reason: "handler_threw" });
        return c.json({ error: "ANALYSIS_FAILED" }, 500);
      }
      if (c.res.status >= 400) {
        await result.cancellationDispatcher.cancel({
          reason: "handler_failed",
          responseStatus: c.res.status,
        });
        return;
      }
      // Buffer certificate until settlement succeeds. Never release on failure.
      const original = c.res;
      const bytes = new Uint8Array(await original.arrayBuffer());
      c.res = new Response(null, { status: 503 });
      const settled = await http.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        {
          request: context,
          responseBody: bytes,
          responseHeaders: Object.fromEntries(original.headers),
        },
        undefined,
        result.beforeHandlerSettlement,
      );
      if (!settled.success) {
        c.res = paymentError(c, settled.response);
        // Keep an indeterminate claim locked. Never replay settlement speculatively.
        return;
      }
      c.res = new Response(bytes, {
        status: original.status,
        headers: original.headers,
      });
      for (const [k, v] of Object.entries(settled.headers)) c.header(k, v);
      if (journal) await saveResponse(journal.stub, journal.fingerprint, c.res);
    } catch {
      c.res = c.json(
        {
          error: "PAYMENT_PROCESSING_UNAVAILABLE",
          retry:
            "Settlement may be indeterminate; check the payment nonce before paying again.",
        },
        503,
      );
      return;
    }
  };
}
function paymentError(
  c: Context,
  response: { status: number; headers: Record<string, string>; body?: unknown },
) {
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  const encoded = headers.get("PAYMENT-REQUIRED");
  let body: unknown = { error: "PAYMENT_REQUIRED_OR_REJECTED" };
  if (encoded) {
    try {
      body = JSON.parse(atob(encoded));
    } catch {
      /* fail closed with generic JSON */
    }
  }
  return new Response(JSON.stringify(body), {
    status: response.status,
    headers,
  });
}
