/**
 * Workflow templates and their model-facing parameter contract.
 *
 * Each workflow is a ComfyUI API-format graph carrying `{{placeholder}}`
 * strings. Rendering substitutes the caller's parameters and fails loudly on
 * an unknown or missing one, so a typo never silently reaches the GPU.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOW_DIR = join(PACKAGE_ROOT, "workflows");

/** Placeholder grammar mirroring the ComfyUI API graph convention. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Node ids whose inputs must stay numeric even when passed as strings. */
const NUMERIC_PARAMETERS = new Set([
  "width",
  "height",
  "batch_size",
  "seed",
  "steps",
  "cfg",
  "resolution",
  "megapixels",
]);

/** Boolean-valued parameters accepted from a model as strings. */
const BOOLEAN_PARAMETERS = new Set(["transparent", "disable_metadata"]);

/**
 * Per-kind parameter defaults and model-facing documentation. `steps` is
 * intentionally conservative for Z-Image-Turbo, which is a distilled model
 * that degrades past a handful of steps.
 */
export const WORKFLOW_SPECS = {
  "z-image-turbo": {
    id: "z-image-turbo",
    label: "Z-Image-Turbo",
    file: "z-image-turbo.api.json",
    summary:
      "Z-Image-Turbo: distilled 6B text-to-image model. Extremely fast (seconds on a laptop GPU) and excellent at prompt adherence, but it has no negative-prompt input and runs at CFG 1.",
    guidance:
      "Choose this model for drafts, concept exploration, and any batch of many images. It ignores negative prompts entirely, so express unwanted content directly in the prompt instead.",
    defaults: {
      width: 1024,
      height: 1024,
      steps: 8,
      seed: 0,
      batch_size: 1,
      sampler_name: "res_multistep",
      scheduler: "simple",
      cfg: 1.0,
    },
    supports: {
      negative_prompt: false,
      transparent: false,
      batch_size: true,
    },
    ranges: {
      width: { min: 64, max: 4096 },
      height: { min: 64, max: 4096 },
      steps: { min: 1, max: 20 },
      batch_size: { min: 1, max: 8 },
    },
  },
  "qwen-image-2.1": {
    id: "qwen-image-2.1",
    label: "Qwen-Image-2.1",
    file: "qwen-image-2.1.api.json",
    summary:
      "Qwen-Image-2.1: full Qwen-Image 2.1 text-to-image model. Higher prompt fidelity, real text rendering in-image, and native support for negative prompts and 2K output — but it is far slower and heavier than Z-Image-Turbo.",
    guidance:
      "Choose this model for final assets: images containing legible text, precise multi-element composition, or a negative prompt you actually need. It supports native 2048x2048 output.",
    defaults: {
      width: 1024,
      height: 1024,
      steps: 25,
      cfg: 4.0,
      seed: 0,
      batch_size: 1,
      sampler_name: "euler",
      scheduler: "simple",
    },
    supports: {
      negative_prompt: true,
      transparent: true,
      batch_size: true,
    },
    ranges: {
      width: { min: 64, max: 4096 },
      height: { min: 64, max: 4096 },
      steps: { min: 1, max: 60 },
      batch_size: { min: 1, max: 4 },
    },
  },
};

/** Read and parse one workflow template. */
export function loadWorkflow(kindId) {
  const spec = WORKFLOW_SPECS[kindId];
  if (spec === undefined) throw new Error(`unknown workflow kind "${kindId}"`);
  return JSON.parse(readFileSync(join(WORKFLOW_DIR, spec.file), "utf8"));
}

/** Collect every placeholder name a template requires. */
export function requiredParameters(template) {
  const found = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const value of Object.values(node)) walk(value);
      return;
    }
    if (typeof node === "string") {
      for (const match of node.matchAll(PLACEHOLDER)) found.add(match[1]);
    }
  };
  walk(template);
  return [...found];
}

/**
 * Coerce a model-supplied value into the type the placeholder expects, then
 * validate it against the spec's declared range.
 *
 * Range checking runs on the coerced value rather than only on string input:
 * a caller that passes the number `100000` must be rejected just as firmly as
 * one that passes `"100000"`.
 */
