/**
 * The template-facing tools.
 *
 * `comfyui_templates` lets the agent see what this machine can actually run;
 * `comfyui_run_template` runs one. They sit beside the two curated workflows
 * rather than replacing them: the curated pair stays the fast, well-tuned path
 * for plain text-to-image, and the templates cover everything else — video,
 * editing, control, depth, matting, 3D, audio.
 *
 * The two are separated on purpose. `comfyui_generate` takes a prompt and
 * nothing else, which is the right shape when the answer is "just make an
 * image". A template run takes a template id plus per-template inputs, and the
 * ids and inputs only mean something against a catalogue the agent has read.
 */

import { join } from "node:path";
import { defineTool } from "./define-tool.js";
import {
  blueprintCatalogue,
  describe,
  findBlueprint,
  runBlueprint,
} from "./blueprint-runner.js";
import { saveImageTo } from "./generate.js";
import { queryModel, recommendForTask, knownTasks } from "./model-knowledge.js";
import { slugify, resolveOutputDir } from "./paths.js";

/** Generous ceiling: a video template can occupy the GPU for many minutes. */
const TEMPLATE_TIMEOUT_MS = 30 * 60_000;

/** How many catalogue rows to show before truncating. */
const MAX_LISTED = 60;

/**
 * Output schema shared with the other tools, so the render helpers agree.
 *
 * Kept permissive (`additionalProperties` unset) because these tools report
 * template-specific fields the schema does not enumerate — the message is the
 * part a model actually reads.
 */
function templateOutputSchema(extra = {}) {
  return {
    type: "object",
    required: ["ok"],
    properties: {
      ok: { type: "boolean" },
      message: { type: "string" },
      templates: { type: "array" },
      images: { type: "array" },
      output_dir: { type: "string" },
      ...extra,
    },
  };
}

/** One catalogue row, sized for a model to read without bloating a context. */
function row(entry) {
  const parts = [entry.title];
  if (entry.model !== undefined) parts.push(`(${entry.model})`);
  return {
    id: entry.id,
    title: entry.title,
    model: entry.model ?? null,
    task: entry.task,
  };
}

/**
 * Narrow the catalogue by free text, model or task.
 *
 * Matching is deliberately forgiving — an agent that has read a title and typed
 * a fragment should find the row rather than get an empty list, since an empty
 * list is indistinguishable from "this machine cannot do that".
 */
function filterCatalogue(catalogue, { search, model, task }) {
  let result = catalogue;
  if (typeof model === "string" && model !== "") {
    const wanted = model.toLowerCase();
    result = result.filter((entry) => entry.model?.toLowerCase().includes(wanted));
  }
  if (typeof task === "string" && task !== "") {
    const wanted = task.toLowerCase();
    result = result.filter(
      (entry) =>
        entry.task?.toLowerCase().includes(wanted) || entry.title?.toLowerCase().includes(wanted),
    );
  }
  if (typeof search === "string" && search !== "") {
    const wanted = search.toLowerCase();
    result = result.filter((entry) =>
      `${entry.id} ${entry.title} ${entry.model ?? ""} ${entry.task}`.toLowerCase().includes(wanted),
    );
  }
  return result;
}

/**
 * The tuning advice recorded for a model family, as a short block of text.
 *
 * This is the part a model cannot work out on its own. The template supplies
 * the default values, but not the reasoning: that Z-Image-Turbo zeroes its
 * negative slot (so a negative prompt changes nothing at all), or that it is
 * distilled and more steps make it worse.
 */
function knowledgeFor(model) {
  if (typeof model !== "string" || model === "") return "";
  const record = queryModel(model);
  if (record === undefined) return "";
  const lines = [];
  if (record.sampler?.steps !== undefined) {
    const { value, range, verified } = record.sampler.steps;
    const band = Array.isArray(range) && range[0] !== range[1] ? `${range[0]}-${range[1]}` : `${value}`;
    lines.push(`steps: ${band}${verified === true ? "" : " (unverified)"}`);
  }
  if (record.sampler?.cfg !== undefined) {
    const { value, verified } = record.sampler.cfg;
    lines.push(`cfg: ${value}${verified === true ? "" : " (unverified)"}`);
  }
  if (record.negativePrompt?.supported === false) {
    lines.push(`negative prompt: NOT SUPPORTED — ${record.negativePrompt.note ?? "state what you want instead"}`);
  } else if (record.negativePrompt?.supported === true) {
    lines.push("negative prompt: supported");
  }
  if (record.textRendering?.reliable === true) {
    lines.push("in-image text: reliable — use this when text must be legible");
  }
  // Hints are stored per language; the user is reading Chinese, so prefer that
  // and fall back to English rather than emitting both.
  const hints = record.promptHints?.zh ?? record.promptHints?.en ?? [];
  const notes = Array.isArray(hints) ? hints : [];
  const block = [
    lines.length > 0 ? `\nmodel notes (${record.label ?? model}):\n${lines.map((line) => `  ${line}`).join("\n")}` : "",
    notes.length > 0 ? `\nprompt hints:\n${notes.map((line) => `  - ${line}`).join("\n")}` : "",
  ].join("");
  return block;
}

