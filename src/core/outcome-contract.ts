import { z } from "zod";
import { keccak256, toHex } from "viem";

const path = z
  .array(
    z
      .string()
      .min(1)
      .max(80)
      .refine((s) => !["__proto__", "prototype", "constructor"].includes(s)),
  )
  .max(8);
const rule = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("equals"),
    path,
    value: z.union([
      z.string().max(512),
      z.number().finite(),
      z.boolean(),
      z.null(),
    ]),
  }),
  z.strictObject({
    kind: z.literal("type"),
    path,
    value: z.enum(["object", "array", "string", "number", "boolean"]),
  }),
  z
    .strictObject({
      kind: z.literal("range"),
      path,
      min: z.number().finite(),
      max: z.number().finite(),
    })
    .refine((r) => r.max >= r.min),
  z.strictObject({
    kind: z.literal("freshness"),
    path,
    maxAgeSeconds: z.number().int().min(0).max(86400),
    futureToleranceSeconds: z.number().int().min(0).max(60),
  }),
]);
export const outcomeContractSchema = z.strictObject({
  version: z.literal(1),
  statuses: z.array(z.number().int().min(200).max(299)).min(1).max(20),
  rules: z.array(rule).min(1).max(20),
});
export type OutcomeContract = z.infer<typeof outcomeContractSchema>;
export const defaultOutcomeContract: OutcomeContract = {
  version: 1,
  statuses: [200],
  rules: [{ kind: "type", path: [], value: "object" }],
};
const hashText = (s: string) => keccak256(toHex(s));
const responseSchema = z.string().max(262144).nullable();
function atPath(input: unknown, parts: string[]): unknown {
  let value = input;
  for (const key of parts) {
    if (
      typeof value !== "object" ||
      value === null ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function matchesType(value: unknown, type: string) {
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === type && (type !== "number" || Number.isFinite(value));
}
/** Deterministic checks, not an oracle. Caller-supplied response and timestamp
 * cannot establish merchant authorship, truthful data or commercial delivery. */
export function evaluateOutcome(
  contractInput: OutcomeContract,
  bodyInput: string | null,
  httpStatus: number | null,
  observedAt: number,
) {
  const contract = outcomeContractSchema.parse(contractInput);
  const body = responseSchema.parse(bodyInput);
  z.number().int().safe().nonnegative().parse(observedAt);
  z.number().int().min(100).max(599).nullable().parse(httpStatus);
  if ((body === null) !== (httpStatus === null))
    throw Error("INCONSISTENT_RESPONSE_OBSERVATION");
  const checks: { code: string; path: string[]; pass: boolean }[] = [];
  let value: unknown;
  let validJson = false;
  if (body !== null) {
    try {
      value = JSON.parse(body);
      validJson = true;
    } catch {
      /* checked below */
    }
    checks.push({
      code: "HTTP_STATUS",
      path: [],
      pass: contract.statuses.includes(httpStatus!),
    });
    checks.push({ code: "VALID_JSON", path: [], pass: validJson });
    for (const r of contract.rules) {
      const actual = atPath(value, r.path);
      let pass = false;
      if (validJson) {
        if (r.kind === "equals") pass = actual === r.value;
        if (r.kind === "type") pass = matchesType(actual, r.value);
        if (r.kind === "range")
          pass =
            typeof actual === "number" &&
            Number.isFinite(actual) &&
            actual >= r.min &&
            actual <= r.max;
        if (r.kind === "freshness")
          pass =
            typeof actual === "number" &&
            Number.isSafeInteger(actual) &&
            actual >= 0 &&
            actual <= observedAt + r.futureToleranceSeconds &&
            observedAt - actual <= r.maxAgeSeconds;
      }
      checks.push({ code: r.kind.toUpperCase(), path: r.path, pass });
    }
  }
  return {
    version: 1 as const,
    contractDigest: hashText(JSON.stringify(contract)),
    responseDigest: body === null ? null : hashText(body),
    httpStatus,
    observedAt,
    decision:
      body === null
        ? ("response_missing" as const)
        : checks.every((c) => c.pass)
          ? ("checks_passed" as const)
          : ("checks_failed" as const),
    checks,
    merchantAuthorshipVerified: false as const,
    usefulDeliveryVerified: false as const,
  };
}
export function verifyOutcomeReport(
  contract: OutcomeContract,
  body: string | null,
  report: ReturnType<typeof evaluateOutcome>,
) {
  try {
    return (
      JSON.stringify(
        evaluateOutcome(contract, body, report.httpStatus, report.observedAt),
      ) === JSON.stringify(report)
    );
  } catch {
    return false;
  }
}
