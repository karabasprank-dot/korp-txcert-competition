import { z } from "zod";
import { encodeFunctionData, erc20Abi, maxUint256, type Address } from "viem";
import { evaluate } from "./core/policy.js";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { RouteConfig } from "@x402/core/server";
import type { Config } from "./config.js";
import { NETWORKS } from "./config.js";
import {
  requestSchema,
  responseSchema,
  verifySchema,
} from "./schemas/index.js";
export const description =
  "Check an unsigned EVM transaction before an AI agent signs it. Enforces spending limits, recipient restrictions, ERC20 approval rules, unlimited approval protection, and calldata policy. Only PASS receives a short-lived policy certificate. This is policy conformity, not simulation or a safety guarantee.";
export const example = {
  chainId: 84532,
  from: "0x2222222222222222222222222222222222222222",
  transaction: {
    to: "0x3333333333333333333333333333333333333333",
    data: "0x",
    value: "1000",
    nonce: "0",
  },
  policy: {
    expectedAction: "native-transfer",
    allowedRecipients: ["0x3333333333333333333333333333333333333333"],
    allowedSpenders: [],
    maxNativeValueWei: "1000",
    maxTokenSpend: [],
    allowUnlimitedApproval: false,
    allowUnknownCalls: false,
  },
};
export const inputSchema = z.toJSONSchema(
    requestSchema.extend({ chainId: z.literal(84532) }),
  ),
  outputSchema = z.toJSONSchema(responseSchema),
  verificationSchema = z.toJSONSchema(verifySchema);
export const exampleFor = (c: Config) => ({ ...example, chainId: c.chainId });
export function publicExamples(c: Config) {
  const allowed = requestSchema.parse(exampleFor(c));
  const excessive = structuredClone(allowed);
  excessive.transaction.value = "1001";
  const unlimited = structuredClone(allowed);
  unlimited.transaction = {
    to: NETWORKS[c.NETWORK].usdc,
    value: "0",
    nonce: "0",
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [example.transaction.to as Address, maxUint256],
    }),
  };
  unlimited.policy.expectedAction = "approve";
  unlimited.policy.allowedSpenders = [example.transaction.to];
  unlimited.policy.maxTokenSpend = [
    { token: NETWORKS[c.NETWORK].usdc, amount: "1000000" },
  ];
  return {
    network: c.NETWORK,
    note: "Fixed synthetic examples, evaluated locally. No certificates issued, payments made or transactions broadcast. POST analyses use the published payment terms.",
    cases: [
      { name: "allowed-native-transfer", request: allowed },
      { name: "excessive-native-value", request: excessive },
      { name: "unlimited-token-approval", request: unlimited },
    ].map((item) => ({ ...item, expected: evaluate(item.request) })),
  };
}
const schemaFor = (c: Config) =>
  z.toJSONSchema(requestSchema.extend({ chainId: z.literal(c.chainId) }));
