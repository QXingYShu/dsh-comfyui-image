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
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
 * Ask the server which models it can see.
 *
 * This is what decides whether a template can run: a blueprint that names
 * `qwen_image_2.1_*.safetensors` is useless on an install that cannot see
 * that file, no matter how well the graph converts.
 */
export async function availableModels(baseUrl, signal) {
  const folders = ["diffusion_models", "unet", "checkpoints", "clip", "text_encoders", "vae", "loras", "controlnet"];
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
export async function resolveBlueprintInstance(entry, logger, signal) {
  const installs = allComfyInstalls();
  const withTemplate = installs.filter((install) => blueprintIds(install.comfyRoot).has(entry.id));
  if (withTemplate.length === 0) return { ok: false, reason: "no local ComfyUI installation ships this template" };

  const target = withTemplate[0];
  const required = requiredModels(JSON.parse(entry.raw));

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
    const missing = [...required].filter((model) => !present.has(model) && model.includes("/"));
    // Only enforce the requirement when the server actually answered with a
    // non-empty list; an empty one means the probe raced startup.
    if (present.size > 0 && missing.length > 0 && missing.length === required.size) {
      return {
        ok: false,
        reason: `the running ComfyUI cannot see the models this template needs (${missing.slice(0, 3).join(", ")})`,
      };
    }
    return { ok: true, instance, install: target, models: present };
  }

  return { ok: true, instance: null, install: target, models: undefined };
}

/**
 * Convert and run one blueprint, resolving with the saved images.
 */
export async function runBlueprint(options) {
  const { entry, overrides = {}, timeoutMs, logger, signal } = options;
  const resolved = await resolveBlueprintInstance(entry, logger, signal);
  if (resolved.ok === false) throw new Error(resolved.reason);
  const { instance, install } = resolved;

  const blueprint = JSON.parse(entry.raw);
  const graph = toPromptGraph(blueprint, overrides);

  const live =
    instance ?? instanceFor(install, DEFAULT_PORTS[DEFAULT_PORTS.length - 1], logger);
  await live.ensure(signal);
  const result = await runGraph(live, graph, { timeoutMs, signal });
  return { ...result, install: install.name, blueprint: entry.id, requiredModels: [...requiredModels(blueprint)] };
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