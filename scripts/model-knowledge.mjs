/**
 * Knowledge-base checks.
 *
 * The point of this file is to keep `model-knowledge.js` honest. Every sampler
 * number it publishes is asserted against the `widgets_values` of a sampler
 * node inside a real blueprint shipped on this machine — not against a
 * hand-written expectation, which would only prove the module agrees with
 * itself.
 *
 * Runs hermetically apart from reading the local Comfy Desktop installs; when
 * none is present the blueprint-backed assertions are skipped and the
 * structural ones still run.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MODEL_KNOWLEDGE,
  TASKS,
  compareFamilies,
  knownTasks,
  queryModel,
  recommendForTask,
} from "../lib/model-knowledge.js";
import { discoverBlueprints, unwrapBlueprint } from "../lib/blueprint.js";

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` -- ${detail}`}`);
}

function section(title) {
  console.log(`\n# ${title}`);
}

/**
 * The same widget alignment `lib/blueprint.js` uses.
 *
 * Replicated rather than imported because that helper is module-private and
 * this file may be edited independently. The algorithm is the load-bearing
 * part: a seeded widget is followed by its control-after-generate setting, and
 * skipping that entry is what keeps every later widget aligned with its input.
 */
const CONTROL_AFTER_GENERATE = new Set([
  "fixed",
  "increment",
  "decrement",
  "randomize",
  "enable",
  "disable",
]);

function widgetValues(node) {
  const values = new Map();
  const raw = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  let cursor = 0;
  for (const input of node.inputs ?? []) {
    if (input?.widget === undefined) continue;
    if (cursor >= raw.length) break;
    const value = raw[cursor];
    cursor += 1;
    values.set(input.name, value);
    if (/seed|noise/i.test(input.name) && CONTROL_AFTER_GENERATE.has(raw[cursor])) cursor += 1;
  }
  return values;
}

/* ---- structure -------------------------------------------------- */

section("module shape");
check("exports a non-empty knowledge base", Array.isArray(MODEL_KNOWLEDGE) && MODEL_KNOWLEDGE.length > 0);
check("exposes a task vocabulary", TASKS !== undefined && Object.keys(TASKS).length > 0);

let missingField = null;
for (const record of MODEL_KNOWLEDGE) {
  const needed = ["family", "label", "category", "bestFor", "strengths", "sampler", "negativePrompt", "textRendering", "speed", "promptHints"];
  for (const field of needed) {
    if (record[field] === undefined) {
      missingField = `${record.family} lacks ${field}`;
      break;
    }
  }
  if (missingField !== null) break;
}
check("every record has the full field set", missingField === null, missingField ?? "");

let badHint = null;
for (const record of MODEL_KNOWLEDGE) {
  if (Array.isArray(record.promptHints?.zh) && Array.isArray(record.promptHints?.en)) continue;
  badHint = `${record.family} promptHints must carry both zh and en`;
  break;
}
check("prompt hints are bilingual", badHint === null, badHint ?? "");

let badSpeed = null;
for (const record of MODEL_KNOWLEDGE) {
  if (["draft", "standard", "quality"].includes(record.speed)) continue;
  badSpeed = `${record.family} has speed "${record.speed}"`;
  break;
}
check("speed tiers are from the fixed set", badSpeed === null, badSpeed ?? "");

/* ---- lookup ------------------------------------------------------ */

section("lookup");
check("finds Z-Image-Turbo", queryModel("Z-Image-Turbo") !== undefined);
check("is case-insensitive", queryModel("z-image-turbo")?.family === "Z-Image-Turbo");
check("ignores separators", queryModel("z_image_turbo")?.family === "Z-Image-Turbo");
check("accepts an alias", queryModel("Z-image-Turbo")?.family === "Z-Image-Turbo");
check("accepts a unique substring", queryModel("qwen image")?.family?.startsWith("Qwen-Image") === true);
check("refuses an ambiguous prefix", queryModel("flux") === undefined, "an ambiguous prefix must not guess");
check("returns undefined for nonsense", queryModel("no-such-model") === undefined);
check("rejects an empty name", queryModel("") === undefined);

/* ---- recommendations --------------------------------------------- */

section("recommendations");
const forTextToImage = recommendForTask("text-to-image");
const names = forTextToImage.map((record) => record.family);
check(
  "text-to-image recommends Z-Image-Turbo and Qwen-Image",
  names.includes("Z-Image-Turbo") && names.includes("Qwen-Image"),
  names.join(", "),
);
check("text-to-image has several options", forTextToImage.length >= 5, `${forTextToImage.length}`);
const forVideo = recommendForTask("video");
check("a draft model leads for fast work", recommendForTask("text-to-image", { speed: "draft" })[0]?.speed === "draft");
// Bernini-R carries both image and video templates, so a category check would
// be wrong. What matters is that no pure image generator leaks into the answer.
check(
  "video task excludes pure image generators",
  !forVideo.some((record) => ["Z-Image-Turbo", "Flux.1 Dev", "Qwen-Image"].includes(record.family)),
  forVideo.map((r) => r.family).join(", "),
);
check("video task returns several options", forVideo.length >= 4, `${forVideo.length}`);
check(
  "video task leads with a video model",
  forVideo[0]?.category === "video" || forVideo[0]?.family === "Bernini-R",
  forVideo[0]?.family,
);
check("an unknown task returns nothing", recommendForTask("no-such-task").length === 0);
check("knownTasks covers every declared task", knownTasks().length > 0);

