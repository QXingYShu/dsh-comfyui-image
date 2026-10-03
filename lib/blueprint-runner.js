/**
 * Running a blueprint end to end.
 *
 * `lib/blueprint.js` turns a template into a graph; this module resolves which
 * ComfyUI installation should run it, hands the graph to the shared queue, and
 * copies the results into the workspace.
 *
 * Instance resolution differs from the two curated workflows on purpose. Those
 * know which install was set up for them, because their weights are a fixed
 * pair of files. A blueprint names its own models in `properties.models`, so
 * the right install is whichever one can actually see them — and on a machine
 * with several Comfy Desktop installs that is rarely the only candidate.
 */

import { ComfyInstance, delay, getJson, findExtraModelPaths, resolvePython } from "./comfy.js";
import { discoverBlueprints, describeBlueprint, toPromptGraph } from "./blueprint.js";
import { runGraph } from "./generate.js";
import { existsSync, readdirSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Ports probed in order, matching the curated workflows' behaviour. */
const DEFAULT_PORTS = [8188, 8189, 8190, 8191, 8192];

/** Live instances keyed by `${comfyRoot}:${port}`, reused across calls. */
const instances = new Map();

/**
 * Per-install blueprint lists, cached for the process lifetime.
 *
 * A Comfy Desktop install ships ~116 templates totalling about 5.5 MB; reading
 * and parsing all of them on every tool call would make listing a catalogue
 * cost seconds. The files do not change while ComfyUI runs, so one pass is
 * enough.
 */
const catalogueCache = new Map();

/** Blueprint ids present in an install, cached. */
function blueprintIds(comfyRoot) {
  let ids = catalogueCache.get(comfyRoot);
  if (ids === undefined) {
    ids = new Set(discoverBlueprints(comfyRoot).map((entry) => entry.id));
    catalogueCache.set(comfyRoot, ids);
  }
  return ids;
}

/**
 * Every ComfyUI checkout on this machine, with its blueprints.
 *
 * Unlike `discoverInstallations`, which filters by a known weight file, this
 * lists all of them: a blueprint carries its own model requirements, so the
 * filter belongs after the choice, not before it.
 */
export function allComfyInstalls() {
  const roots = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== undefined) {
    const installs = join(localAppData, "Comfy-Desktop", "ComfyUI-Installs");
    if (existsSync(installs)) {
      try {
        for (const entry of readdirSync(installs, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const comfyRoot = join(installs, entry.name, "ComfyUI");
          if (existsSync(join(comfyRoot, "main.py"))) {
            roots.push({ name: entry.name, comfyRoot, source: "comfy-desktop" });
          }
        }
      } catch {
        /* an unreadable folder simply contributes nothing */
      }
    }
  }
  const configured = process.env.DSH_COMFYUI_PATH ?? process.env.COMFYUI_PATH;
  if (typeof configured === "string" && existsSync(join(configured, "main.py"))) {
    if (!roots.some((root) => root.comfyRoot === configured)) {
      roots.push({ name: "configured", comfyRoot: configured, source: "environment" });
    }
  }
  return roots;
}

/**
 * The catalogues of every install, with duplicates merged by blueprint id.
 *
 * The three Comfy Desktop installs on a typical machine ship the *same*
 * blueprints directory, so a naive union reports 348 templates when there are
 * 116 distinct ones. Merging on id keeps the catalogue honest and makes the
 * list readable.
 */
export function blueprintCatalogue() {
  const merged = new Map();
  for (const install of allComfyInstalls()) {
    for (const entry of discoverBlueprints(install.comfyRoot)) {
      const existing = merged.get(entry.id);
      if (existing === undefined) {
        merged.set(entry.id, { ...entry, installs: [install] });
      } else if (!existing.installs.some((known) => known.comfyRoot === install.comfyRoot)) {
        existing.installs.push(install);
      }
    }
  }
  return [...merged.values()];
}

/** Find one template by id, or the closest match by name. */
export function findBlueprint(idOrName) {
  const wanted = String(idOrName ?? "").toLowerCase();
  const catalogue = blueprintCatalogue();
  const exact = catalogue.find((entry) => entry.id === wanted);
  if (exact !== undefined) return exact;
  return catalogue.find(
    (entry) =>
      entry.title?.toLowerCase() === wanted ||
      entry.file?.toLowerCase() === wanted ||
      entry.model?.toLowerCase() === wanted ||
      entry.id.includes(wanted),
  );
}

/**
 * Precision and quantisation suffixes a checkpoint file may end in.
 *
 * ComfyUI treats these as interchangeable choices in a loader's dropdown: the
 * same model, quantised differently. A machine that has `qwen_image_2.1` in
 * int8 can run a template that asks for the fp8 build, and telling the user to
 * download twenty gigabytes of the same weights because the names differ is
 * both wrong and expensive.
 */
const PRECISION_SUFFIXES = [
  "fp16", "bf16", "fp32", "fp8", "fp8_e4m3fn", "fp8_e4m3fn_scaled", "fp8_hq", "fp8mixed",
  "int8", "int8_convrot", "nvfp4", "awq", "quantized", "q8_0", "q4_k_m", "gguf", "safetensors",
];

/**
 * The model a filename refers to, with precision and extension removed.
 *
 * `qwen_image_2.1_int8_convrot.safetensors` -> `qwen_image_2.1`
 * `qwen_image_fp8_e4m3fn.safetensors` -> `qwen_image`
 */
export function modelStem(name) {
  let base = String(name ?? "").trim();
  const slash = base.lastIndexOf("/");
  if (slash >= 0) base = base.slice(slash + 1);
  base = base.replace(/\.[^.]+$/, "");
  // Strip a trailing precision marker repeatedly: a name can carry both a
  // quantisation and a precision ("..._int8_convrot_bf16").
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of PRECISION_SUFFIXES) {
      if (base.toLowerCase().endsWith(`_${suffix}`)) {
        base = base.slice(0, base.length - suffix.length - 1);
        changed = true;
      }
    }
  }
  return base.replace(/[-_]+$/, "");
}

