/**
 * dsh-comfyui-image — drive a local ComfyUI image workflow from the agent.
 *
 * The plugin registers two model-facing tools (`comfyui_generate`,
 * `comfyui_status`) and one skill (`comfyui-image`) that teaches the model how
 * to pick a model and write a prompt for this machine's two installed
 * workflows.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, kinds } from "./comfy.js";
import { defineTool } from "./define-tool.js";
import { describeKind, generate, saveImageTo, stopAll } from "./generate.js";
import { buildParameters, WORKFLOW_SPECS, loadWorkflow } from "./workflows.js";

export const name = "comfyui-image";
export const inject = ["tools", "skills"];

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL_DIR = join(PACKAGE_ROOT, "skills");

/** Reasonable ceiling on a single generation call. */
const GENERATE_TIMEOUT_MS = 20 * 60_000;

/** Longest slug accepted for a generated file name. */
const MAX_SLUG_LENGTH = 60;

/** Turn a prompt into a stable, filesystem-safe file stem. */
function slugify(text) {
  const ascii = text
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = ascii.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
  return trimmed === "" ? "image" : trimmed;
}

/** Resolve where a generated image should be written. */
function resolveOutputDir(requested) {
  if (typeof requested === "string" && requested !== "") {
    return isAbsolute(requested) ? requested : resolve(process.cwd(), requested);
  }
  return join(process.cwd(), "generated-images");
}

/** Build the shared output shape for both tools. */
const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    kind: { type: "string" },
    prompt_id: { type: "string" },
    elapsed_ms: { type: "integer" },
    output_dir: { type: "string" },
    images: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string" },
          filename: { type: "string" },
          bytes: { type: "integer" },
          source: { type: "string" },
          url: { type: "string" },
        },
      },
    },
    message: { type: "string" },
  },
};

/** One-line description per kind, for the model-facing tool schema. */
const KIND_SUMMARY = Object.values(WORKFLOW_SPECS)
  .map((spec) => `- ${spec.id}: ${spec.summary}`)
  .join("\n");

