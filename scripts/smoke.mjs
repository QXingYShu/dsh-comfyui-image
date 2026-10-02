// Standalone smoke test for the plugin's own logic (no DSH host required).
// usage: node scripts/smoke.mjs

import { readFileSync } from "node:fs";
import { apply } from "../lib/index.js";
import { ComfyInstance, discoverInstallations, getJson, kinds } from "../lib/comfy.js";
import { describeKind } from "../lib/generate.js";
import { WORKFLOW_SPECS, loadWorkflow, renderWorkflow, roundTo32 } from "../lib/workflows.js";

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

console.log("# kinds()");
console.log(" ", JSON.stringify(kinds(), null, 2));

console.log("# discoverInstallations");
for (const kind of Object.keys(WORKFLOW_SPECS)) {
  const found = discoverInstallations(kind);
  console.log(`  ${kind}: ${found.length} installation(s)`);
  for (const installation of found) {
    console.log(`    - ${installation.label} @ ${installation.comfyRoot}`);
    console.log(`      python=${installation.python}`);
    console.log(`      extraModelPaths=${installation.extraModelPaths ?? "(none)"}`);
  }
  check(`${kind} discovers an install`, found.length > 0);
  check(`${kind} resolves a python`, found[0] !== undefined && found[0].python !== "");
}

console.log("# roundTo32");
for (const [input, expected] of [[1024, 1024], [1000, 992], [33, 32], [2049, 2048], [1, 32]]) {
  check(`roundTo32(${input}) === ${expected}`, roundTo32(input) === expected, String(roundTo32(input)));
}

console.log("# renderWorkflow");
const zSpec = WORKFLOW_SPECS["z-image-turbo"];
const zTemplate = loadWorkflow("z-image-turbo");
const zGraph = renderWorkflow(zTemplate, zSpec, {
  ...zSpec.defaults,
  ...kinds()[0].models,
  prompt: "a test prompt",
  width: 1024,
  height: 1024,
  batch_size: 1,
  seed: 7,
  filename_prefix: "smoke",
});
check("z-graph has 9 nodes", Object.keys(zGraph).length === 9, String(Object.keys(zGraph).length));
check("z-graph sampler got the seed", zGraph["3"].inputs.seed === 7, String(zGraph["3"].inputs.seed));
check("z-graph prompt substituted", zGraph["27"].inputs.text === "a test prompt");
check("z-graph has no placeholders left", !JSON.stringify(zGraph).includes("{{"));

const qSpec = WORKFLOW_SPECS["qwen-image-2.1"];
const qTemplate = loadWorkflow("qwen-image-2.1");
const qModels = kinds().find((k) => k.id === "qwen-image-2.1").models;
const qGraph = renderWorkflow(qTemplate, qSpec, {
  ...qSpec.defaults,
  ...qModels,
  prompt: "a test prompt",
  negative_prompt: "blurry",
  width: 1024,
  height: 1024,
  batch_size: 1,
  seed: 7,
  resolution: 1024,
  filename_prefix: "smoke",
});
check("q-graph has 8 nodes", Object.keys(qGraph).length === 8, String(Object.keys(qGraph).length));
check("q-graph kept format.bit_depth", qGraph["461"].inputs["format.bit_depth"] === "8-bit");
check("q-graph kept format.input_color_space", qGraph["461"].inputs["format.input_color_space"] === "sRGB");
check("q-graph negative prompt substituted", qGraph["452"].inputs.negative_prompt === "blurry");

console.log("# renderWorkflow error handling");
try {
  renderWorkflow(zTemplate, zSpec, { prompt: "x", width: 1, height: 1, batch_size: 1, seed: 1, steps: 1, sampler_name: "euler", scheduler: "simple", cfg: 1 });
  check("missing model params rejected", false, "no error thrown");
} catch (error) {
  check("missing model params rejected", /missing required/.test(String(error)), String(error));
}
try {
  renderWorkflow(zTemplate, zSpec, {
    ...zSpec.defaults, ...kinds()[0].models, prompt: "x", width: 1024, height: 1024,
    batch_size: 1, seed: 1, filename_prefix: "s", bogus_param: "nope",
  });
  check("unknown params rejected", false, "no error thrown");
} catch (error) {
  check("unknown params rejected", /unknown workflow parameters/.test(String(error)), String(error));
}
try {
  renderWorkflow(zTemplate, zSpec, {
    ...zSpec.defaults, ...kinds()[0].models, prompt: "x", width: 100000, height: 1024,
    batch_size: 1, seed: 1, filename_prefix: "s",
  });
  check("out-of-range width rejected", false, "no error thrown");
} catch (error) {
  check("out-of-range width rejected", /between/.test(String(error)), String(error));
}

