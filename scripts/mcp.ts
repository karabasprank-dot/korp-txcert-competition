import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { requestSchema, verifySchema } from "../src/schemas/index.js";
import { buyerFetch, serviceOrigin } from "./client.js";
const origin = serviceOrigin(
  process.env.KORP_SERVICE_URL ?? "http://127.0.0.1:8787",
);
const payTo = process.env.KORP_PAY_TO;
const keyFile = process.env.KORP_TEST_PAYER_KEY_FILE;
// This bridge holds only an optional disposable testnet payer key, never the treasury or attestor key.
const paid =
  keyFile && payTo ? await buyerFetch(origin, payTo, keyFile) : undefined;
const server = new McpServer({ name: "korp-txcert", version: "0.2.0" });
server.registerTool(
  "korp_tx_certify",
  {
    description:
      "Check unsigned Base or Base Sepolia transaction policy; network and 0.01 USDC terms are returned by the service. Only PASS is certified. Built-in automatic payer supports testnet only; mainnet buyers must handle the returned x402 challenge with their own spending authorization.",
    inputSchema: requestSchema,
  },
  async (request) => {
    const res = await (paid ?? fetch)(origin + "/v1/certify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json();
    return {
      isError: res.status !== 200,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            httpStatus: res.status,
            result: body,
            paymentResponse: res.headers.get("PAYMENT-RESPONSE"),
          }),
        },
      ],
    };
  },
);
server.registerTool(
  "korp_certificate_verify",
  {
    description:
      "Free verification of certificate against service attestor and supplied transaction/policy. Wallet must independently pin the expected attestor and policy.",
    inputSchema: verifySchema,
    annotations: { readOnlyHint: true },
  },
  async (input) => {
    const res = await fetch(origin + "/v1/certificate/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    return {
      isError: res.status !== 200,
      content: [{ type: "text", text: JSON.stringify(await res.json()) }],
    };
  },
);
await server.connect(new StdioServerTransport());