export function routeConfig(c: Config, path: string): RouteConfig {
  return {
    accepts: [
      {
        scheme: "exact",
        network: c.NETWORK,
        payTo: c.PAY_TO_ADDRESS,
        price: {
          amount: "10000",
          asset: NETWORKS[c.NETWORK].usdc,
          extra: { name: "USDC", version: "2" },
        },
        maxTimeoutSeconds: 60,
      },
    ],
    resource: c.SERVICE_URL + path,
    description,
    mimeType: "application/json",
    serviceName: "Korp TxCert",
    tags: ["security", "wallet-policy", "evm", "pre-sign", "approval-guard"],
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: exampleFor(c),
      inputSchema: schemaFor(c),
      output: {
        example: {
          ...evaluate(
            requestSchema.parse({
              ...exampleFor(c),
              transaction: { ...example.transaction, value: "1001" },
            }),
          ),
          certificate: null,
        },
        schema: outputSchema,
      },
    }),
  };
}
export function developmentChallenge(c: Config, path: string) {
  const route = routeConfig(c, path);
  const extensions = structuredClone(route.extensions!);
  const bazaar = extensions.bazaar as {
    info: { input: { method: string } };
    schema: {
      properties: { input: { properties: { method: { enum: string[] } } } };
    };
  };
  bazaar.info.input.method = "POST";
  bazaar.schema.properties.input.properties.method.enum = ["POST"];
  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: c.SERVICE_URL + path,
      description,
      mimeType: "application/json",
      serviceName: route.serviceName,
      tags: route.tags,
    },
    accepts: [
      {
        scheme: "exact",
        network: c.NETWORK,
        amount: "10000",
        asset: NETWORKS[c.NETWORK].usdc,
        payTo: c.PAY_TO_ADDRESS,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
    extensions,
  };
}
const jsonResponse = (schema: unknown, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
export function openapi(c: Config) {
  const paid = {
    "x-payment-info": {
      protocols: ["x402"],
      price: { mode: "fixed", currency: "USD", amount: "0.01" },
    },
    summary: "Check transaction policy; only PASS is certified",
    description:
      "A completed PASS, WARN or BLOCK analysis costs 10000 atomic USDC. Invalid input is rejected before payment. x402 v2 uses PAYMENT-REQUIRED, PAYMENT-SIGNATURE and PAYMENT-RESPONSE headers.",
    requestBody: {
      required: true,
      content: {
        "application/json": { schema: schemaFor(c), example: exampleFor(c) },
      },
    },
    parameters: [
      {
        in: "header",
        name: "PAYMENT-SIGNATURE",
        required: false,
        schema: { type: "string" },
        description: "Base64 x402 v2 payment payload",
      },
    ],
    responses: {
      "200": jsonResponse(outputSchema, "Settled analysis"),
      "400": { description: "Invalid JSON or unsupported chain" },
      "409": {
        description:
          "Payment already bound, in progress or indeterminate; do not create a new authorization blindly",
      },
      "413": { description: "Body exceeds 32 KiB" },
      "415": { description: "JSON required" },
      "422": { description: "Schema invalid" },
      "429": { description: "Request rate exceeded" },
      "402": {
        description:
          "Payment required or rejected; base64 requirements in PAYMENT-REQUIRED",
      },
      "503": {
        description: "Invalid configuration or facilitator unavailable",
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Korp TxCert",
      version: "0.2.0",
      description,
      contact: { name: "Korp", email: "support@korpvpn.com" },
    },
    servers: [{ url: c.SERVICE_URL }],
    paths: {
      "/reliability.json": {
        get: {
          security: [],
          summary:
            "Timestamped unpaid latency samples, not an uptime guarantee",
          responses: {
            "200": { description: "Measurement method, raw samples and scope" },
          },
        },
      },
      "/examples.json": {
        get: {
          security: [],
          summary: "Free fixed policy examples and expected results",
          responses: {
            "200": {
              description: "Three synthetic cases; no payments or certificates",
            },
          },
        },
      },
      "/integration.md": {
        get: {
          security: [],
          summary: "Owner-approved policy and signer integration guide",
          responses: { "200": { description: "Markdown guide" } },
        },
      },
      "/v1/tx/check": { post: { ...paid, operationId: "korp_tx_check" } },
      "/v1/certify": { post: { ...paid, operationId: "korp_tx_certify" } },
      "/v1/certificate/verify": {
        post: {
          security: [],
          operationId: "korp_certificate_verify",
          summary:
            "Free certificate verification against pinned service attestor",
          requestBody: {
            required: true,
            content: { "application/json": { schema: verificationSchema } },
          },
          responses: {
            "200": jsonResponse(
              {
                type: "object",
                properties: {
                  valid: { type: "boolean" },
                  reason: { type: "string" },
                },
                required: ["valid", "reason"],
              },
              "Verification result",
            ),
            "422": { description: "Schema invalid" },
          },
        },
      },
      "/health": {
        get: {
          security: [],
          responses: { "200": { description: "Network health and mode" } },
        },
      },
      "/v1/attestor": {
        get: {
          security: [],
          responses: {
            "200": { description: "Public attestor and certificate domain" },
          },
        },
      },
    },
  };
}
export function agentCard(c: Config) {
  // A descriptive HTTP service card. Deliberately does not claim A2A protocol compliance.
  return {
    name: "Korp TxCert",
    version: "0.2.0",
    description,
    url: c.SERVICE_URL,
    protocol: "HTTP+JSON+x402-v2",
    network: c.NETWORK,
    mainnetEnabled: c.mainnet,
    openapi: c.SERVICE_URL + "/openapi.json",
    skills: [
      {
        id: "korp_tx_certify",
        name: "Pre-sign transaction policy check",
        description,
        tags: ["transaction security", "wallet policy", "approval guard"],
      },
    ],
    capabilities: {
      policyCertificates: true,
      ownerPolicyAdapter: "offline-signer-enforcement",
      freeVerification: true,
      a2a: false,
      mcp: "local-stdio-bridge",
    },
    endpoints: {
      integration: c.SERVICE_URL + "/integration.md",
      examples: c.SERVICE_URL + "/examples.json",
      signerSdk: c.SERVICE_URL + "/sdk/korp-signer.mjs",
      certify: c.SERVICE_URL + "/v1/certify",
      verify: c.SERVICE_URL + "/v1/certificate/verify",
    },
    price: {
      amount: "10000",
      asset: NETWORKS[c.NETWORK].usdc,
      network: c.NETWORK,
    },
    attestor: c.attestor,
  };
}
export function llms(c: Config) {
  return `# Korp TxCert\n\n${description}\n\n- Network: ${c.mainnet ? "Base mainnet (eip155:8453), real USDC." : "Base Sepolia (eip155:84532), test USDC only."}\n- POST ${c.SERVICE_URL}/v1/certify (alias /v1/tx/check): 0.01 ${c.mainnet ? "USDC" : "test USDC"} per completed analysis, including WARN/BLOCK.\n- POST ${c.SERVICE_URL}/v1/certificate/verify: free. Submit {certificate, request}.\n- [Owner policy and signer integration](${c.SERVICE_URL}/integration.md)\n- [Free reproducible examples](${c.SERVICE_URL}/examples.json)\n- [Offline signer SDK](${c.SERVICE_URL}/sdk/korp-signer.mjs)\n- [OpenAPI](${c.SERVICE_URL}/openapi.json)\n- [Attestor](${c.SERVICE_URL}/v1/attestor)\n- [Agent card](${c.SERVICE_URL}/.well-known/agent-card.json)\n\nAmounts are integer strings. Allowlist recipients, spenders and token limits explicitly. Unsupported permits and unknown calls never receive certificates. Trust and pin the policy and attestor yourself. Certificates expire after 60 seconds and do not authorize spending. MCP tools are available through the repository's local stdio bridge. No A2A message endpoint is implemented.\n`;
}