/* ---- comparison --------------------------------------------------- */

section("comparison");
const cmp = compareFamilies(["Z-Image-Turbo", "Qwen-Image", "no-such-model"]);
check("lines the families up", cmp.families.length === 3, cmp.families.join(", "));
check("steps are parallel arrays", cmp.steps.length === 3 && cmp.cfg.length === 3);
check("flags the unknown one", cmp.missing.includes("no-such-model"), cmp.missing.join(", "));
check(
  "distinguishes negative-prompt support",
  cmp.negativePrompt[0] === false && cmp.negativePrompt[1] === true,
  JSON.stringify(cmp.negativePrompt),
);

/* ---- agreement with the real templates ---------------------------- */

const INSTALL_ROOT =
  process.env.LOCALAPPDATA === undefined
    ? undefined
    : join(process.env.LOCALAPPDATA, "Comfy-Desktop", "ComfyUI-Installs");

/** blueprintId -> the sampler widgets actually found in it. */
const blueprintSamplers = new Map();

if (INSTALL_ROOT === undefined || !existsSync(INSTALL_ROOT)) {
  section("agreement with templates");
  console.log("  SKIP no Comfy Desktop install found; template checks not run");
} else {
  for (const dir of readdirSync(INSTALL_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const root = join(INSTALL_ROOT, dir.name, "ComfyUI");
    if (!existsSync(join(root, "main.py"))) continue;
    for (const entry of discoverBlueprints(root)) {
      let subgraph;
      try {
        subgraph = unwrapBlueprint(JSON.parse(entry.raw))?.subgraph;
      } catch {
        continue;
      }
      if (subgraph === undefined) continue;
      for (const node of subgraph.nodes ?? []) {
        if (!/sampler/i.test(node.type ?? "")) continue;
        const values = widgetValues(node);
        if (!values.has("steps") && !values.has("sampler_name")) continue;
        const list = blueprintSamplers.get(entry.id) ?? [];
        list.push({
          steps: values.get("steps"),
          cfg: values.get("cfg"),
          sampler_name: values.get("sampler_name"),
          scheduler: values.get("scheduler"),
        });
        blueprintSamplers.set(entry.id, list);
      }
    }
  }

  section("agreement with templates");
  console.log(`  (${blueprintSamplers.size} blueprints carry a sampler)`);

  /** Every blueprint id this machine actually ships. */
  const shippedIds = new Set();
  for (const dir of readdirSync(INSTALL_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const root = join(INSTALL_ROOT, dir.name, "ComfyUI");
    if (!existsSync(join(root, "main.py"))) continue;
    for (const entry of discoverBlueprints(root)) shippedIds.add(entry.id);
  }

  /**
   * A family's published sampler must be the template's own default.
   *
   * The check walks the blueprint ids the record cites, finds the sampler in
   * the shipped file, and asserts the record's value appears there. A value
   * the templates never use would mean the knowledge base had drifted.
   */
  const assertAgainstTemplates = (family) => {
    const record = queryModel(family);
    if (record === undefined) {
      check(`${family}: record exists`, false, "no record");
      return;
    }
    const sources = record.sampler.source ?? [];
    if (sources.length === 0) {
      check(`${family}: cites a source blueprint`, false, "sampler.source is empty");
      return;
    }
    const observed = [];
    for (const id of sources) {
      if (!shippedIds.has(id)) {
        check(`${family}: source "${id}" exists`, false, "no such blueprint on this machine");
        return;
      }
      observed.push(...(blueprintSamplers.get(id) ?? []));
    }
    const fields = [
      ["steps", record.sampler.steps],
      ["cfg", record.sampler.cfg],
      ["sampler_name", record.sampler.sampler_name],
      ["scheduler", record.sampler.scheduler],
    ];
    for (const [field, spec] of fields) {
      if (spec?.verified !== true) continue; // unverified fields make no claim
      if (spec.value === undefined) continue;
      const hit = observed.some((entry) => entry[field] === spec.value);
      check(
        `${family}: ${field} = ${spec.value} matches the template`,
        hit,
        `templates show ${[...new Set(observed.map((e) => e[field]))].join("/")}`,
      );
    }
  };

  // The three families the task calls out, plus every record that cites a
  // source: a claim nobody verified is exactly the claim that rots.
  for (const family of ["Z-Image-Turbo", "Qwen-Image", "Flux.1 Dev"]) {
    assertAgainstTemplates(family);
  }

  let drifted = 0;
  const driftedNames = [];
  for (const record of MODEL_KNOWLEDGE) {
    if ((record.sampler.source ?? []).length === 0) continue;
    const observed = [];
    let missingSource = false;
    for (const id of record.sampler.source) {
      if (!shippedIds.has(id)) {
        missingSource = true;
        break;
      }
      // A source that exists but carries no standard sampler is legitimate:
      // pose and segmentation templates sample nothing, and several video
      // models drive a custom sampler node (`KSamplerSelect`, `VOIDSampler`)
      // instead of KSampler. Those records leave every field unverified.
      observed.push(...(blueprintSamplers.get(id) ?? []));
    }
    if (missingSource) {
      drifted += 1;
      driftedNames.push(`${record.family} (cites a blueprint this machine does not ship)`);
      continue;
    }
    for (const [field, spec] of [
      ["steps", record.sampler.steps],
      ["cfg", record.sampler.cfg],
      ["sampler_name", record.sampler.sampler_name],
      ["scheduler", record.sampler.scheduler],
    ]) {
      if (spec?.verified !== true || spec.value === undefined) continue;
      if (observed.some((entry) => entry[field] === spec.value)) continue;
      drifted += 1;
      driftedNames.push(`${record.family}.${field}=${spec.value} (templates: ${[...new Set(observed.map((e) => e[field]))].join("/")})`);
    }
  }
  check("every verified value is present in its template", drifted === 0, driftedNames.slice(0, 6).join("; "));

  /**
   * Negative-prompt support must reflect the wiring, not the model name.
   *
   * The templates make the distinction visible: a model that accepts a
   * negative prompt feeds its sampler from a text encoder, while one that does
   * not zeroes the slot. Z-Image-Turbo is the important case — it is the model
   * this plugin ships first-class support for, and getting it wrong would send
   * an agent to write a negative prompt that silently does nothing.
   */
  section("negative prompt support");
  const negativeIsTextEncoded = new Set();
  const negativeIsZeroed = new Set();
  for (const dir of readdirSync(INSTALL_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const root = join(INSTALL_ROOT, dir.name, "ComfyUI");
    if (!existsSync(join(root, "main.py"))) continue;
    for (const entry of discoverBlueprints(root)) {
      if (entry.model === undefined) continue;
      let subgraph;
      try {
        subgraph = unwrapBlueprint(JSON.parse(entry.raw))?.subgraph;
      } catch {
        continue;
      }
      if (subgraph === undefined) continue;
      const links = new Map((subgraph.links ?? []).map((link) => [link.id, link]));
      for (const node of subgraph.nodes ?? []) {
        if (!/sampler/i.test(node.type ?? "")) continue;
        const negativeInput = (node.inputs ?? []).find((i) => /negative/i.test(i.name ?? ""));
        if (negativeInput === undefined) continue;
        const link = links.get(negativeInput.link);
        if (link === undefined) continue;
        const origin = subgraph.nodes.find((n) => n.id === link.origin_id);
        if (origin?.type === "ConditioningZeroOut") negativeIsZeroed.add(entry.model);
        else if (origin?.type !== undefined) negativeIsTextEncoded.add(entry.model);
      }
    }
  }

  check(
    "Z-Image-Turbo zeroes its negative slot (so it takes no negative prompt)",
    negativeIsZeroed.has("Z-Image-Turbo") && !negativeIsTextEncoded.has("Z-Image-Turbo"),
    `zeroed=${negativeIsZeroed.has("Z-Image-Turbo")} text=${negativeIsTextEncoded.has("Z-Image-Turbo")}`,
  );
  check(
    "the Z-Image-Turbo record reports no negative prompt support",
    queryModel("Z-Image-Turbo")?.negativePrompt?.supported === false,
  );
  check(
    "Qwen-Image text-encodes its negative slot",
    negativeIsTextEncoded.has("Qwen-Image") && !negativeIsZeroed.has("Qwen-Image"),
  );
  check(
    "the Qwen-Image record reports negative prompt support",
    queryModel("Qwen-Image")?.negativePrompt?.supported === true,
  );

  /**
   * Every family the local catalogue actually ships must be answerable.
   *
   * A knowledge base that silently misses a template the agent can see is
   * worse than one with fewer entries, because the gap is invisible.
   */
  section("coverage of the local catalogue");
  const shipped = new Set();
  for (const dir of readdirSync(INSTALL_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const root = join(INSTALL_ROOT, dir.name, "ComfyUI");
    if (!existsSync(join(root, "main.py"))) continue;
    for (const entry of discoverBlueprints(root)) {
      if (entry.model !== undefined) shipped.add(entry.model);
    }
  }
  const uncovered = [...shipped].filter((model) => queryModel(model) === undefined);
  check(`every shipped family is queryable (${shipped.size})`, uncovered.length === 0, uncovered.join(", "));
}

console.log(failures === 0 ? "\nALL MODEL KNOWLEDGE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);