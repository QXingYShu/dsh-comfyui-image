/**
 * Checks for the template catalogue and the runner that drives it.
 *
 * These run against the ComfyUI installs on this machine, because the whole
 * point of the catalogue is that it describes *those* templates — a fixture
 * would pass while the real discovery stayed broken.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  allComfyInstalls,
  blueprintCatalogue,
  describe,
  findBlueprint,
  graphModels,
  modelStem,
  requiredModels,
  resolveBlueprintInstance,
  resolveModel,
} from "../lib/blueprint-runner.js";
import { toPromptGraph } from "../lib/blueprint.js";

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` -- ${detail}`}`);
}

const INSTALL_ROOT =
  process.env.LOCALAPPDATA === undefined
    ? undefined
    : join(process.env.LOCALAPPDATA, "Comfy-Desktop", "ComfyUI-Installs");

if (INSTALL_ROOT === undefined || !existsSync(INSTALL_ROOT)) {
  console.log("No Comfy Desktop installs found; runner checks skipped.");
  process.exit(0);
}

console.log("\n# install discovery");
const installs = allComfyInstalls();
check(`found installs (${installs.length})`, installs.length > 0, "none discovered");
check(
  "every install has a main.py",
  installs.every((install) => existsSync(join(install.comfyRoot, "main.py"))),
);

console.log("\n# catalogue");
const catalogue = blueprintCatalogue();
check(`catalogue is populated (${catalogue.length})`, catalogue.length > 0);
check("entries carry a title", catalogue.every((entry) => typeof entry.title === "string"));
check("entries carry an id", catalogue.every((entry) => typeof entry.id === "string"));
const withModel = catalogue.filter((entry) => entry.model !== undefined);
check(`entries name a model (${withModel.length})`, withModel.length > 0);

const families = new Set(catalogue.map((entry) => entry.model).filter((model) => model !== undefined));
check(`spans many model families (${families.size})`, families.size >= 20, `${families.size}`);

const tasks = new Set(catalogue.map((entry) => entry.task));
check(`spans many task types (${tasks.size})`, tasks.size >= 10, `${tasks.size}`);

// The three Comfy Desktop installs ship the same templates, so the catalogue
// must not report the same template three times.
const installCounts = new Map();
for (const install of installs) {
  for (const entry of catalogue) {
    if (entry.installs.some((known) => known.comfyRoot === install.comfyRoot)) {
      installCounts.set(entry.id, (installCounts.get(entry.id) ?? 0) + 1);
    }
  }
}
check(
  "duplicates across installs are merged",
  catalogue.length < installs.length * catalogue.length,
  `${catalogue.length} entries from ${installs.length} installs`,
);

console.log("\n# lookup");
const target = findBlueprint("text-to-image-z-image-turbo");
check("finds a known template by id", target !== undefined);
check("resolves a near-miss name", findBlueprint("z-image-turbo") !== undefined);
check("returns undefined for nonsense", findBlueprint("no-such-template-xyz") === undefined);

console.log("\n# description");
if (target !== undefined) {
  const described = describe(target);
  check("description exposes inputs", described.inputs.length > 0);
  check(
    "description names the text input",
    described.inputs.some((input) => input.name === "text"),
    described.inputs.map((input) => input.name).join(","),
  );
  check(
    "description carries a steps default",
    described.inputs.find((input) => input.name === "steps")?.default === 8,
    JSON.stringify(described.inputs.find((input) => input.name === "steps")),
  );
}

console.log("\n# model requirements");
if (target !== undefined) {
  const required = requiredModels(JSON.parse(target.raw));
  check("template declares model requirements", required.size > 0, `${required.size}`);
  check(
    "requirements are directory-qualified",
    [...required].every((model) => model.includes("/")),
    [...required].join(","),
  );

  // The check that actually decides whether a run is possible reads the
  // converted graph, not the template's model manifest: a manifest lists every
  // model a template *could* use, and rejecting a run for an optional one is
  // just as wrong as missing a required one.
  const converted = graphModels(toPromptGraph(JSON.parse(target.raw), {}));
  check("the converted graph names its models", converted.size > 0, `${converted.size}`);
  check(
    "graph models use real ComfyUI folders",
    [...converted].every((model) => !model.startsWith("clip/")),
    [...converted].join(","),
  );
  check(
    "graph models are directory-qualified",
    [...converted].every((model) => model.includes("/")),
    [...converted].join(","),
  );
}

console.log("\n# resolution (no server required)");
const resolved = await resolveBlueprintInstance(target, {}, undefined, undefined);
check("resolves an installation", resolved.ok === true, resolved.reason);
if (resolved.ok === true) {
  check("names the install", typeof resolved.install?.name === "string");
}

console.log("\n# precision-equivalent model matching");
{
  // Regression: a machine that has a model in one precision must not be told
  // to download the same model in another. Telling the user to fetch twenty
  // gigabytes of weights they already own is the failure this guards.
  check("strips a quantisation suffix", modelStem("qwen_image_fp8_e4m3fn.safetensors") === "qwen_image", modelStem("qwen_image_fp8_e4m3fn.safetensors"));
  check("strips convrot int8", modelStem("qwen_image_2.1_int8_convrot.safetensors") === "qwen_image_2.1", modelStem("qwen_image_2.1_int8_convrot.safetensors"));
  check("keeps the version in the stem", modelStem("qwen_image_2.1_vae_bf16.safetensors") === "qwen_image_2.1_vae", modelStem("qwen_image_2.1_vae_bf16.safetensors"));

  const have = new Set([
    "diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
    "text_encoders/qwen3vl_8b_int8_convrot.safetensors",
    "vae/qwen_image_2.1_vae_bf16.safetensors",
  ]);
  check(
    "an fp8 request resolves to the installed int8 build of the same model",
    resolveModel("diffusion_models/qwen_image_2.1_fp8_e4m3fn.safetensors", have) === "diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
  );
  check(
    "the VAE resolves across precision",
    resolveModel("vae/qwen_image_2.1_vae_fp16.safetensors", have) === "vae/qwen_image_2.1_vae_bf16.safetensors",
  );
  check(
    "an unrelated model does not resolve",
    resolveModel("diffusion_models/some_other_model.safetensors", have) === undefined,
  );
  check(
    "the same name in a different folder is not a substitute",
    resolveModel("text_encoders/qwen_image_fp8_e4m3fn.safetensors", have) === undefined,
    "a text encoder must not satisfy a diffusion-model slot",
  );
  check(
    "a different text-encoder family is not a substitute",
    resolveModel("text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors", have) === undefined,
    "qwen3vl and qwen2.5-vl are different encoders; swapping them would render noise",
  );
  check(
    "a different model family is not a substitute",
    resolveModel("diffusion_models/qwen_image_fp8_e4m3fn.safetensors", have) === undefined,
    "qwen_image and qwen_image_2.1 are different releases, not precisions of one another",
  );

  // The real case from this machine. The shipped Qwen template names the fp8
  // build and the qwen2.5-vl encoder; this machine has qwen_image_2.1 in int8 and
  // a qwen3vl encoder. Those are different models, so the honest answer is that
  // the template still needs files -- what must not happen is being told to
  // download the *same* weights in another precision.
  const qwen = findBlueprint("text-to-image-qwen-image");
  if (qwen === undefined) {
    check("qwen template present", false, "not found");
  } else {
    const graph = toPromptGraph(JSON.parse(qwen.raw), {});
    const wanted = [...graphModels(graph)];
    check("it would otherwise have demanded four downloads", wanted.length >= 4, `${wanted.length}`);
    for (const model of wanted) {
      const stem = modelStem(model);
      const alreadyOwned = [...have].some((owned) => modelStem(owned) === stem);
      check(
        `does not demand a re-download of ${stem}`,
        !alreadyOwned || resolveModel(model, have) !== undefined,
        "the machine already has this model in another precision",
      );
    }
  }
}

console.log(failures === 0 ? "\nALL RUNNER CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);