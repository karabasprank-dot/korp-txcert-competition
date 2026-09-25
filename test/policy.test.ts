import { describe, it, expect } from "vitest";
import { maxUint256, encodeFunctionData, erc20Abi } from "viem";
import { evaluate } from "../src/core/policy.js";
import { requestSchema } from "../src/schemas/index.js";
import { native, erc20, recipient } from "./fixtures.js";
describe("deterministic fail-closed policy", () => {
  for (const action of ["transfer", "approve", "transferFrom"] as const)
    it(`accepts valid ${action}`, () =>
      expect(evaluate(erc20(action)).decision).toBe("PASS"));
  it("accepts a bounded native transfer", () =>
    expect(evaluate(native()).decision).toBe("PASS"));
  it("blocks excessive native value", () => {
    const r = native();
    r.transaction.value = "1001";
    expect(evaluate(r).decision).toBe("BLOCK");
  });
  for (const action of ["transfer", "approve", "transferFrom"] as const)
    it(`blocks excessive ${action}`, () =>
      expect(evaluate(erc20(action, 101n)).decision).toBe("BLOCK"));
  it("blocks unlisted recipient", () => {
    const r = erc20();
    r.policy.allowedRecipients = [];
    expect(evaluate(r).decision).toBe("BLOCK");
  });
  it("blocks unlisted spender", () => {
    const r = erc20("approve");
    r.policy.allowedSpenders = [];
    expect(evaluate(r).decision).toBe("BLOCK");
  });
  it("blocks unlimited approval", () => {
    const r = erc20("approve", maxUint256);
    r.policy.maxTokenSpend[0]!.amount = maxUint256.toString();
    expect(evaluate(r).decision).toBe("BLOCK");
  });
  it("allows unlimited approval only with explicit flag AND cap", () => {
    const r = erc20("approve", maxUint256);
    r.policy.allowUnlimitedApproval = true;
    expect(evaluate(r).decision).toBe("BLOCK");
    r.policy.maxTokenSpend[0]!.amount = maxUint256.toString();
    expect(evaluate(r).decision).toBe("PASS");
  });
  it("blocks wrong token", () => {
    const r = erc20();
    r.transaction.to = recipient;
    expect(evaluate(r).decision).toBe("BLOCK");
  });
  it("blocks nonzero native value on token call", () => {
    const r = erc20();
    r.transaction.value = "1";
    expect(evaluate(r).decision).toBe("BLOCK");
  });
  it("blocks foreign transferFrom owner", () => {
    const r = erc20("transferFrom");
    r.transaction.data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transferFrom",
      args: [recipient, recipient, 1n],
    });
    expect(evaluate(r).decision).toBe("BLOCK");
  });
  it("blocks action mismatch", () => {
    const r = erc20();
    r.policy.expectedAction = "approve";
    expect(evaluate(r).decision).toBe("BLOCK");
  });
  it.each(["0x12345678", "0xa9059cbb", "0x01", "0xd505accf"])(
    "blocks unknown/truncated/permit %s",
    (data) => {
      const r = native();
      r.transaction.data = data;
      expect(evaluate(r).decision).toBe("BLOCK");
    },
  );
  it("unknown explicitly allowed is WARN and not PASS", () => {
    const r = native();
    r.transaction.data = "0x12345678";
    r.policy.expectedAction = "unknown";
    r.policy.allowUnknownCalls = true;
    expect(evaluate(r).decision).toBe("WARN");
  });
  it("blocks appended ABI bytes", () => {
    const r = erc20();
    r.transaction.data += "00";
    expect(evaluate(r).decision).toBe("BLOCK");
  });
  it("blocks invalid address word padding", () => {
    const r = erc20();
    r.transaction.data =
      r.transaction.data.slice(0, 10) + "ff" + r.transaction.data.slice(12);
    expect(evaluate(r).decision).toBe("BLOCK");
  });
  it("evaluates a bounded mainnet transfer", () => {
    const r = native();
    r.chainId = 8453;
    expect(evaluate(r).decision).toBe("PASS");
  });
  it.each([
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dEaD",
  ])("blocks burn recipient %s", (to) => {
    const r = native();
    r.transaction.to = to;
    r.policy.allowedRecipients = [to];
    expect(evaluate(r).decision).toBe("BLOCK");
  });
});
describe("strict input validation", () => {
  it.each([
    "-1",
    "01",
    "1.0",
    "1e6",
    " 1",
    "0x01",
    (maxUint256 + 1n).toString(),
  ])("rejects quantity %s", (value) => {
    const r = native();
    r.transaction.value = value;
    expect(requestSchema.safeParse(r).success).toBe(false);
  });
  it.each(["0x0", "0xgg", "0X00", "0x" + "aa".repeat(4097)])(
    "rejects bad/huge calldata",
    (data) => {
      const r = native();
      r.transaction.data = data;
      expect(requestSchema.safeParse(r).success).toBe(false);
    },
  );
  it("rejects bad address", () => {
    const r = native();
    r.from = "0x123";
    expect(requestSchema.safeParse(r).success).toBe(false);
  });
  it("rejects unsupported chain", () =>
    expect(requestSchema.safeParse({ ...native(), chainId: 1 }).success).toBe(
      false,
    ));
  it("rejects extra fields including keys", () =>
    expect(
      requestSchema.safeParse({ ...native(), privateKey: "do not accept this" })
        .success,
    ).toBe(false));
  it("rejects duplicate token caps", () => {
    const r = erc20();
    r.policy.maxTokenSpend.push(r.policy.maxTokenSpend[0]!);
    expect(requestSchema.safeParse(r).success).toBe(false);
  });
  it("rejects numeric amounts", () =>
    expect(
      requestSchema.safeParse({
        ...native(),
        transaction: { ...native().transaction, value: 1 },
      }).success,
    ).toBe(false));
});
