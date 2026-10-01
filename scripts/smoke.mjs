// Standalone smoke test for the plugin's own logic (no DSH host required).
// usage: node scripts/smoke.mjs

import { ComfyInstance, discoverInstallations, getJson, kinds } from "../lib/comfy.js";
import { describeKind, generate, saveImageTo } from "../lib/generate.js";
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

console.log("# live probe of an already-running ComfyUI");
const probe = new ComfyInstance(discoverInstallations("z-image-turbo")[0], 8188);
const stats = await probe.probe(undefined);
check("port 8188 answered /system_stats", stats !== undefined);
if (stats !== undefined) {
  console.log("  device:", stats?.devices?.[0]?.name ?? "?");
  console.log("  comfy version:", stats?.system?.comfyui_version ?? "?");
}
const models = await getJson("http://127.0.0.1:8188/models/diffusion_models", 15000, undefined).catch((error) => {
  console.log("  models endpoint error:", error.name, error.message, error.cause?.message ?? "");
  return undefined;
});
check("models endpoint reachable", models !== undefined);
if (models !== undefined) console.log("  diffusion models:", JSON.stringify(models).slice(0, 200));

console.log("# live generation through the plugin's own code path");
const zKind = discoverInstallations("z-image-turbo")[0];
const zResult = await generate({
  kindId: "z-image-turbo",
  spec: WORKFLOW_SPECS["z-image-turbo"],
  template: loadWorkflow("z-image-turbo"),
  parameters: {
    ...WORKFLOW_SPECS["z-image-turbo"].defaults,
    ...kinds().find((k) => k.id === "z-image-turbo").models,
    prompt: "a small green plant in a terracotta pot, soft window light, photograph",
    width: 1024,
    height: 1024,
    batch_size: 1,
    seed: 1234,
    filename_prefix: "plugin-smoke",
  },
  models: kinds().find((k) => k.id === "z-image-turbo").models,
});
check("live generation produced an image", zResult.images.length > 0);
console.log(`  prompt_id=${zResult.promptId} elapsed=${zResult.elapsedMs}ms`);
console.log(`  image=${zResult.images[0].filename}`);
const written = await saveImageTo(zResult.images[0], "E:/agent project/dsh-comfyui-image/.smoke-out/plugin-smoke.png");
check("image copied to disk", written.bytes > 0, String(written.bytes));
console.log(`  saved ${written.path} (${written.bytes} bytes)`);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);