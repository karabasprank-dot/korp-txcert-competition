import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { buyerFetch } from "../scripts/client.js";
import { parseConfig } from "../src/config.js";
import { developmentChallenge } from "../src/discovery.js";
import { env, native } from "./fixtures.js";

it("captures exactly the SDK's transmitted payment authorization, without observing unpaid requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "korp-buyer-test-"));
  const keyFile = join(directory, "payer.key");
  await writeFile(keyFile, generatePrivateKey(), { mode: 0o600 });
  const transmitted: string[] = [],
    observed: string[] = [];
  const challenge = developmentChallenge(parseConfig(env), "/v1/certify");
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const signature = headers.get("PAYMENT-SIGNATURE");
      if (signature) {
        transmitted.push(signature);
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify(challenge), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": btoa(JSON.stringify(challenge)),
        },
      });
    },
  );
  try {
    const paid = await buyerFetch(
      env.SERVICE_URL,
      env.PAY_TO_ADDRESS,
      keyFile,
      (signature) => observed.push(signature),
    );
    const response = await paid(env.SERVICE_URL + "/v1/certify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(native()),
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(observed.length).toBe(1);
    expect(transmitted.length).toBe(1);
    // Boolean comparison keeps authorizations out of assertion failure output.
    expect(observed[0] === transmitted[0]).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});
