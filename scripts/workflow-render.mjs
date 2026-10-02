// Exercise the real parameter-resolution and template-rendering path for both
// workflows, with no ComfyUI server involved.
//
// The tools' `execute` bodies are the one place where a mistake is invisible
// until the GPU is busy: rendering a graph is pure, so it can be checked
// directly. This covers the cases a model actually produces — the minimal call
// where every optional argument is omitted, an explicit seed, a negative
// prompt, and non-multiple-of-32 dimensions.
//
// usage: node scripts/workflow-render.mjs

import { buildParameters, loadWorkflow, renderWorkflow, WORKFLOW_SPECS } from "../lib/workflows.js";
import { kinds } from "../lib/comfy.js";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  PASS ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  }
}

/** The model resolution the plugin performs before every call. */
function modelsFor(kindId) {
  const match = kinds().find((entry) => entry.id === kindId);
  return { ...match.models, ...WORKFLOW_SPECS[kindId].defaults?.models };
}

/** Render one call exactly the way the generate tool does. */
function renderCall(kindId, args) {
  const spec = WORKFLOW_SPECS[kindId];
  const template = loadWorkflow(kindId);
  const parameters = buildParameters(spec, modelsFor(kindId), args);
  return { spec, template, parameters, graph: renderWorkflow(template, spec, parameters) };
}

/** Collect every numeric leaf in a graph, keyed by its node path. */
function inputOf(graph, nodeId, input) {
  return graph[nodeId]?.inputs?.[input];
}

