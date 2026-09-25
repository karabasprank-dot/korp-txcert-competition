import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  type Hex,
} from "viem";
import type { CheckRequest } from "../schemas/index.js";
import { transactionHash, policyHash } from "./canonicalize.js";

const burn = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);
const selectors = new Set(["0xa9059cbb", "0x23b872dd", "0x095ea7b3"]);
const permits = new Set([
  "0xd505accf",
  "0x8fcbaf0c",
  "0x2b67b570",
  "0x36c78516",
]);
export function evaluate(r: CheckRequest) {
  const checks: { id: string; status: "PASS" | "WARN" | "BLOCK" }[] = [];
  const check = (id: string, ok: boolean) =>
    checks.push({ id, status: ok ? "PASS" : "BLOCK" });
  const allowed = (list: string[], value: string) =>
    list.some((a) => a.toLowerCase() === value.toLowerCase());
  let decoded: Record<string, string> = { action: "unknown" };
  check("CHAIN_ALLOWED", r.chainId === 84532 || r.chainId === 8453);
  check("SENDER_NOT_BURN", !burn.has(r.from.toLowerCase()));
  check("TARGET_NOT_BURN", !burn.has(r.transaction.to.toLowerCase()));
  check(
    "NATIVE_VALUE_LIMIT",
    BigInt(r.transaction.value) <= BigInt(r.policy.maxNativeValueWei),
  );
  if (r.transaction.data === "0x") {
    decoded = {
      action: "native-transfer",
      recipient: r.transaction.to,
      amount: r.transaction.value,
    };
    check(
      "RECIPIENT_ALLOWED",
      allowed(r.policy.allowedRecipients, r.transaction.to),
    );
  } else if (selectors.has(r.transaction.data.slice(0, 10).toLowerCase())) {
    try {
      const call = decodeFunctionData({
        abi: erc20Abi,
        data: r.transaction.data as Hex,
      });
      if (!["transfer", "transferFrom", "approve"].includes(call.functionName))
        throw new Error("Unsupported");
      // ABI decoders can ignore trailing bytes or noncanonical padding. Reject both.
      const canonical = encodeFunctionData({
        abi: erc20Abi,
        functionName: call.functionName,
        args: call.args,
      });
      if (canonical.toLowerCase() !== r.transaction.data.toLowerCase())
        throw new Error("Noncanonical ABI");
      const args = call.args as readonly (string | bigint)[];
      const amount = BigInt(
        args[call.functionName === "transferFrom" ? 2 : 1]!,
      );
      const target = String(args[call.functionName === "transferFrom" ? 1 : 0]);
      decoded = {
        action: call.functionName,
        token: r.transaction.to,
        amount: amount.toString(),
        [call.functionName === "approve" ? "spender" : "recipient"]: target,
      };
      check("ERC20_NATIVE_VALUE_ZERO", r.transaction.value === "0");
      const limit = r.policy.maxTokenSpend.find(
        (v) => v.token.toLowerCase() === r.transaction.to.toLowerCase(),
      );
      check("TOKEN_ALLOWED", !!limit);
      check("TOKEN_AMOUNT_LIMIT", !!limit && amount <= BigInt(limit.amount));
      check("DESTINATION_NOT_BURN", !burn.has(target.toLowerCase()));
      if (call.functionName === "approve") {
        check("SPENDER_ALLOWED", allowed(r.policy.allowedSpenders, target));
        check(
          "APPROVAL_NOT_UNLIMITED",
          amount !== maxUint256 || r.policy.allowUnlimitedApproval,
        );
      } else {
        check("RECIPIENT_ALLOWED", allowed(r.policy.allowedRecipients, target));
        if (call.functionName === "transferFrom") {
          decoded.owner = String(args[0]);
          check(
            "TRANSFER_FROM_OWNER",
            String(args[0]).toLowerCase() === r.from.toLowerCase(),
          );
        }
      }
    } catch {
      check("CALLDATA_CANONICAL_AND_DECODABLE", false);
    }
  } else if (permits.has(r.transaction.data.slice(0, 10).toLowerCase())) {
    decoded = { action: "unsupported-permit" };
    check("PERMIT_UNSUPPORTED", false);
  } else if (!r.policy.allowUnknownCalls) {
    check("UNKNOWN_CALL_BLOCKED", false);
  } else {
    checks.push({ id: "UNKNOWN_CALL_UNPROVEN", status: "WARN" });
  }
  check("EXPECTED_ACTION", decoded.action === r.policy.expectedAction);
  const decision = checks.some((c) => c.status === "BLOCK")
    ? "BLOCK"
    : checks.some((c) => c.status === "WARN")
      ? "WARN"
      : "PASS";
  return {
    version: "1" as const,
    decision,
    chainId: r.chainId,
    transactionHash: transactionHash(r),
    policyHash: policyHash(r.policy),
    decoded,
    checks,
  };
}
