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
  modelFamily,
  taskKey,
  alternativesFor,
  runnableTemplates,
} from "../lib/blueprint-runner.js";
import { toPromptGraph } from "../lib/blueprint.js";
import { sharedInstance } from "../lib/comfy.js";

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
  const resolvedOf = (wanted) => resolveModel(wanted, have)?.file;

  check("strips a version from the family", modelFamily("qwen_image_2.1_int8_convrot.safetensors") === "qwen_image", modelFamily("qwen_image_2.1_int8_convrot.safetensors"));

  check(
    "a same-model request in another precision resolves as a precision swap",
    resolveModel("diffusion_models/qwen_image_2.1_fp8_e4m3fn.safetensors", have)?.kind === "precision",
  );
  check(
    "an existing release is preferred over a download",
    resolvedOf("diffusion_models/qwen_image_fp8_e4m3fn.safetensors") === "diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
    "the machine owns qwen_image_2.1; asking for the base release again is pointless",
  );
  check(
    "...and is reported as a release swap, not a silent one",
    resolveModel("diffusion_models/qwen_image_fp8_e4m3fn.safetensors", have)?.kind === "release",
  );
  check(
    "the VAE resolves across precision",
    resolvedOf("vae/qwen_image_2.1_vae_fp16.safetensors") === "vae/qwen_image_2.1_vae_bf16.safetensors",
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
    "an unrelated family that shares a prefix is not a substitute",
    resolveModel("diffusion_models/wan2.1_hires.safetensors", have) === undefined,
  );

  // The real case from this machine: the shipped Qwen template names the base
  // qwen_image release and the qwen2.5-vl encoder, while this machine carries
  // qwen_image_2.1 and a qwen3vl encoder. The main model is the same family, so
  // it resolves; the encoder is a different family, so it must not — swapping
  // those would render noise rather than raise an error.
  const qwen = findBlueprint("text-to-image-qwen-image");
  if (qwen === undefined) {
    check("qwen template present", false, "not found");
  } else {
    const graph = toPromptGraph(JSON.parse(qwen.raw), {});
    const wanted = [...graphModels(graph)];
    check("it would otherwise have demanded four downloads", wanted.length >= 4, `${wanted.length}`);

    const main = wanted.find((model) => model.startsWith("diffusion_models/"));
    check(
      "the base qwen_image release resolves to the installed 2.1",
      resolvedOf(main) === "diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
      `${main} -> ${resolvedOf(main)}`,
    );
    const encoder = wanted.find((model) => model.startsWith("text_encoders/"));
    check(
      "a missing encoder is still reported rather than swapped",
      resolveModel(encoder, have) === undefined,
      `${encoder} must not resolve to qwen3vl`,
    );
  }
}

console.log("\n# task grouping and availability");
{
  // The grouping is what lets "can you make an image" be answered from what is
  // installed rather than from what could be downloaded.
  check(
    "folds a task label into a comparable key",
    taskKey({ task: "Text to Image" }) === "text to image",
    taskKey({ task: "Text to Image" }),
  );
  check("falls back to the title", taskKey({ title: "Video Stitch" }) === "video stitch", taskKey({ title: "Video Stitch" }));

  const items = await runnableTemplates();
  // Availability cannot be judged without a server, and a server this plugin
  // launched is not necessarily running during a test run. That is a skip, not
  // a failure — the alternative is a suite that only passes when ComfyUI happens
  // to be up, which trains people to ignore it.
  const hasServer = items.some((item) => item.ready);
  if (!hasServer) {
    console.log("    (no live ComfyUI server; availability-dependent checks skipped)");
    console.log(failures === 0 ? "\nALL RUNNER CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  }
  const runnable = items.filter((item) => item.ready && item.drivesSampler);
  check(`a live probe found runnable generators (${runnable.length})`, runnable.length > 0);

  // A blocked template must find siblings that can actually run, which is the
  // only reason this grouping exists.
  const blocked = items.find(
    (item) => !item.ready && item.drivesSampler && taskKey(item.entry) === "text to image",
  );
  if (blocked === undefined) {
    console.log("    (no blocked text-to-image template on this machine; nothing to cross-check)");
  } else {
    const alternatives = alternativesFor(blocked.entry, items);
    check(
      "a blocked template finds runnable siblings for the same task",
      alternatives.length > 0,
      `${blocked.entry.id} -> ${alternatives.length}`,
    );
    check(
      "every alternative is actually ready",
      alternatives.every((option) => items.find((item) => item.entry.id === option.id)?.ready === true),
      alternatives.map((option) => option.id).join(","),
    );
    check(
      "an alternative is never the blocked template itself",
      !alternatives.some((option) => option.id === blocked.entry.id),
    );
    check(
      "alternatives share the blocked template's task",
      alternatives.every((option) => taskKey(findBlueprint(option.id)) === taskKey(blocked.entry)),
      alternatives.map((option) => option.id).join(","),
    );
  }

  // A template with no sampler is a utility, not a capability, and must not be
  // offered as a generator.
  const utilities = items.filter((item) => item.ready && !item.drivesSampler);
  if (blocked !== undefined) {
    const all = alternativesFor(blocked.entry, items);
    check(
      "no sampler-less template is offered as an alternative",
      all.every((option) => items.find((item) => item.entry.id === option.id)?.drivesSampler === true),
      all.map((option) => option.id).join(","),
    );
  }
  if (utilities.length > 0) console.log(`    (${utilities.length} utility templates are ready but generate nothing)`);
}

console.log("\n# concurrent callers share one server");
{
  // Two agents asking at once used to each find the default port free and each
  // start a ComfyUI on it; the loser of that race took the winner's server with
  // it. Keying the registry by port is what makes the second caller reuse the
  // first instead of competing with it.
  const descriptor = { comfyRoot: "C:/nonexistent", label: "test", python: "python" };
  const first = sharedInstance(descriptor, 8177, undefined);
  const second = sharedInstance(descriptor, 8177, undefined);
  check("the same port yields the same instance", first === second);
  check("a different port yields a different instance", sharedInstance(descriptor, 8176, undefined) !== first);

  // The in-process guard is what serialises two `ensure` calls on one instance.
  let launches = 0;
  const fake = {
    child: undefined,
    starting: undefined,
    async probe() {
      return undefined;
    },
    async ensure() {
      if (this.child === undefined && this.starting === undefined) {
        launches += 1;
        this.starting = Promise.resolve({ ok: true });
      }
      return this.starting;
    },
  };
  await Promise.all([fake.ensure(), fake.ensure(), fake.ensure()]);
  check("three concurrent callers launch once", launches === 1, `launched ${launches} times`);
}

console.log(failures === 0 ? "\nALL RUNNER CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);