/**
 * The model family a file belongs to, with version markers stripped.
 *
 * `qwen_image` and `qwen_image_2.1` are two releases of one model, so a
 * machine that owns the 2.1 build can serve a template written for the base
 * release. The version is not always at the end — `qwen_image_2.1_vae` puts a
 * role after it — so every version marker is removed, not just a trailing one.
 *
 * A leading digit only counts as a version when it follows an underscore and
 * begins with a digit-and-dot run, which keeps `qwen3vl_8b` and `qwen_2.5_vl`
 * apart: stripping the second would make every qwen text encoder look like the
 * same family, and swapping those renders noise rather than raising an error.
 */
export function modelFamily(name) {
  const stem = modelStem(name);
  if (stem === "") return "";
  // `qwen_image_2.1_vae` -> `qwen_image_vae`; `ltx-2.3` -> `ltx`.
  const stripped = stem.replace(/[-_]v?\d+(?:\.\d+)+(?=[-_]|$)/g, "").replace(/[-_]v\d+(?=[-_]|$)/g, "");
  const trimmed = stripped === "" ? stem : stripped.replace(/[-_]+$/, "");
  return trimmed === "" ? stem : trimmed;
}

/**
 * Whether an installed file can stand in for the one a template asks for.
 *
 * Two levels, because they mean different things to the caller:
 *
 * - `modelsEquivalent`: the same model at a different precision. Indistinguishable
 *   in practice, so this is substituted silently.
 * - `sameModelFamily`: a different release of the same model. Usually a drop-in
 *   substitute — often a newer one — but not guaranteed, so it is offered
 *   rather than applied.
 *
 * What is deliberately never treated as interchangeable: a different encoder
 * (`qwen3vl` vs `qwen2.5-vl` read a prompt differently and produce noise rather
 * than an error), or a file in a different folder (a text encoder does not fill
 * a diffusion-model slot).
 */
export function modelsEquivalent(required, available) {
  if (required.split("/")[0] !== available.split("/")[0]) return false;
  const wanted = modelStem(required);
  const have = modelStem(available);
  return wanted !== "" && wanted === have;
}

/**
 * Whether two files are different releases of one model.
 *
 * `qwen_image` and `qwen_image_2.1` are the same family; `qwen_image` and
 * `wan2.1` are not. Requiring the families to be equal, in the same folder,
 * keeps this from pairing an unrelated checkpoint that merely starts with the
 * same word.
 */
export function sameModelFamily(required, available) {
  if (modelsEquivalent(required, available)) return false;
  if (required.split("/")[0] !== available.split("/")[0]) return false;
  const wanted = modelFamily(required);
  const have = modelFamily(available);
  return wanted !== "" && have !== "" && wanted === have;
}