/** The generate tool. */
function generateTool() {
  return defineTool({
    name: "comfyui_generate",
    description:
      "Generate an image on the user's local ComfyUI server and save it to disk.\n\n" +
      "Two workflows are available on this machine:\n" +
      `${KIND_SUMMARY}\n\n` +
      "Prefer z-image-turbo for drafts, batches, and fast iteration; prefer qwen-image-2.1 for " +
      "final assets, legible in-image text, or when a negative prompt is required. The first call " +
      "may start ComfyUI headless, which takes a minute or two; later calls reuse it. " +
      "Returns the saved file paths, which you can then read to inspect the result.",
    parameters: {
      prompt: {
        type: "string",
        required: true,
        description:
          "The full text-to-image prompt. Describe subject, composition, lighting, and style in one paragraph.",
      },
      kind: {
        type: "string",
        required: false,
        enum: Object.keys(WORKFLOW_SPECS),
        description: "Which workflow to run. Defaults to z-image-turbo.",
      },
      negative_prompt: {
        type: "string",
        required: false,
        description: "What to avoid. Only qwen-image-2.1 supports this; ignored by z-image-turbo.",
      },
      width: {
        type: "integer",
        required: false,
        description: "Output width in pixels; rounded to a multiple of 32. Default 1024.",
      },
      height: {
        type: "integer",
        required: false,
        description: "Output height in pixels; rounded to a multiple of 32. Default 1024.",
      },
      steps: {
        type: "integer",
        required: false,
        description:
          "Sampler steps. Z-Image-Turbo wants 6-9 (it is distilled); Qwen-Image-2.1 wants 20-30.",
      },
      seed: {
        type: "integer",
        required: false,
        description:
          "Random seed. Pass an explicit value to reproduce or vary a specific image; omit to randomize.",
      },
      count: {
        type: "integer",
        required: false,
        description: "How many images to produce in one batch. Default 1; keep it small on a laptop GPU.",
      },
      output_dir: {
        type: "string",
        required: false,
        description:
          "Directory to save into, absolute or relative to the workspace. Default ./generated-images.",
      },
    },
    output: {
      schema: outputSchema,
      render(_args, value) {
        const lines = [
          value.ok
            ? `Generated ${value.images?.length ?? 0} image(s) with ${value.kind} in ${value.elapsed_ms}ms.`
            : `comfyui_generate failed: ${value.message ?? "unknown error"}`,
        ];
        for (const image of value.images ?? []) {
          lines.push(`- ${image.path}`);
        }
        if (value.output_dir !== undefined) lines.push(`Output directory: ${value.output_dir}`);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const spec = WORKFLOW_SPECS[args.kind ?? "z-image-turbo"];
      const template = loadWorkflow(spec.id);
      const count = Math.min(Math.max(args.count ?? 1, 1), spec.ranges.batch_size.max);

      // Models differ per workflow and live in the shared ComfyUI model
      // directory; the template resolves them unless a caller overrides.
      const models = resolveModels(spec.id);
      const outputDir = resolveOutputDir(args.output_dir);
      const stem = slugify(args.prompt);

      const saved = [];
      let totalMs = 0;
      let promptId = "";
      for (let index = 0; index < count; index += 1) {
        // Models differ per workflow and live in the shared ComfyUI model
        // directory; the template resolves them unless a caller overrides.
        const parameters = buildParameters(spec, models, args);

        const result = await generate({
          kindId: spec.id,
          spec,
          template,
          parameters,
          models,
          timeoutMs: GENERATE_TIMEOUT_MS,
          logger: exec?.logger,
          signal: exec?.signal,
        });
        totalMs += result.elapsedMs;
        promptId = result.promptId;
        const suffix = count > 1 ? `-${index + 1}` : "";
        const target = join(outputDir, `${stem}${suffix}.png`);
        const written = await saveImageTo(result.images[0], target);
        saved.push({ ...written, source: result.images[0].filename, url: result.images[0].url });
      }

      return {
        ok: true,
        kind: spec.id,
        prompt_id: promptId,
        elapsed_ms: totalMs,
        output_dir: outputDir,
        images: saved,
      };
    },
  });
}

/** Model file names per workflow kind, read from the shared model directory. */
function resolveModels(kindId) {
  const fromEnv = kindId === "z-image-turbo" ? process.env.DSH_ZIMAGE_MODELS : process.env.DSH_QWEN_IMAGE_MODELS;
  if (typeof fromEnv === "string" && fromEnv !== "") {
    try {
      const parsed = JSON.parse(fromEnv);
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {
      // Fall through to the documented defaults on malformed configuration.
    }
  }
  const spec = WORKFLOW_SPECS[kindId];
  const match = kinds().find((entry) => entry.id === kindId);
  return { ...match.models, ...spec.defaults?.models };
}

/** The status/diagnostic tool. */
function statusTool() {
  return defineTool({
    name: "comfyui_status",
    description:
      "Report which local ComfyUI workflows this plugin can drive, whether the matching " +
      "ComfyUI installation was found, and the defaults each workflow will use. Call this when " +
      "generation fails, or to check readiness before starting a batch.",
    parameters: {
      kind: {
        type: "string",
        required: false,
        enum: Object.keys(WORKFLOW_SPECS),
        description: "Limit the report to one workflow. Omit to report both.",
      },
    },
    output: {
      schema: outputSchema,
      render(_args, value) {
        return [{ type: "text", text: value.message ?? JSON.stringify(value, null, 2) }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const selected = args.kind !== undefined ? [WORKFLOW_SPECS[args.kind]] : Object.values(WORKFLOW_SPECS);
      const report = selected.map((spec) => {
        const status = describeKind(spec.id);
        return (
          `${spec.label} (${spec.id}): ${status.ready ? "ready" : "NOT FOUND"}\n` +
          (status.installations.length > 0
            ? status.installations.map((i) => `  install: ${i.label} at ${i.comfyRoot}`).join("\n") + "\n"
            : "  no matching local installation was detected\n") +
          `  defaults: ${JSON.stringify(spec.defaults)}\n` +
          `  ${spec.summary}`
        );
      });
      return {
        ok: true,
        message: report.join("\n\n"),
        kind: selected.map((spec) => spec.id).join(", "),
        output_dir: join(process.cwd(), "generated-images"),
        images: [],
      };
    },
  });
}

/** Read the bundled skill definition from disk. */
function loadSkill() {
  const body = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  return {
    name: "comfyui-image",
    description:
      "Generate image assets on the user's local ComfyUI server with Z-Image-Turbo or Qwen-Image-2.1. " +
      "Use when the user asks for an illustration, a rendered concept, an icon or banner, a photo-style render, " +
      "or any other picture produced from a text description.",
    whenToUse:
      "The user wants an image, illustration, render, or visual asset created from a description — " +
      "or asks which ComfyUI workflow is available.",
    // `ctx.skills.register()` only checks name/description/invocation, so a
    // missing `source` registers silently and then fails every time the model
    // loads the skill (`loaded skill "..." source must be a string`). The Host
    // defaults `provider` to "runtime" for runtime registrations; `source` has
    // no default and must be declared here.
    source: "runtime",
    content: body,
  };
}

/** Plugin entry. */
export function apply(ctx) {
  const disposers = [];

  if (ctx.tools !== undefined) {
    disposers.push(ctx.tools.register(generateTool()));
    disposers.push(ctx.tools.register(statusTool()));
  }

  if (ctx.skills !== undefined) {
    disposers.push(ctx.skills.register(loadSkill()));
  }

  // Only stop processes we actually started; a server the user launched stays.
  ctx.on?.("dispose", () => {
    for (const dispose of disposers.splice(0)) dispose();
    stopAll();
  });

  return () => {
    for (const dispose of disposers.splice(0)) dispose();
    stopAll();
  };
}

export { DEFAULT_PORT };