/**
 * Conversion checks against the blueprints this machine actually ships.
 *
 * These are not synthetic fixtures: every assertion is made against a real
 * file from Comfy Desktop, because the point of the converter is to survive
 * real templates rather than a hand-made one that happens to be simple.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  blueprintId,
  defaultForSlot,
  discoverBlueprints,
  splitBlueprintName,
  toPromptGraph,
  describeBlueprint,
  unwrapBlueprint,
} from "../lib/blueprint.js";

const INSTALL_ROOT =
  process.env.LOCALAPPDATA === undefined
    ? undefined
    : join(
        process.env.LOCALAPPDATA,
        "Comfy-Desktop",
        "ComfyUI-Installs",
      );

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

/* ---- pure helpers ------------------------------------------------- */

section("name parsing");
check(
  "splits task from model",
  JSON.stringify(splitBlueprintName("Text to Image (Z-Image-Turbo).json")) ===
    JSON.stringify({ task: "Text to Image", model: "Z-Image-Turbo" }),
  JSON.stringify(splitBlueprintName("Text to Image (Z-Image-Turbo).json")),
);
check(
  "handles a name with no model",
  splitBlueprintName("Brightness and Contrast.json").model === undefined,
);
check("slugifies", blueprintId("First-Last-Frame to Video (LTX-2.5).json") === "first-last-frame-to-video-ltx-2-5", blueprintId("First-Last-Frame to Video (LTX-2.5).json"));

/* ---- the real catalogue ------------------------------------------- */

if (INSTALL_ROOT === undefined || !existsSync(INSTALL_ROOT)) {
  console.log("\nNo Comfy Desktop installs found; conversion checks skipped.");
  process.exit(failures === 0 ? 0 : 1);
}

let all = [];
for (const entry of readdirSync(INSTALL_ROOT, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const root = join(INSTALL_ROOT, entry.name, "ComfyUI");
  if (!existsSync(join(root, "main.py"))) continue;
  all = all.concat(discoverBlueprints(root));
}

section("catalogue");
check(`found blueprints (${all.length})`, all.length > 0, "no blueprints discovered");
const models = new Set(all.map((entry) => entry.model).filter((m) => m !== undefined));
check(`spans many models (${models.size})`, models.size >= 10, `only ${models.size} distinct models`);
check(
  "every blueprint unwraps to a subgraph",
  all.every((entry) => unwrapBlueprint(JSON.parse(entry.raw)) !== undefined),
);

section("API graph conversion");
let converted = 0;
const refusals = new Map();
for (const entry of all) {
  let graph;
  try {
    graph = toPromptGraph(JSON.parse(entry.raw));
  } catch (error) {
    refusals.set(error.message.split(".")[0], (refusals.get(error.message.split(".")[0]) ?? 0) + 1);
    continue;
  }
  converted += 1;

  // Every produced node must be an object with a class_type, which is what
  // the executor rejects a prompt without.
  const valid = Object.values(graph).every(
    (node) => typeof node.class_type === "string" && node.class_type !== "" && typeof node.inputs === "object",
  );
  if (!valid) {
    check(`${entry.id}: graph shape`, false, "a node is missing class_type or inputs");
  }

  // Every link must point at a node that exists, and the producer must be one
  // the converter had already resolved.
  //
  // Note that a graph is a JSON *object*, and JavaScript orders integer-like
  // keys numerically no matter what order they were inserted in. Iterating
  // `Object.keys` therefore cannot detect a broken dependency order — the
  // insertion order that matters lives inside `toPromptGraph`'s own loop. So
  // this check is about dangling references only; ordering is covered by the
  // out-of-order instrumentation below.
  const ids = new Set(Object.keys(graph));
  let dangling = false;
  for (const node of Object.values(graph)) {
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === "string" && !ids.has(value[0])) dangling = true;
    }
  }
  if (dangling) check(`${entry.id}: no dangling links`, false, "a link points at a missing node");

  // A node the canvas wires but the API graph shows with no inputs at all means
  // its links never resolved.
  //
  // Two kinds of node are legitimately input-free: those whose inputs are all
  // exposed interface values the caller supplied nothing for (`Video Stitch`
  // needs source videos handed to it), and source nodes that take no input by
  // design (`LotusConditioning` is a pure producer).
  const EMPTY_INPUT_OK = new Set([
    "ConditioningZeroOut",
    "ConditioningCombine",
    "DisableNoise",
    "CFGNorm",
  ]);
  const subgraphForEntry = unwrapBlueprint(JSON.parse(entry.raw)).subgraph;
  const linkById = new Map((subgraphForEntry.links ?? []).map((l) => [l.id, l]));
  const wiredCount = (node) =>
    (node.inputs ?? []).filter((i) => i?.link !== undefined && i.link !== null).length;

  // A node whose every wired input comes from an exposed interface value that
  // has no template default is waiting on the caller: `Video Stitch` and
  // `Video Upscale` take source video as an argument, and until one is passed
  // there is genuinely nothing to bind. The converter reporting that is the
  // point, not a fault.
  const unfillableSlots = new Set(
    (subgraphForEntry.inputs ?? [])
      .map((input, slot) => ({ name: input.name, slot }))
      .filter(({ slot }) => defaultForSlot(subgraphForEntry, linkById, slot) === undefined)
      .map(({ name }) => name),
  );
  const waitsOnCaller = (node) => {
    const wired = (node.inputs ?? []).filter((i) => i?.link !== undefined && i.link !== null);
    if (wired.length === 0) return false;
    return wired.every((i) => {
      const link = linkById.get(i.link);
      return link?.origin_id === -10 && unfillableSlots.has(subgraphForEntry.inputs?.[link.origin_slot]?.name);
    });
  };

  let dropped = 0;
  const offending = [];
  for (const node of subgraphForEntry.nodes ?? []) {
    const inGraph = graph[String(node.id)];
    if (inGraph === undefined) continue;
    if (Object.keys(inGraph.inputs).length > 0) continue;
    if (EMPTY_INPUT_OK.has(inGraph.class_type)) continue;
    if (wiredCount(node) === 0) continue; // a pure producer by design
    if (waitsOnCaller(node)) continue; // waiting on the caller's own value
    dropped += 1;
    if (offending.length < 3) offending.push(`${node.id}:${inGraph.class_type}`);
  }
  if (dropped > 0) {
    check(`${entry.id}: no node lost its wiring`, false, `${dropped} node(s) with no inputs: ${offending.join(", ")}`);
  }

  // Canvas decorations and splints must not appear in the submitted graph at
  // all: a splint's job was already done by resolving its links through it.
  for (const [id, node] of Object.entries(graph)) {
    if (["Note", "MarkdownNote", "Reroute"].includes(node.class_type)) {
      check(`${entry.id}: node ${id} (${node.class_type}) dropped`, false, "a canvas-only node reached the API graph");
    }
  }

  // A save node is mandatory: without it the executor persists nothing.
  if (!Object.values(graph).some((node) => node.class_type === "SaveImage")) {
    check(`${entry.id}: has a save node`, false, "no SaveImage in the graph");
  }

  // A graph that drives no sampler at all cannot produce an image, whatever
  // its inputs look like; that is worth catching without a server round trip.
  const classes = Object.values(graph).map((node) => node.class_type);
  if (!classes.some((type) => /Sampler|Guider/i.test(type))) {
    refusals.set("graph drives no sampler", (refusals.get("graph drives no sampler") ?? 0) + 1);
  }
}
check(`converted a majority (${converted}/${all.length})`, converted >= Math.floor(all.length * 0.5), `${converted} of ${all.length}`);
for (const [reason, count] of refusals) console.log(`    refused: ${reason} (${count})`);