function coerceParameter(name, raw, spec) {
  let value = raw;
  if (typeof raw === "string") {
    if (BOOLEAN_PARAMETERS.has(name)) {
      value = raw.trim().toLowerCase() === "true";
    } else if (NUMERIC_PARAMETERS.has(name)) {
      const parsed = Number(raw.trim());
      if (!Number.isFinite(parsed)) {
        throw new Error(`parameter "${name}" must be a number, got ${JSON.stringify(raw)}`);
      }
      value = parsed;
    }
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`parameter "${name}" must be a finite number, got ${String(value)}`);
    }
    const range = spec?.ranges?.[name];
    if (range !== undefined && (value < range.min || value > range.max)) {
      throw new Error(`parameter "${name}" must be between ${range.min} and ${range.max}, got ${value}`);
    }
  }
  return value;
}

/**
 * Substitute parameters into a template.
 *
 * Every required placeholder must resolve; unknown keys are reported so a
 * caller who misspelled an option learns about it instead of silently getting
 * the default.
 */
export function renderWorkflow(template, spec, parameters) {
  const provided = parameters ?? {};
  const required = new Set(requiredParameters(template));
  const missing = [...required].filter((name) => provided[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`missing required workflow parameters: ${missing.join(", ")}`);
  }
  const unknown = Object.keys(provided).filter(
    (name) => !required.has(name) && !required.has(name.replace(/^model_/, "")),
  );
  if (unknown.length > 0) {
    throw new Error(`unknown workflow parameters: ${unknown.join(", ")}`);
  }

  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out = {};
      for (const [key, value] of Object.entries(node)) out[key] = walk(value);
      return out;
    }
    if (typeof node === "string") {
      const exact = node.match(/^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/);
      if (exact !== null) {
        const name = exact[1];
        const raw = provided[name];
        return coerceParameter(name, raw, spec);
      }
      return node.replace(PLACEHOLDER, (_match, name) => {
        const raw = provided[name];
        if (raw === undefined) throw new Error(`missing required workflow parameter: ${name}`);
        return String(raw);
      });
    }
    return node;
  };

  return walk(template);
}

/**
 * Round width and height down to a multiple of 32. Diffusion UNets require
 * latent dimensions divisible by 8, and the 16x downsampling path means a
 * multiple of 32 avoids a silent resample.
 */
export function roundTo32(value) {
  return Math.max(32, Math.round(value / 32) * 32);
}

/** Upper bound on a generated seed; ComfyUI stores seeds as 64-bit integers. */
const MAX_RANDOM_SEED = 2 ** 31;

/**
 * Resolve one call's complete, fully-populated parameter set.
 *
 * Every value the template needs is decided here, so the renderer never has to
 * guess. Two rules make this the single place those decisions belong:
 *
 * - An omitted argument must never erase a default. The object the model hands
 *   us names every declared key, so spreading it blindly would let a missing
 *   `steps` overwrite the spec default with `undefined` and reach the renderer
 *   as a missing parameter. Each key is therefore only applied when it
 *   actually carries a value.
 * - Dimensions are rounded here, so `resolution` can be derived from the same
 *   rounded numbers the latent node receives. Deriving it from the raw
 *   arguments instead produced a non-multiple-of-32 (or `NaN`), which ComfyUI
 *   rejects outright.
 *
 * @param spec - the workflow spec supplying defaults and capability flags
 * @param models - resolved model file names for this installation
 * @param args - the model-facing tool arguments
 * @returns every placeholder the template requires, with no undefined values
 */
export function buildParameters(spec, models, args) {
  const width = roundTo32(args.width ?? spec.defaults.width);
  const height = roundTo32(args.height ?? spec.defaults.height);

  const parameters = {
    ...spec.defaults,
    ...models,
    prompt: args.prompt,
    width,
    height,
    steps: args.steps ?? spec.defaults.steps,
    seed: args.seed ?? Math.floor(Math.random() * MAX_RANDOM_SEED),
    batch_size: 1,
    filename_prefix: "dsh-comfyui-image",
  };

  if (spec.supports.negative_prompt) {
    // The Qwen template always names `negative_prompt`, so an omitted one has
    // to become an empty string rather than a missing parameter.
    parameters.negative_prompt = args.negative_prompt ?? "";
    // The encoder's `resolution` only sizes reference-image slots; it is
    // unused with none, but it must be a valid multiple of 32.
    parameters.resolution = Math.max(width, height);
  }

  return parameters;
}