console.log("# describeKind");
for (const kind of Object.keys(WORKFLOW_SPECS)) {
  console.log(" ", JSON.stringify(describeKind(kind)));
}

console.log("# probe an already-running ComfyUI");
// Informational, not a requirement: the plugin is expected to launch ComfyUI
// itself when nothing answers, so a server that is down here is a supported
// state, and the generation checks below are what actually have to pass.
const probe = new ComfyInstance(discoverInstallations("z-image-turbo")[0], 8188);
const stats = await probe.probe(undefined);
if (stats === undefined) {
  console.log("  8188 is not listening; the plugin will start ComfyUI itself below");
} else {
  console.log("  device:", stats?.devices?.[0]?.name ?? "?");
  console.log("  comfy version:", stats?.system?.comfyui_version ?? "?");
  const models = await getJson("http://127.0.0.1:8188/models/diffusion_models", 15000, undefined).catch((error) => {
    console.log("  models endpoint error:", error.name, error.message);
    return undefined;
  });
  if (models !== undefined) console.log("  diffusion models:", JSON.stringify(models).slice(0, 200));
}

console.log("# live generation through the registered tool");
// This drives `comfyui_generate`'s own `execute()` after `apply()`, so the whole
// production path is exercised: argument validation, `buildParameters`, graph
// rendering, the queue/poll/download loop, and the workspace copy. Calling
// `generate()` directly would skip the tool layer, which is exactly where the
// undefined-argument and ReferenceError defects lived.
//
// Arguments are deliberately minimal -- prompt and kind only, every optional
// argument omitted -- because that is the shape a model actually produces, and
// because a default-erasing bug only appears when an argument is left out.
const registered = new Map();
const dispose = apply({
  logger: { info() {}, warn() {}, error() {} },
  // Each register must return a disposer function, exactly as a real registry
  // does -- `Map.set()` would return the map and make teardown throw.
  tools: { register: (tool) => { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
  skills: { register: () => () => {} },
  on() {},
});
const comfyuiGenerate = registered.get("comfyui_generate");
check("apply() registered comfyui_generate", comfyuiGenerate !== undefined);

const OUT_DIR = "E:/agent project/dsh-comfyui-image/.smoke-out";
for (const [kindId, prompt] of [
  ["z-image-turbo", "a small green plant in a terracotta pot, soft window light, detailed photograph"],
  ["qwen-image-2.1", 'a minimalist poster reading "DEEP DIVE" in bold sans-serif capitals, screen-print texture'],
]) {
  const result = await comfyuiGenerate.execute(
    { prompt, kind: kindId, output_dir: OUT_DIR, seed: 1234 },
    {},
  );
  check(`${kindId} tool call succeeded`, result.ok === true, result.message);
  check(`${kindId} tool call produced an image`, result.images?.length === 1, JSON.stringify(result.images));
  console.log(`  kind=${result.kind} elapsed=${result.elapsed_ms}ms prompt_id=${result.prompt_id}`);
  console.log(`  saved ${result.images?.[0]?.path} (${result.images?.[0]?.bytes} bytes)`);

  // The file must actually be on disk and be a real PNG, not a zero-byte stub.
  const written = result.images?.[0];
  if (written !== undefined) {
    const bytes = readFileSync(written.path);
    check(`${kindId} image is a real PNG on disk`,
      bytes.length > 10_000 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      `${bytes.length} bytes`);
  }

  // The rendered text must survive the rendered form the model actually reads.
  const rendered = comfyuiGenerate.output.render({ prompt }, result);
  check(`${kindId} render names the saved file`, rendered[0].text.includes(written.path), rendered[0].text);
}

// An out-of-schema argument must still be refused before anything is queued.
let refused = false;
try {
  await comfyuiGenerate.execute({ prompt: "x", kind: "not-a-model" }, {});
} catch (error) {
  refused = error.name === "ToolArgsError";
}
check("the tool still refuses an unknown kind", refused);
dispose();

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);