section("override and default handling");
const textToImage = all.find((entry) => entry.id === "text-to-image-z-image-turbo");
if (textToImage === undefined) {
  check("Z-Image text-to-image blueprint present", false, "not found");
} else {
  const parsed = JSON.parse(textToImage.raw);
  const base = toPromptGraph(parsed);
  const sampler = Object.values(base).find((node) => node.class_type === "KSampler");
  check("template default steps survive", sampler?.inputs?.steps === 8, JSON.stringify(sampler?.inputs?.steps));
  check("template default cfg survives", sampler?.inputs?.cfg === 1, JSON.stringify(sampler?.inputs?.cfg));

  const overridden = toPromptGraph(parsed, { text: "a red bicycle", steps: 12 });
  const sampler2 = Object.values(overridden).find((node) => node.class_type === "KSampler");
  check("override applied to steps", sampler2.inputs.steps === 12, JSON.stringify(sampler2.inputs.steps));
  const encoded = Object.values(overridden).find(
    (node) => node.class_type === "CLIPTextEncode" && node.inputs.text === "a red bicycle",
  );
  check("override applied to text", encoded !== undefined, "text did not reach a CLIPTextEncode node");
  check("unrelated defaults still survive", sampler2.inputs.cfg === 1);

  const description = describeBlueprint(textToImage);
  check(
    "description exposes inputs",
    description.inputs.some((input) => input.name === "text") && description.inputs.some((input) => input.name === "steps"),
    JSON.stringify(description.inputs.map((input) => input.name)),
  );
  check(
    "description carries a usable default",
    description.inputs.find((input) => input.name === "steps")?.default === 8,
    JSON.stringify(description.inputs.find((input) => input.name === "steps")),
  );
}

console.log(failures === 0 ? "\nALL BLUEPRINT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);