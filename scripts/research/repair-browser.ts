import {
  planPermitRepair,
  verifyPermitRepair,
  checkRepairSnapshot,
} from "../../src/research/permit-repair.js";
type Example = {
  id: string;
  title: string;
  description: string;
  input: unknown;
};
type Plan = Awaited<ReturnType<typeof planPermitRepair>>;
const el = <T = HTMLElement>(id: string) =>
  document.getElementById(id) as unknown as T;
const select = el<HTMLSelectElement>("scenario"),
  editor = el<HTMLTextAreaElement>("inventory"),
  observed = el<HTMLTextAreaElement>("observed");
const run = el<HTMLButtonElement>("run"),
  verify = el<HTMLButtonElement>("verify");
const status = el("status");
let examples: Example[] = [],
  latest: Plan | undefined,
  analyzedInput: unknown;
let isDemoSnapshot = false;
function busy(value: boolean) {
  run.disabled = value;
  select.disabled = value;
  editor.disabled = value;
  verify.disabled = value || !latest;
  el<HTMLButtonElement>("compare-button").disabled = value;
  el<HTMLButtonElement>("sample").disabled = value;
  observed.disabled = value;
}
function clear() {
  latest = undefined;
  verify.disabled = true;
  el("result").hidden = true;
  el("empty").hidden = false;
  observed.value = "";
  el("comparison-status").textContent = "";
  isDemoSnapshot = false;
}
function inputChanged() {
  clear();
  status.textContent = "Request changed. Find a new repair plan.";
  el("constraints").textContent =
    "Custom request; inspect JSON for current constraints.";
}
function selected() {
  const e = examples.find((x) => x.id === select.value);
  if (!e) return;
  clear();
  editor.value = JSON.stringify(e.input, null, 2);
  el("description").textContent = e.description;
  const request = e.input as {
    unwantedPermitIds: string[];
    wantedSequence: string[];
    clearAllowanceSlots?: unknown[];
  };
  const container = el("constraints");
  container.replaceChildren();
  for (const text of [
    `Block: ${request.unwantedPermitIds.join(", ") || "none"}`,
    `Keep: ${request.wantedSequence.join(" → ") || "none"}`,
    `Clear slots: ${request.clearAllowanceSlots?.length ?? 0}`,
  ]) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = text;
    container.appendChild(chip);
  }
  status.textContent = "Ready. Signature checks and planning run locally.";
}
function parse(text: string) {
  if (text.length > 65536)
    throw new Error("JSON exceeds the 64 KiB interface limit.");
  return JSON.parse(text) as unknown;
}
function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 300)
    : "Unsupported input.";
}
select.addEventListener("change", selected);
editor.addEventListener("input", inputChanged);
observed.addEventListener("input", () => {
  isDemoSnapshot = false;
  el("comparison-status").textContent =
    "Snapshot edited; run comparison again. Source is not authenticated.";
});
run.addEventListener("click", async () => {
  clear();
  busy(true);
  status.textContent = "Checking signatures and searching supported repairs…";
  try {
    const input = parse(editor.value),
      result = await planPermitRepair(input);
    latest = result;
    analyzedInput = input;
    el("outcome").textContent =
      result.status === "repairable"
        ? "A repair plan exists"
        : result.status === "unchanged"
          ? "No repair needed for this request"
          : "No valid repair in this model";
    el("cost").textContent = result.totalCost ?? "—";
    el("calls").textContent =
      result.status === "impossible" ? "—" : String(result.actions.length);
    el("explanation").textContent = result.explanation.message;
    const steps = el("steps");
    steps.replaceChildren();
    for (const [i, action] of result.actions.entries()) {
      const card = document.createElement("div");
      card.className = "step";
      const label = document.createElement("strong");
      label.textContent = `${i + 1}. ${action.kind === "invalidateNonces" ? `Advance nonce to ${action.newNonce}` : "Set stored allowance to zero"}`;
      const detail = document.createElement("small");
      detail.textContent = `Token ${action.token} · Spender ${action.spender} · Cost ${action.cost}`;
      card.appendChild(label);
      card.appendChild(detail);
      steps.appendChild(card);
    }
    if (!result.actions.length)
      steps.textContent =
        result.status === "impossible"
          ? "No actions offered: the constraints cannot all be met using the supported repairs."
          : "The supplied constraints already hold. This does not imply the wallet is safe.";
    el("sequence").textContent =
      result.status === "impossible"
        ? "The requested sequence could not be preserved together with all repair constraints."
        : result.wantedWitness.join(" → ") || "No wanted sequence requested.";
    el("search").textContent =
      `Evaluated ${result.search.candidateCount} candidate plans and ${result.search.stateCount} reachable states. Minimum refers to synthetic action costs, not gas.`;
    el("certificate").textContent = JSON.stringify(result, null, 2);
    el("compare").hidden = result.status === "impossible";
    el("result").hidden = false;
    el("empty").hidden = true;
    status.textContent =
      "Planning complete within the supplied model. No transaction was signed or sent.";
  } catch (error) {
    clear();
    status.textContent = "Not planned. " + errorMessage(error);
  } finally {
    busy(false);
  }
});
verify.addEventListener("click", async () => {
  if (!latest) return;
  busy(true);
  try {
    const valid = await verifyPermitRepair(analyzedInput, latest);
    const tampered = { ...latest, inputHash: "0x" + "00".repeat(32) };
    const rejected = !(await verifyPermitRepair(analyzedInput, tampered));
    status.textContent =
      valid && rejected
        ? "Recomputation passed; a changed request binding was rejected. This is not an independent security audit."
        : "Recheck failed. Do not use this plan.";
  } catch (error) {
    status.textContent = "Recheck failed. " + errorMessage(error);
  } finally {
    busy(false);
  }
});
el<HTMLButtonElement>("sample").addEventListener("click", () => {
  if (!latest) return;
  observed.value = JSON.stringify(latest.expectedSlots, null, 2);
  isDemoSnapshot = true;
  el("comparison-status").textContent =
    "DEMO: expected values copied from the plan. This is not evidence that a repair happened.";
});
el<HTMLButtonElement>("compare-button").addEventListener("click", async () => {
  if (!latest) return;
  busy(true);
  try {
    const result = await checkRepairSnapshot(
      analyzedInput,
      latest,
      parse(observed.value),
    );
    el("comparison-status").textContent =
      (isDemoSnapshot ? "DEMO ONLY: " : "Caller-supplied data: ") +
      (result.matches
        ? "snapshot matches the planned values. This does not verify on-chain execution or finality."
        : "snapshot does not match. " + result.mismatches.join("; "));
  } catch (error) {
    el("comparison-status").textContent =
      "Not verified. " + errorMessage(error);
  } finally {
    busy(false);
  }
});
el<HTMLButtonElement>("download").addEventListener("click", () => {
  if (!latest) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(latest, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "korp-repair-plan.json";
  link.click();
  URL.revokeObjectURL(url);
});
try {
  const response = await fetch("/repair-fixtures.json");
  if (!response.ok) throw new Error("Could not load public examples.");
  examples = ((await response.json()) as { examples: Example[] }).examples;
  for (const e of examples) {
    const option = document.createElement("option");
    option.value = e.id;
    option.textContent = e.title;
    select.options.add(option);
  }
  selected();
  run.disabled = false;
} catch (error) {
  status.textContent = "Unavailable. " + errorMessage(error);
}
