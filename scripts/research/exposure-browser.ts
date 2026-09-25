import {
  analyzePermitExposure,
  verifyExposureCertificate,
} from "../../src/research/permit-exposure.js";
type Example = {
  id: string;
  title: string;
  description: string;
  input: unknown;
};
// Worker HTMLRewriter globals overlap the DOM types; these handles are browser DOM nodes.
const element = <T = HTMLElement>(id: string) =>
  document.getElementById(id) as unknown as T;
const select = element<HTMLSelectElement>("scenario");
const editor = element<HTMLTextAreaElement>("inventory");
const run = element<HTMLButtonElement>("run");
const verify = element<HTMLButtonElement>("verify");
const status = element("status");
let examples: Example[] = [];
let latest: Awaited<ReturnType<typeof analyzePermitExposure>> | undefined;
let analyzedInput: unknown;
function showError(error: unknown) {
  status.textContent =
    "Not analyzed. " +
    (error instanceof Error ? error.message.slice(0, 250) : "Invalid input.");
  element("result").hidden = true;
  latest = undefined;
  verify.disabled = true;
}
function selected() {
  const example = examples.find((e) => e.id === select.value);
  if (!example) return;
  editor.value = JSON.stringify(example.input, null, 2);
  element("description").textContent = example.description;
  element("result").hidden = true;
  latest = undefined;
  verify.disabled = true;
  status.textContent =
    "Ready. Calculations and signature verification run in this browser.";
}
select.addEventListener("change", selected);
editor.addEventListener("input", () => {
  latest = undefined;
  verify.disabled = true;
  element("result").hidden = true;
  status.textContent = "Inventory changed. Run the analysis again.";
});
run.addEventListener("click", async () => {
  run.disabled = true;
  verify.disabled = true;
  select.disabled = true;
  editor.disabled = true;
  latest = undefined;
  status.textContent =
    "Verifying signatures and exploring reachable nonce states…";
  try {
    if (editor.value.length > 65536)
      throw new Error("Inventory exceeds 64 KiB.");
    const input: unknown = JSON.parse(editor.value);
    const result = await analyzePermitExposure(input);
    latest = result;
    analyzedInput = input;
    element("maximum").textContent = result.maxTotal;
    element("naive").textContent = result.naive.sumOfSignedGrantsPlusBaseline;
    element("baseline").textContent = result.baselineAllowance;
    element("states").textContent = String(result.reachableStateCount);
    element("sequence").textContent = result.witness.length
      ? result.witness
          .map((id) => `${id} → drain any active granted allowance`)
          .join(" → ")
      : "No signed batch adds withdrawal capacity in the maximizing sequence. Existing allowance is counted separately.";
    element("certificate").textContent = JSON.stringify(result, null, 2);
    element("result").hidden = false;
    status.textContent =
      "Complete for this inventory and model. This is not a live-wallet safety certificate.";
    verify.disabled = false;
  } catch (error) {
    showError(error);
  } finally {
    run.disabled = false;
    select.disabled = false;
    editor.disabled = false;
  }
});
verify.addEventListener("click", async () => {
  if (!latest) return;
  verify.disabled = true;
  run.disabled = true;
  select.disabled = true;
  editor.disabled = true;
  try {
    const valid = await verifyExposureCertificate(analyzedInput, latest);
    const altered = {
      ...latest,
      maxTotal: (BigInt(latest.maxTotal) + 1n).toString(),
    };
    const rejectsAltered = !(await verifyExposureCertificate(
      analyzedInput,
      altered,
    ));
    status.textContent =
      valid && rejectsAltered
        ? "Certificate checks passed. Changing the claimed maximum was rejected."
        : "Certificate check failed. Do not rely on this result.";
  } catch (error) {
    showError(error);
  } finally {
    if (latest) verify.disabled = false;
    run.disabled = false;
    select.disabled = false;
    editor.disabled = false;
  }
});
element<HTMLButtonElement>("download").addEventListener("click", () => {
  if (!latest) return;
  // Export the computed result only, never the supplied bearer signatures.
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(latest, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "korp-exposure-result.json";
  link.click();
  URL.revokeObjectURL(url);
});
try {
  const response = await fetch("/exposure-fixtures.json");
  if (!response.ok) throw new Error("Could not load public test fixtures.");
  const data = (await response.json()) as { examples: Example[] };
  examples = data.examples;
  for (const e of examples) {
    const option = document.createElement("option");
    option.value = e.id;
    option.textContent = e.title;
    select.options.add(option);
  }
  selected();
  run.disabled = false;
} catch (error) {
  showError(error);
}