/** The browse/search tool. */
export function templatesTool() {
  return defineTool({
    name: "comfyui_templates",
    description:
      "List the ComfyUI workflow templates available on this machine, or inspect one in detail.\n\n" +
      "ComfyUI ships a large built-in catalogue covering far more than plain text-to-image: " +
      "image and video generation, image editing, ControlNet and pose control, depth and geometry, " +
      "matting, upscaling, 3D, and audio. Use this to find the right template when " +
      "comfyui_generate's two curated workflows do not fit the task.\n\n" +
      "Call it without arguments for the whole catalogue, with `search` to filter, or with " +
      "`template` alone to see one template's inputs and their defaults. Model-facing output " +
      "must name the template id exactly as returned here.",
    parameters: {
      search: {
        type: "string",
        required: false,
        description: "Free-text filter matched against id, title, model and task.",
      },
      model: {
        type: "string",
        required: false,
        description: "Filter by model family, e.g. 'Flux.1', 'LTX', 'Wan', 'Qwen-Image'.",
      },
      task: {
        type: "string",
        required: false,
        description: "Filter by task, e.g. 'text to image', 'video', 'edit', 'upscale', 'depth'.",
      },
      template: {
        type: "string",
        required: false,
        description: "Inspect this template id instead of listing; returns its inputs and defaults.",
      },
      recommend: {
        type: "boolean",
        required: false,
        description:
          "With `task`, return the models best suited to it and why, instead of listing templates.",
      },
      speed: {
        type: "string",
        required: false,
        enum: ["draft", "standard", "quality"],
        description: "With `recommend`, bias the answer toward a speed class. Default standard.",
      },
    },
    output: {
      schema: templateOutputSchema({ templates: { type: "array" } }),
      render(_args, value) {
        return [{ type: "text", text: value.message ?? JSON.stringify(value, null, 2) }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const catalogue = blueprintCatalogue();
      if (catalogue.length === 0) {
        return {
          ok: false,
          message:
            "No ComfyUI installation with templates was found. Install Comfy Desktop, or set DSH_COMFYUI_PATH.",
          templates: [],
          images: [],
        };
      }

      if (typeof args.template === "string" && args.template !== "") {
        const entry = findBlueprint(args.template);
        if (entry === undefined) {
          return {
            ok: false,
            message: `No template matches "${args.template}". Call comfyui_templates without arguments to see the catalogue.`,
            templates: [],
            images: [],
          };
        }
        const described = describe(entry);
        const inputs = described.inputs
          .map((input) => `  ${input.name} [${input.type}]${input.default === null ? "" : ` default=${JSON.stringify(input.default)}`}`)
          .join("\n");
        return {
          ok: true,
          message:
            `${described.title}${described.model === undefined ? "" : ` (${described.model})`}\n` +
            `id: ${described.id}\n` +
            `run it with: comfyui_run_template(template="${described.id}", inputs={...})\n` +
            `inputs:\n${inputs || "  (none)"}` +
            knowledgeFor(described.model),
          templates: [{ ...described, inputs: described.inputs }],
          images: [],
        };
      }

      if (args.recommend === true && typeof args.task === "string" && args.task !== "") {
        const suggestions = recommendForTask(args.task, { speed: args.speed });
        if (suggestions.length === 0) {
          return {
            ok: false,
            message:
              `No local model is recorded for the task "${args.task}". Known tasks: ${knownTasks().join(", ")}.`,
            templates: [],
            images: [],
          };
        }
        const lines = suggestions.map((record) => {
          const picks = catalogue
            .filter((entry) => queryModel(entry.model ?? "")?.family === record.family)
            .map((entry) => entry.id);
          const summary = record.strengths?.slice(0, 2).join("；") ?? "";
          return (
            `- ${record.label ?? record.family} (${record.speed ?? "standard"})\n` +
            `  ${summary}\n` +
            (picks.length > 0 ? `  templates: ${picks.slice(0, 3).join(", ")}\n` : "")
          );
        });
        return {
          ok: true,
          message: `Models for "${args.task}":\n${lines.join("")}`,
          templates: suggestions.map((record) => ({
            family: record.family,
            label: record.label ?? record.family,
            speed: record.speed ?? null,
          })),
          images: [],
        };
      }

      const filtered = filterCatalogue(catalogue, args);
      const shown = filtered.slice(0, MAX_LISTED);
      const families = new Set(catalogue.map((entry) => entry.model).filter((m) => m !== undefined));
      const lines = shown.map((entry) => {
        const model = entry.model === undefined ? "" : ` (${entry.model})`;
        return `- ${entry.id}: ${entry.title}${model}`;
      });
      const truncated = filtered.length > shown.length ? `\n... and ${filtered.length - shown.length} more` : "";
      return {
        ok: true,
        message:
          `${filtered.length} of ${catalogue.length} templates across ${families.size} model families.\n` +
          `${lines.join("\n")}${truncated}\n\n` +
          `Inspect one with comfyui_templates(template="<id>"), then run it with comfyui_run_template.\n` +
          `Ask by task instead: comfyui_templates(task="${knownTasks().slice(0, 6).join('", "')}").\n` +
          `To choose a model before you know the template: comfyui_templates(task="...", recommend=true).`,
        templates: shown.map(row),
        images: [],
      };
    },
  });
}

/** The run tool. */
export function runTemplateTool() {
  return defineTool({
    name: "comfyui_run_template",
    description:
      "Run one ComfyUI workflow template and save its output to the workspace.\n\n" +
      "Use this for anything comfyui_generate's two curated workflows do not cover: video " +
      "generation, image editing, ControlNet and pose control, depth estimation, background " +
      "removal, upscaling, 3D and audio. For a plain text-to-image, prefer comfyui_generate — it " +
      "is faster and already tuned.\n\n" +
      "Call comfyui_templates first to find the right id and to see the inputs it takes; " +
      "values passed in `inputs` override the template's own defaults, and anything omitted " +
      "keeps the template's tuned setting.",
    parameters: {
      template: {
        type: "string",
        required: true,
        description: "Template id, exactly as returned by comfyui_templates.",
      },
      inputs: {
        type: "object",
        required: false,
        description:
          "Input values keyed by the template's own input names, for example {text, steps, width}. " +
          "Omit an entry to keep the template's default.",
      },
      output_dir: {
        type: "string",
        required: false,
        description:
          "Directory to save into, absolute or relative to the workspace. Default ./generated-images.",
      },
    },
    output: {
      schema: templateOutputSchema({ template: { type: "string" } }),
      render(_args, value) {
        const lines = [
          value.ok
            ? `Ran ${value.template} in ${value.elapsed_ms}ms.`
            : `comfyui_run_template failed: ${value.message ?? "unknown error"}`,
        ];
        for (const image of value.images ?? []) lines.push(`- ${image.path}`);
        if (value.output_dir !== undefined) lines.push(`Output directory: ${value.output_dir}`);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const entry = findBlueprint(args.template);
      if (entry === undefined) {
        return {
          ok: false,
          message: `No template matches "${args.template}". Call comfyui_templates to see the catalogue.`,
          images: [],
          template: args.template,
        };
      }

      const overrides = args.inputs !== undefined && typeof args.inputs === "object" ? args.inputs : {};
      // Only forward keys the template actually exposes: an invented input name
      // would otherwise travel into the graph as a node input ComfyUI rejects.
      const exposed = new Set(describe(entry).inputs.map((input) => input.name));
      const clean = {};
      const rejected = [];
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) continue;
        if (exposed.has(key)) clean[key] = value;
        else rejected.push(key);
      }

      const outputDir = resolveOutputDir(args.output_dir, exec);
      const result = await runBlueprint({
        entry,
        overrides: clean,
        timeoutMs: TEMPLATE_TIMEOUT_MS,
        logger: exec?.logger,
        signal: exec?.signal,
      });

      const saved = [];
      const stem = slugify(clean.text ?? entry.title ?? entry.id);
      for (const [index, image] of result.images.entries()) {
        const suffix = result.images.length > 1 ? `-${index + 1}` : "";
        const written = await saveImageTo(image, join(outputDir, `${stem}${suffix}.png`));
        saved.push({ ...written, source: image.filename, url: image.url });
      }

      const notes = [];
      if (rejected.length > 0) {
        notes.push(`Ignored inputs this template does not expose: ${rejected.join(", ")}`);
      }
      if (result.requiredModels.length > 0) {
        notes.push(`Required models: ${result.requiredModels.join(", ")}`);
      }

      return {
        ok: true,
        message: notes.join("\n"),
        template: entry.id,
        title: entry.title,
        install: result.install,
        prompt_id: result.promptId,
        elapsed_ms: result.elapsedMs,
        images: saved,
        output_dir: outputDir,
      };
    },
  });
}