/**
 * An installed file from the same family as the one requested, if any.
 *
 * Used to offer "run it with what you already have" instead of downloading a
 * second copy of a model the machine is already carrying.
 */
export function familyAlternative(required, available) {
  for (const candidate of available) {
    if (sameModelFamily(required, candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve one required model against what the server can see.
 *
 * A different precision of the same model is substituted silently: the caller
 * cannot tell the difference and there is no reason to make them choose. A
 * different *release* of the same model is also used — the machine already
 * carries this model, and asking the user to download a second copy of
 * something they own is the more annoying answer — but it is reported, because
 * releases can differ in quality and the caller should know which one ran.
 */
export function resolveModel(required, available) {
  if (available.has(required)) return { file: required, kind: "exact" };
  for (const candidate of available) {
    if (modelsEquivalent(required, candidate)) return { file: candidate, kind: "precision" };
  }
  for (const candidate of available) {
    if (sameModelFamily(required, candidate)) return { file: candidate, kind: "release" };
  }
  return undefined;
}

/**
 * A template's task, normalised for grouping.
 *
 * "Text to Image", "Image Upscale" and "Video Stitch" as free text are not
 * comparable; folding them to `text to image` is what lets a caller ask "what
 * else can do this?" and get an answer instead of 116 rows.
 */
export function taskKey(entry) {
  return String(entry.task ?? entry.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Model availability per folder, cached briefly.
 *
 * Answering "which templates can this machine actually run" means probing every
 * template's model list, and the answer only changes when a model is installed.
 * The cache keeps that from turning one question into a hundred HTTP probes.
 */
const availabilityCache = new Map();

/** How long a probe result stays good, in ms. */
const AVAILABILITY_TTL_MS = 30_000;

/**
 * Which templates can run on this machine right now.
 *
 * This is the honest version of the catalogue: a template whose weights are not
 * installed is not a capability, and listing it beside one that is would have
 * the agent promising something it cannot deliver. Each entry says why it is
 * blocked, so a follow-up question can be answered without re-probing.
 */
export async function runnableTemplates(logger, signal) {
  const catalogue = blueprintCatalogue();
  const entries = catalogue.map((entry) => ({
    entry,
    task: taskKey(entry),
    graph: undefined,
    error: undefined,
    models: [],
    ready: false,
  }));

  // Group by install so each checkout is probed once.
  for (const item of entries) {
    try {
      item.graph = toPromptGraph(JSON.parse(item.entry.raw), {});
    } catch (error) {
      // A template that will not convert is not runnable, whatever is installed.
      item.error = error.message;
      continue;
    }
    item.models = [...graphModels(item.graph)];
  }

  const results = new Map();
  for (const item of entries) {
    if (item.graph === undefined) continue;
    const install = item.entry.installs?.[0];
    if (install === undefined) {
      item.error = "no local installation ships this template";
      continue;
    }
    const key = `${install.comfyRoot}`;
    let present = results.get(key);
    if (present === undefined) {
      present = await probeModelsFor(install, logger, signal);
      results.set(key, present);
    }
    // A template with no sampler renders nothing; that is not a failure but it
    // is not a capability either, so it is reported apart from the blocked ones.
    item.drivesSampler = Object.values(item.graph).some((node) => /Sampler|Guider/.test(node.class_type));
    item.missing =
      present === undefined ? [] : item.models.filter((model) => resolveModel(model, present) === undefined);
    // Without a probe there is nothing to check against, so a template is
    // reported unverified rather than ready or blocked.
    item.ready = present !== undefined && item.missing.length === 0;
    item.unverified = present === undefined;
  }

  return entries;
}

/**
 * What one install can see, reusing a live server where possible.
 *
 * Probing per template would mean the same eight HTTP requests a hundred times
 * over; the first port that answers is reused for the rest of the pass.
 */
async function probeModelsFor(install, logger, signal) {
  for (const port of DEFAULT_PORTS) {
    const key = `${install.comfyRoot}:${port}`;
    let instance = instances.get(key);
    if (instance === undefined) {
      instance = instanceFor(install, port, logger);
      if ((await instance.probe(signal)) === undefined) continue;
      instances.set(key, instance);
    }
    return await availableModels(instance.baseUrl, signal);
  }
  return undefined;
}

/**
 * Templates that can run now and do the same job as a blocked one.
 *
 * This is what lets the agent offer "your machine already has three other
 * image generators" instead of only "download nineteen gigabytes". Grouping by
 * task rather than by model is the right granularity for the question a person
 * actually asks — they want an image, not a specific checkpoint.
 */
export function alternativesFor(blocked, catalogue) {
  const wanted = taskKey(blocked);
  if (wanted === "") return [];
  return catalogue
    .filter(
      (item) =>
        item.ready &&
        item.drivesSampler &&
        item.entry.id !== blocked.id &&
        taskKey(item.entry) === wanted,
    )
    .map((item) => ({ id: item.entry.id, title: item.entry.title, model: item.entry.model }));
}

/**
 * Ask the server which models it can see.
 *
 * This is what decides whether a template can run: a blueprint that names
 * `qwen_image_2.1_*.safetensors` is useless on an install that cannot see
 * that file, no matter how well the graph converts.
 */
export async function availableModels(baseUrl, signal) {
  const folders = ["diffusion_models", "unet", "checkpoints", "clip", "text_encoders", "vae", "loras", "controlnet", "background_removal"];
  const found = new Set();
  for (const folder of folders) {
    try {
      const list = await getJson(`${baseUrl}/models/${folder}`, 8000, signal);
      if (Array.isArray(list)) {
        for (const name of list) {
          // ComfyUI drops a `put_*_here` placeholder in every empty folder.
          if (typeof name === "string" && !name.startsWith("put_")) found.add(`${folder}/${name}`);
        }
      }
    } catch {
      // Some folders are absent from older installs (/models/unet 404s on
      // ComfyUI 0.37); that is a normal answer, not a failure.
    }
  }
  return found;
}

/**
 * Model files a template requires, as `directory/name` keys.
 *
 * Read from the blueprint rather than from the converted graph: the graph's
 * loader nodes already carry resolved defaults, but a template that was saved
 * with a different model selected would otherwise be filtered against the
 * wrong requirement.
 */
/**
 * Model files a converted graph actually loads, as `directory/name` keys.
 *
 * Read from the graph rather than from the blueprint's `properties.models`:
 * that manifest lists every model a template *could* use, while the graph
 * names the ones this run really needs. Checking the manifest reports a
 * template as unrunnable because of an optional ControlNet the run never
 * touches, and — worse — misses a loader whose default came from the template's
 * own widget values.
 */
export function graphModels(graph) {
  const required = new Set();
  // Loader node input -> the ComfyUI model folder it reads from.
  const folders = {
    unet_name: "diffusion_models",
    model_name: "diffusion_models",
    ckpt_name: "checkpoints",
    // ComfyUI renamed the text-encoder folder: a template written against an
    // older install says `clip`, which 0.37 answers 404 for, while the file
    // itself lives under `text_encoders`.
    clip_name: "text_encoders",
    clip_name1: "text_encoders",
    clip_name2: "text_encoders",
    vae_name: "vae",
    lora_name: "loras",
    control_net_name: "controlnet",
    controlnet_name: "controlnet",
    name: "controlnet",
  };
  for (const node of Object.values(graph ?? {})) {
    for (const [key, folder] of Object.entries(folders)) {
      const value = node.inputs?.[key];
      if (typeof value === "string" && value !== "" && !value.startsWith("put_")) {
        required.add(`${folder}/${value}`);
      }
    }
  }
  return required;
}

/**
 * Model files a template requires, as `directory/name` keys.
 *
 * Kept for reporting alongside a run, but see `graphModels` for the check that
 * decides whether the run is possible.
 */
export function requiredModels(blueprint) {
  const required = new Set();
  const visit = (node) => {
    const models = node?.properties?.models;
    if (!Array.isArray(models)) return;
    for (const model of models) {
      if (typeof model?.name === "string" && typeof model?.directory === "string") {
        required.add(`${model.directory}/${model.name}`);
      }
    }
  };
  const subgraph = blueprint?.definitions?.subgraphs?.[0];
  for (const node of subgraph?.nodes ?? []) visit(node);
  for (const node of blueprint?.nodes ?? []) visit(node);
  return required;
}

/**
 * Build an instance descriptor for an install.
 *
 * The interpreter and the extra-model-paths file are what make a headless
 * launch see the same weights Comfy Desktop shows: without the generated
 * `extra_model_paths.yaml`, a bare launch misses the shared model directory
 * entirely and every template that needs a shared weight fails to load it.
 */
function instanceFor(install, port, logger) {
  return new ComfyInstance(
    {
      comfyRoot: install.comfyRoot,
      label: install.name,
      python: resolvePython(install.comfyRoot, install.comfyRoot),
      extraModelPaths: findExtraModelPaths(install.comfyRoot),
    },
    port,
    logger,
  );
}

/**
 * Find an installation that can run this blueprint, preferring one that is
 * already listening.
 *
 * Returns undefined when no checkout has the template's models, with the
 * reason attached so the caller can report something more useful than
 * "not ready".
 */
/**
 * Find an installation that can run this blueprint, preferring one that is
 * already listening.
 *
 * The model check runs against the *converted graph*, not the template's model
 * manifest, because only the graph says what this particular run will load. A
 * template that needs a ControlNet the install has not downloaded is otherwise
 * rejected by ComfyUI as a bare `Value not in list` HTTP 400, which says
 * nothing about which file is missing or where to put it.
 */
export async function resolveBlueprintInstance(entry, overrides, logger, signal) {
  const installs = allComfyInstalls();
  const withTemplate = installs.filter((install) => blueprintIds(install.comfyRoot).has(entry.id));
  if (withTemplate.length === 0) return { ok: false, reason: "no local ComfyUI installation ships this template" };

  const target = withTemplate[0];
  const graph = toPromptGraph(JSON.parse(entry.raw), overrides);
  const required = graphModels(graph);

  for (const port of DEFAULT_PORTS) {
    const key = `${target.comfyRoot}:${port}`;
    let instance = instances.get(key);
    if (instance === undefined) {
      instance = instanceFor(target, port, logger);
      const live = await instance.probe(signal);
      if (live === undefined) continue;
      instances.set(key, instance);
    }
    const present = await availableModels(instance.baseUrl, signal);
    const missing = [];
    const substitutions = [];
    for (const wanted of required) {
      const resolvedModel = resolveModel(wanted, present);
      if (resolvedModel === undefined) missing.push(wanted);
      else if (resolvedModel.file !== wanted) substitutions.push({ template: wanted, using: resolvedModel.file, kind: resolvedModel.kind });
    }
    if (missing.length > 0) {
      return { ok: false, ...missingModelReport(entry, missing, target, present, await runnableTemplates(logger, signal)) };
    }
    applySubstitutions(graph, substitutions);
    return { ok: true, instance, install: target, models: present, graph, substitutions };
  }

  return { ok: true, instance: null, install: target, models: undefined, graph, substitutions: [] };
}

/**
 * Point loader nodes at the files actually on disk.
 *
 * Without this the graph would still name the precision the template was saved
 * with, and the executor would reject it even though an equivalent file is
 * installed — the substitution would be decided and then not applied.
 */
function applySubstitutions(graph, substitutions) {
  if (substitutions.length === 0) return;
  const byFile = new Map(substitutions.map((entry) => [entry.template.split("/")[1], entry.using.split("/")[1]]));
  const loaderInputs = ["unet_name", "model_name", "ckpt_name", "clip_name", "clip_name1", "clip_name2", "vae_name", "lora_name", "control_net_name", "name"];
  for (const node of Object.values(graph)) {
    for (const key of loaderInputs) {
      const current = node.inputs?.[key];
      if (typeof current !== "string") continue;
      const replacement = byFile.get(current);
      if (replacement !== undefined) node.inputs[key] = replacement;
    }
  }
}

/**
 * Describe what is missing well enough for the agent to *ask* rather than act.
 *
 * Downloading model weights is tens of gigabytes and takes the user's disk and
 * their bandwidth, so it is their decision and not the agent's. The report
 * therefore carries everything needed to put that question to them: which
 * files, how big, where they would go, where they come from, whether the
 * licence permits the use the agent has in mind, and whether there is room.
 *
 * It deliberately does not download anything.
 */
function missingModelReport(entry, missing, install, present = new Set(), catalogue = undefined) {
  const folders = [...new Set(missing.map((model) => model.split("/")[0]))];
  const catalog = modelCatalogue();
  // What this machine can already do, so the report can offer that before it
  // offers a download. The question a person asks is "can you make me an
  // image", not "can you run Flux"; a template they can run today beats one
  // they could run after spending twenty gigabytes.
  const alternatives = catalogue === undefined ? [] : alternativesFor(entry, catalogue);
  const files = missing.map((model) => {
    const slash = model.indexOf("/");
    const folder = model.slice(0, slash);
    const name = model.slice(slash + 1);
    const known = catalog[model] ?? catalog[name];
    // A release of the same model already on disk is a better answer than a
    // download: the machine owns this model, and a different release usually
    // runs the same graph. Offered, not applied, because releases can differ.
    const alternative = present === undefined ? undefined : familyAlternative(model, present);
    return {
      folder,
      name,
      repo: known?.repo,
      license: known?.license,
      sizeGb: known?.sizeGb,
      target: join(install.comfyRoot, "models", folder, name),
      downloadUrl: known?.repo === undefined ? undefined : `https://hf-mirror.com/${known.repo}/resolve/main/${known.path ?? ""}`,
      alternative,
    };
  });
  const sizeGb = files.reduce((total, file) => total + (file.sizeGb ?? 0), 0);
  return {
    missing,
    // A stable marker so the agent can tell "ask the user" apart from "this is
    // broken" without parsing prose.
    needsUserDecision: true,
    alternatives,
    reason:
      `Cannot run "${entry.title}": ${missing.length} model file(s) are not on this machine` +
      `${alternatives.length > 0 ? `, but ${alternatives.length} other template(s) for the same task can run right now` : ""}.` +
      `\nASK THE USER which they want: an installed alternative, or a download. Do not download unprompted.` +
      `\nDo not retry until they have answered.`,
    detail: {
      files,
      totalSizeGb: sizeGb,
      folders,
      install: install.name,
      freeDiskGb: freeDiskGb(install.comfyRoot),
    },
  };
}

/** Free space on the volume holding a ComfyUI install, in GB. */
function freeDiskGb(comfyRoot) {
  try {
    const root = volumeRoot(comfyRoot);
    if (root === undefined) return undefined;
    const stat = statfsSync(root);
    return Math.round((stat.bavail * stat.bsize) / 1024 ** 3);
  } catch {
    return undefined;
  }
}

/**
 * Walk up to the nearest existing ancestor, so a path under a directory that
 * has not been created yet still resolves to its volume.
 */
function volumeRoot(path) {
  let current = path;
  // A bounded walk: `existsSync` rejects non-string input, and the caller
  // always passes a real path, but guard anyway rather than throw.
  if (typeof current !== "string" || current === "") return undefined;
  while (current !== "" && !existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return current === "" ? undefined : current;
}

/**
 * Known model locations, sizes and licences.
 *
 * Only what this machine can actually use is listed. The licence matters as
 * much as the URL: FLUX.1-dev downloads without friction but is not licensed
 * for commercial use, so a download prompt that omits it asks the user to
 * approve something they have not been told about.
 */
const MODEL_CATALOG = {
  "vae/qwen_image_vae.safetensors": {
    repo: "Comfy-Org/Qwen-Image_ComfyUI",
    path: "split_files/vae/qwen_image_vae.safetensors",
    sizeGb: 0.24,
    license: "Apache-2.0 (free, including commercial)",
  },
  "text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors": {
    repo: "Comfy-Org/Qwen-Image_ComfyUI",
    path: "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
    sizeGb: 8.74,
    license: "Apache-2.0 (free, including commercial)",
  },
  "diffusion_models/qwen_image_fp8_e4m3fn.safetensors": {
    repo: "Comfy-Org/Qwen-Image_ComfyUI",
    path: "split_files/diffusion_models/qwen_image_fp8_e4m3fn.safetensors",
    sizeGb: 19.03,
    license: "Apache-2.0 (free, including commercial)",
  },
  "text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors": {
    repo: "Comfy-Org/umt5_xxl",
    path: "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    sizeGb: 6.37,
    license: "Apache-2.0 (free, including commercial)",
  },
  "text_encoders/clip_l.safetensors": {
    repo: "Comfy-Org/flux_text_encoders",
    path: "split_files/text_encoders/clip_l.safetensors",
    sizeGb: 0.25,
    license: "Apache-2.0 (text encoder alone; the FLUX.1-dev transformer is non-commercial)",
  },
  "text_encoders/t5xxl_fp16.safetensors": {
    repo: "comfyanonymous/flux_text_encoders",
    path: "t5xxl_fp16.safetensors",
    sizeGb: 9.79,
    license: "Apache-2.0 (text encoder alone; the FLUX.1-dev transformer is non-commercial)",
  },
  "checkpoints/flux1-dev.safetensors": {
    repo: "Comfy-Org/flux1-dev",
    path: "flux1-dev.safetensors",
    sizeGb: 23.8,
    license: "FLUX.1-dev Non-Commercial License — ask before any commercial use",
  },
  "diffusion_models/flux1-dev.safetensors": {
    repo: "Comfy-Org/flux1-dev",
    path: "flux1-dev.safetensors",
    sizeGb: 23.8,
    license: "FLUX.1-dev Non-Commercial License — ask before any commercial use",
  },
  "diffusion_models/flux1-schnell-fp8.safetensors": {
    repo: "Comfy-Org/flux1-schnell",
    path: "flux1-schnell-fp8.safetensors",
    sizeGb: 11.9,
    license: "Apache-2.0 — the freely licensed alternative to FLUX.1-dev",
  },
  "vae/flux2-vae.safetensors": {
    repo: "Comfy-Org/flux2-dev",
    path: "split_files/vae/flux2-vae.safetensors",
    sizeGb: 0.33,
    license: "FLUX.2 Non-Commercial License",
  },
  "controlnet/Z-Image-Turbo-Fun-Controlnet-Union.safetensors": {
    repo: "ali-vilab/ControlNet-Z-Image-Turbo",
    path: "Z-Image-Turbo-Fun-Controlnet-Union.safetensors",
    sizeGb: 2.5,
    license: "Apache-2.0",
  },
  "background_removal/birefnet.safetensors": {
    repo: "ZhengPeng7/BiRefNet",
    path: "model.safetensors",
    sizeGb: 0.9,
    license: "MIT",
  },
};

/** The catalogue, keyed as the availability check keys its models. */
function modelCatalogue() {
  return MODEL_CATALOG;
}

/**
 * Convert and run one blueprint, resolving with the saved images.
 */
export async function runBlueprint(options) {
  const { entry, overrides = {}, timeoutMs, logger, signal } = options;
  const resolved = await resolveBlueprintInstance(entry, overrides, logger, signal);
  if (resolved.ok === false) throw missingModelError(resolved);
  const { instance, install, graph } = resolved;

  const live =
    instance ?? instanceFor(install, DEFAULT_PORTS[DEFAULT_PORTS.length - 1], logger);
  await live.ensure(signal);
  // Re-probe once the server is up: a launch we started ourselves has not been
  // asked for its model list yet, and that is the cheapest moment to discover a
  // missing weight instead of a 400 from the executor.
  const present = await availableModels(live.baseUrl, signal);
  const substitutions = [];
  const missing = [];
  for (const wanted of graphModels(graph)) {
    const resolvedModel = resolveModel(wanted, present);
    if (resolvedModel === undefined) missing.push(wanted);
    else if (resolvedModel.file !== wanted) substitutions.push({ template: wanted, using: resolvedModel.file, kind: resolvedModel.kind });
  }
  if (missing.length > 0) {
    throw missingModelError({
      ...missingModelReport(entry, missing, install, present, await runnableTemplates(logger, signal)),
    });
  }
  applySubstitutions(graph, substitutions);
  const applied = [...(resolved.substitutions ?? []), ...substitutions];

  const result = await runGraph(live, graph, { timeoutMs, signal });
  return {
    ...result,
    install: install.name,
    blueprint: entry.id,
    requiredModels: [...graphModels(graph)],
    substitutions: applied,
  };
}

/**
 * Turn a missing-model report into an error the agent can act on.
 *
 * `needsUserDecision` travels on the error object so the tool layer can render
 * it as a question rather than a failure: the point is that the agent stops and
 * asks, and that decision is not something it should take by retrying.
 */
function missingModelError(report) {
  const error = new Error(report.reason);
  error.needsUserDecision = true;
  error.missing = report.missing;
  // The alternatives are the most useful part of the report — they let the
  // agent answer "can you make an image" from what is installed rather than
  // from what could be downloaded — so they travel with the error.
  error.alternatives = report.alternatives ?? [];
  error.detail = report.detail;
  return error;
}

/** Stop every server this module started. */
export function stopAllBlueprints() {
  for (const instance of instances.values()) instance.stop();
  instances.clear();
}

/** A compact, model-facing description of one template. */
export function describe(entry) {
  return describeBlueprint(entry);
}

export { delay };