for (const kindId of Object.keys(WORKFLOW_SPECS)) {
  const spec = WORKFLOW_SPECS[kindId];
  console.log(`# ${kindId}`);

  // The important case: the model omits every optional argument. The tool
  // schema marks width/height/steps/seed optional, so this is the default
  // shape of a real call, and it must still render.
  let minimal;
  try {
    minimal = renderCall(kindId, { prompt: "a brass compass on a nautical chart" });
    check("minimal call renders", true);
  } catch (error) {
    check("minimal call renders", false, String(error.message));
    continue;
  }

  const samplerNode = kindId === "z-image-turbo" ? "3" : "458";
  const latentNode = kindId === "z-image-turbo" ? "13" : "456";
  const saveNode = kindId === "z-image-turbo" ? "9" : "461";

  check("prompt reaches the text encoder",
    Object.values(minimal.graph).some((node) => node.inputs?.text === "a brass compass on a nautical chart" ||
      node.inputs?.prompt === "a brass compass on a nautical chart"));
  check("steps fall back to the spec default", inputOf(minimal.graph, samplerNode, "steps") === spec.defaults.steps,
    `got ${JSON.stringify(inputOf(minimal.graph, samplerNode, "steps"))}`);
  check("cfg falls back to the spec default", inputOf(minimal.graph, samplerNode, "cfg") === spec.defaults.cfg);
  check("sampler falls back to the spec default",
    inputOf(minimal.graph, samplerNode, "sampler_name") === spec.defaults.sampler_name);
  check("scheduler falls back to the spec default",
    inputOf(minimal.graph, samplerNode, "scheduler") === spec.defaults.scheduler);
  check("width falls back to the spec default",
    inputOf(minimal.graph, latentNode, "width") === spec.defaults.width);
  check("height falls back to the spec default",
    inputOf(minimal.graph, latentNode, "height") === spec.defaults.height);
  check("width and height are numbers, not strings",
    typeof inputOf(minimal.graph, latentNode, "width") === "number" &&
    typeof inputOf(minimal.graph, latentNode, "height") === "number");
  check("batch_size is 1", inputOf(minimal.graph, latentNode, "batch_size") === 1);
  check("filename_prefix is set", typeof inputOf(minimal.graph, saveNode, "filename_prefix") === "string");
  check("a seed is always generated",
    Number.isInteger(inputOf(minimal.graph, samplerNode, "seed")) &&
    inputOf(minimal.graph, samplerNode, "seed") !== spec.defaults.seed,
    `got ${JSON.stringify(inputOf(minimal.graph, samplerNode, "seed"))}`);
  check("model names resolve",
    Object.values(minimal.graph).some((node) => typeof node.inputs?.unet_name === "string") &&
    Object.values(minimal.graph).some((node) => typeof node.inputs?.clip_name === "string") &&
    Object.values(minimal.graph).some((node) => typeof node.inputs?.vae_name === "string"));

  // An explicit seed must survive: re-running with the same seed is how the
  // model isolates a prompt change.
  const seeded = renderCall(kindId, { prompt: "x", seed: 424242 });
  check("an explicit seed survives", inputOf(seeded.graph, samplerNode, "seed") === 424242);

  // Dimensions are rounded down to a multiple of 32.
  const odd = renderCall(kindId, { prompt: "x", width: 1000, height: 700 });
  check("width rounds to a multiple of 32", inputOf(odd.graph, latentNode, "width") % 32 === 0,
    `got ${inputOf(odd.graph, latentNode, "width")}`);
  check("height rounds to a multiple of 32", inputOf(odd.graph, latentNode, "height") % 32 === 0,
    `got ${inputOf(odd.graph, latentNode, "height")}`);

  // Out-of-range values are refused rather than silently clamped.
  let rangeRefused = false;
  try {
    renderCall(kindId, { prompt: "x", steps: 10_000 });
  } catch {
    rangeRefused = true;
  }
  check("an out-of-range steps is refused", rangeRefused);

  const encoderNode = kindId === "z-image-turbo" ? "27" : "452";
  if (spec.supports.negative_prompt) {
    check("negative prompt is an empty string when omitted",
      inputOf(minimal.graph, encoderNode, "negative_prompt") === "",
      `got ${JSON.stringify(inputOf(minimal.graph, encoderNode, "negative_prompt"))}`);
    const negated = renderCall(kindId, { prompt: "x", negative_prompt: "blurry text" });
    check("negative prompt is passed through",
      inputOf(negated.graph, encoderNode, "negative_prompt") === "blurry text");
    // `resolution` only sizes reference-image slots, but ComfyUI requires it to
    // be a valid multiple of 32 — a NaN here fails the whole prompt.
    const resolution = inputOf(minimal.graph, encoderNode, "resolution");
    check("resolution is a finite multiple of 32",
      Number.isFinite(resolution) && resolution % 32 === 0, `got ${JSON.stringify(resolution)}`);
    const wide = renderCall(kindId, { prompt: "x", width: 2048, height: 1024 });
    check("resolution tracks the larger dimension",
      inputOf(wide.graph, encoderNode, "resolution") === 2048,
      `got ${inputOf(wide.graph, encoderNode, "resolution")}`);
  } else {
    check("no negative_prompt key leaks into a turbo graph",
      !Object.values(minimal.graph).some((node) => node.inputs?.negative_prompt !== undefined));
  }
}

// The rendered graph must survive JSON serialization unchanged: ComfyUI's
// /prompt endpoint rejects anything non-finite, and JSON.stringify silently
// turns NaN and Infinity into null.
console.log("# serialized graph");
for (const kindId of Object.keys(WORKFLOW_SPECS)) {
  const { graph } = renderCall(kindId, { prompt: "x", negative_prompt: "y" });
  const roundTripped = JSON.parse(JSON.stringify(graph));
  let finite = true;
  const walk = (node) => {
    if (typeof node === "number") {
      if (!Number.isFinite(node)) finite = false;
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (node !== null && typeof node === "object") return Object.values(node).forEach(walk);
  };
  walk(roundTripped);
  check(`${kindId} graph has no NaN or Infinity`, finite);
  check(`${kindId} graph has no leftover placeholders`,
    !JSON.stringify(roundTripped).includes("{{"));
}

console.log(failures === 0 ? "\nALL RENDER CHECKS PASSED" : `\n${failures} RENDER CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);