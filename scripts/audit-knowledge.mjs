/**
 * A standing audit of the knowledge layer against the blueprints.
 *
 * Two failures are easy to make and hard to see:
 *
 *   under-claim  the model can do something and nothing says so, so the agent
 *                never offers it (Qwen-Image: six image-taking templates, no
 *                image-to-image label)
 *   over-claim   the record promises something with no evidence, and the agent
 *                offers a model that cannot do it
 *
 * Both are silent. Neither shows up as an error, only as a wrong answer to a
 * question nobody re-asks. This runs the check so a mismatch is a warning at
 * least, and it states what each finding means rather than failing on it — an
 * absent template proves a model is not what it claims only when the model has
 * templates at all.
 */

import { blueprintCatalogue, graphModels } from "../lib/blueprint-runner.js";
import { toPromptGraph } from "../lib/blueprint.js";
import { MODEL_KNOWLEDGE, knownTasks } from "../lib/model-knowledge.js";
import { modelCapabilities } from "../lib/capabilities.js";

const catalogue = blueprintCatalogue();
const normalise = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const derived = modelCapabilities(catalogue);

let warnings = 0;
function warn(text) {
  warnings += 1;
  console.log(`  ! ${text}`);
}

console.log("\n# models declared vs models shipped");
{
  const shipped = new Set(catalogue.map((entry) => entry.model).filter(Boolean));
  const recorded = new Set(MODEL_KNOWLEDGE.map((record) => record.family));
  // Compared folded: the catalogue ships "Qwen-image" beside "Qwen-Image" and
  // "Z-image-Turbo" beside "Z-Image-Turbo". A case difference is a spelling
  // variant, not a model the knowledge layer has never heard of.
  const foldedRecorded = new Set([...recorded].map(normalise));
  const missing = [...shipped].filter((model) => !foldedRecorded.has(normalise(model)));
  const variants = [...shipped].filter(
    (model) => !recorded.has(model) && foldedRecorded.has(normalise(model)),
  );
  console.log(`  ${recorded.size} records for ${shipped.size} shipped model names`);
  if (variants.length > 0) {
    console.log(`  ${variants.length} spelling variants folded: ${variants.join(", ")}`);
  }
  if (missing.length > 0) warn(`shipped but not described: ${missing.join(", ")}`);
}

console.log("\n# under-claiming: capability demonstrated but not declared");
{
  // Anything the templates demonstrate is a capability the knowledge layer
  // should know about, whether or not `bestFor` happens to name it. The
  // capability derivation already covers this at query time, so a gap here is
  // not a bug -- it is reported so the two views can be compared.
  const known = new Set(knownTasks());
  const undeclared = new Set();
  for (const [key, capabilities] of derived) {
    for (const capability of capabilities) {
      if (known.has(capability)) continue;
      undeclared.add(capability);
    }
  }
  if (undeclared.size > 0) {
    console.log(`  capabilities derived but not in the task list: ${[...undeclared].join(", ")}`);
  } else {
    console.log("  every derived capability is in the task list");
  }
}

console.log("\n# over-claiming: declared with no template evidence");
{
  // A declared task with no supporting template is only suspicious when the
  // model has templates at all: a model whose only template is a text-to-image
  // graph cannot be disproved for editing just by the absence of an editing one.
  const withTemplates = new Set();
  const tasksByModel = new Map();
  for (const entry of catalogue) {
    if (!entry.model) continue;
    const key = normalise(entry.model);
    withTemplates.add(key);
    if (!tasksByModel.has(key)) tasksByModel.set(key, new Set());
    tasksByModel.get(key).add(entry.task);
  }

  for (const record of MODEL_KNOWLEDGE) {
    const key = normalise(record.family);
    if (!withTemplates.has(key)) continue;
    for (const task of record.bestFor ?? []) {
      const proven = new Set(
        [...(derived.get(key) ?? [])],
      );
      if (proven.has(task)) continue;
      // Only a hard contradiction: the model is filed under tasks that its
      // templates contradict outright.
      const tasks = tasksByModel.get(key);
      if (tasks === undefined) continue;
      console.log(`  ? ${record.family} declares "${task}"; its templates cover ${[...tasks].join(", ")}`);
    }
  }
}

console.log("\n# self-consistency");
{
  // A record whose own summary contradicts its own task list is worth seeing:
  // VOID said it did video inpainting and was filed under video generation.
  for (const record of MODEL_KNOWLEDGE) {
    const strengths = (record.strengths ?? []).join(" ");
    const bestFor = record.bestFor ?? [];
    if (/inpaint/i.test(strengths) && bestFor.includes("video") && !bestFor.some((t) => /inpaint/.test(t))) {
      warn(`${record.family}: strengths say inpainting, bestFor has no inpainting task`);
    }
  }
  console.log("  done");
}

console.log(
  warnings === 0
    ? "\nNO AUDIT WARNINGS"
    : `\n${warnings} AUDIT WARNING(S) — review the lines marked ! above`,
);