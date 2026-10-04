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
  runnableTemplates,
} from "./blueprint-runner.js";
import { saveImageTo } from "./generate.js";
import { queryModel, recommendForTask, knownTasks } from "./model-knowledge.js";
import { loadPromptGuide, PROMPT_GUIDES, stripCardNoise } from "./prompt-guides.js";
import { licenseNote, isUnrestricted } from "./model-licenses.js";
import { fetchModelFile } from "./mirror.js";
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

/**
 * Hand back a model's official prompt guide.
 *
 * The text is returned whole, not summarised. The whole point is that H3 wants a
 * three-part structure with a timeline and a camera-motion vocabulary, and a
 * summary of that is the thing that loses it. Where the author has no guide,
 * that is said plainly and the local hints are offered instead, so the agent
 * never has to guess whether silence means "nothing to say".
 */
async function promptGuideResult(family, exec) {
  const guide = await loadPromptGuide(family, { exec });
  const record = queryModel(family);

  if (guide.available === false) {
    const hints = hintsFor(record);
    const gated = guide.gated === true;
    const unverified = guide.reason?.includes("could be matched with confidence") === true;
    return {
      ok: true,
      prompts_available: false,
      prompts_gated: gated,
      message:
        (unverified
          ? `No vendor repository could be matched confidently for "${family}" — the closest search ` +
            `result was a different model, so its documentation is deliberately not registered.`
          : gated
            ? `The author documentation for "${family}" exists but ${guide.repo} is gated — accept its ` +
              `licence on the model page and it becomes readable.`
            : `No author documentation is registered for "${family}" (${guide.reason}).`) +
        (hints.length > 0
          ? `\n\nLocal notes meanwhile:\n${hints.map((hint) => `  - ${hint}`).join("\n")}`
          : `\n\nLook for documentation in the model's own repository before writing a prompt for it.`),
      images: [],
    };
  }

  const parts = [
    `${guide.kind === "prompt-guide" ? "Official prompt guide" : "Author documentation"} for ${guide.family}` +
      `${guide.note === undefined ? "" : ` — ${guide.note}`}`,
    `Source: ${guide.repo} (fetched via mirror; cached for a week)`,
    "",
  ];
  for (const doc of guide.documents) {
    // A dedicated guide is passed through whole; a model card has its badge wall
    // and generated table of contents removed, because for a card the prose is
    // a fraction of the file.
    const text = stripCardNoise(doc.text, guide.kind);
    parts.push(`===== ${doc.role} =====`, `(${doc.url})`, text, "");
  }
  if (hintsFor(record).length > 0) {
    parts.push("===== local notes =====", ...hintsFor(record).map((hint) => `- ${hint}`));
  }

  return {
    ok: true,
    prompts_available: true,
    message: parts.join("\n"),
    guides: guide.documents.map((doc) => ({ role: doc.role, url: doc.url, bytes: doc.text.length })),
    images: [],
  };
}

/** The bilingual hint list, preferring the user's language. */
function hintsFor(record) {
  const hints = record?.promptHints?.zh ?? record?.promptHints?.en ?? [];
  return Array.isArray(hints) ? hints : [];
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
      available: {
        type: "boolean",
        required: false,
        description:
          "Probe the running ComfyUI and mark which templates can actually produce output on this " +
          "machine. Use this before proposing a model: it separates a capability from a wish.",
      },
      prompts: {
        type: "string",
        required: false,
        description:
          "Fetch the official prompt-writing guide for this model family (e.g. 'MiniMax H3', " +
          "'Qwen-Image'). Returns the author's own guide, cached after the first fetch. " +
          "Read it before writing a prompt for that model.",
      },
    },
    output: {
      schema: templateOutputSchema({ templates: { type: "array" } }),
      render(_args, value) {
        return [{ type: "text", text: value.message ?? JSON.stringify(value, null, 2) }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const catalogue = blueprintCatalogue();

      // The prompt guide comes before the catalogue: an agent about to write a
      // prompt needs the author's format, not a list of templates.
      if (typeof args.prompts === "string" && args.prompts !== "") {
        return promptGuideResult(args.prompts, exec);
      }

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
            knowledgeFor(described.model) +
            (PROMPT_GUIDES[described.model] === undefined
              ? ""
              : `\n\nBefore writing a prompt, read the author's own guide:\n` +
                `  comfyui_templates(prompts="${described.model}")`),
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
          // A licence that limits use is part of the recommendation, not a
          // footnote: an agent picking a default for someone whose work is
          // paid needs to see that before it chooses.
          const licence = licenseNote(record.family);
          return (
            `- ${record.label ?? record.family} (${record.speed ?? "standard"})\n` +
            `  ${summary}\n` +
            `  licence: ${licence}\n` +
            (picks.length > 0 ? `  templates: ${picks.slice(0, 3).join(", ")}\n` : "")
          );
        });
        const restricted = suggestions.filter((record) => !isUnrestricted(record.family)).length;
        const warning =
          restricted > 0
            ? `\n${restricted} of these have licence restrictions. Mention them to the user before choosing one for anything commercial.`
            : "";
        return {
          ok: true,
          message: `Models for "${args.task}":\n${lines.join("")}${warning}`,
          templates: suggestions.map((record) => ({
            family: record.family,
            label: record.label ?? record.family,
            speed: record.speed ?? null,
            license: licenseNote(record.family),
          })),
          images: [],
        };
      }

      const filtered = filterCatalogue(catalogue, args);
      const shown = filtered.slice(0, MAX_LISTED);
      const families = new Set(catalogue.map((entry) => entry.model).filter((m) => m !== undefined));

      // Marking what can actually run is the difference between a catalogue and
      // a capability list. Without it the agent cannot tell "this machine
      // cannot do that" from "this machine has not been asked yet", and offers
      // the user a download for something already sitting on disk.
      const availability =
        args.available === true || args.recommend === true
          ? await runnableTemplates(exec?.logger, exec?.signal)
          : undefined;
      const readyById = new Map((availability ?? []).map((item) => [item.entry.id, item]));

      const lines = shown.map((entry) => {
        const model = entry.model === undefined ? "" : ` (${entry.model})`;
        const state = readyById.get(entry.id);
        const marker = state === undefined ? "" : state.ready ? " [READY]" : " [needs models]";
        return `- ${entry.id}: ${entry.title}${model}${marker}`;
      });
      const truncated = filtered.length > shown.length ? `\n... and ${filtered.length - shown.length} more` : "";
      const readyCount = (availability ?? []).filter((item) => item.ready && item.drivesSampler).length;
      const header =
        availability === undefined
          ? `${filtered.length} of ${catalogue.length} templates across ${families.size} model families.`
          : `${filtered.length} of ${catalogue.length} templates across ${families.size} model families; ` +
            `${readyCount} can generate on this machine right now (marked [READY]).`;
      return {
        ok: true,
        message:
          `${header}\n${lines.join("\n")}${truncated}\n\n` +
          `Inspect one with comfyui_templates(template="<id>"), then run it with comfyui_run_template.\n` +
          `Ask by task instead: comfyui_templates(task="${knownTasks().slice(0, 6).join('", "')}").\n` +
          `To choose a model before you know the template: comfyui_templates(task="...", recommend=true).`,
        templates: shown.map((entry) => {
          const state = readyById.get(entry.id);
          return { ...row(entry), ready: state?.ready ?? null, drivesSampler: state?.drivesSampler ?? null };
        }),
        images: [],
      };
    },
  });
}

/**
 * Turn "these weights are absent" into a question worth asking.
 *
 * The agent is the one who has to read this, so the wording says what to do
 * next rather than what went wrong: name the files, their size, where they
 * would land, the licence that governs them, and how much room is left. It
 * deliberately offers the licence constraint up front, because "shall I download
 * this?" asked after the fact is a question about something already spent.
 */
function missingModelsResult(entry, error) {
  const detail = error.detail ?? {};
  const files = detail.files ?? [];
  const alternatives = error.alternatives ?? [];
  const lines = [];
  // The alternative this machine can already run comes first: the question is
  // "can you make an image", and an installed template answers it today while a
  // download answers it in twenty gigabytes.
  if (alternatives.length > 0) {
    lines.push(
      `"${entry.title}" needs models this machine does not have, but ${alternatives.length} other ` +
        `${entry.task ?? "template"} workflow${alternatives.length === 1 ? "" : "s"} can run right now:`,
      "",
    );
    for (const option of alternatives) {
      lines.push(`- ${option.id}: ${option.title}${option.model === undefined ? "" : ` (${option.model})`}`);
    }
    lines.push("");
    lines.push("Ask the user whether to use one of these instead. Only raise downloading if they prefer the exact template.");
    lines.push("");
  } else {
    lines.push(
      `"${entry.title}" cannot run yet — this machine is missing ${files.length} model file(s).`,
      "",
    );
  }
  lines.push("I have not downloaded anything. Model weights are large and their licences differ, so this is your call:");
  if (files.length > 0) lines.push("");
  const restricted = files.filter((file) =>
    file.license !== undefined && /non-commercial|not established|unknown/i.test(file.license),
  );
  for (const file of files) {
    lines.push(`- ${file.name}`);
    lines.push(`    size    : ${file.sizeGb === undefined ? "unknown" : `${file.sizeGb} GB`}`);
    // The licence is the line most likely to change the answer, so a
    // restriction is called out rather than listed like a file size.
    const restrictedHere = /non-commercial/i.test(file.license ?? "");
    lines.push(`    licence : ${file.license ?? "not established"}${restrictedHere ? "   <-- RESTRICTED" : ""}`);
    lines.push(`    from    : ${file.downloadUrl ?? "no known download source — check the model's repository"}`);
    lines.push(`    goes to : ${file.target}`);
    if (file.repo !== undefined) lines.push(`    download: comfyui_run_template(template=..., inputs=..., download=true) fetches it from the mirror`);
  }
  // A release of the same model already on this machine beats a download every
  // time it is offered. Say so first, so the agent can propose running with it
  // instead of spending thirty gigabytes on an exact file name.
  const substitutable = files.filter((file) => file.alternative !== undefined);
  if (substitutable.length > 0) {
    lines.push("");
    lines.push("But this machine already carries another release of these models:");
    for (const file of substitutable) {
      lines.push(`- ${file.name} -> already installed as ${file.alternative.split("/")[1]}`);
    }
    lines.push(
      "Prefer running with the installed release: it is the same model, usually a newer one, and " +
        "needs no download. Only raise the download if the user specifically wants the exact release.",
    );
  }
  lines.push("");
  if (restricted.length > 0) {
    lines.push(
      "Note: some of these carry licence restrictions. Tell the user what they are before offering to download — " +
        "an open download is not an open licence.",
    );
    const alternative = restricted.find((file) => /non-commercial/i.test(file.license ?? ""));
    if (alternative !== undefined && /flux/i.test(entry.model ?? entry.title ?? "")) {
      lines.push(
        "If the use is commercial, FLUX.1-schnell is Apache-2.0 and covers most of the same ground; " +
          "offer it rather than deciding for them.",
      );
    }
    lines.push("");
  }
  if (detail.totalSizeGb !== undefined && detail.totalSizeGb > 0) {
    lines.push("");
    lines.push(`Total download: about ${detail.totalSizeGb.toFixed(1)} GB.`);
  }
  if (detail.freeDiskGb !== undefined) {
    const size = detail.totalSizeGb ?? 0;
    const room = detail.freeDiskGb - size;
    lines.push(
      `Free space on that drive: ${detail.freeDiskGb} GB` +
        (room < 0 ? ` — NOT enough for this download; it would need ${Math.abs(room)} GB more.` : "."),
    );
  }
  lines.push("");
  lines.push("Ask the user whether to download these, which of them they want, and whether the licence suits their use. Do not retry until they answer.");

  return {
    ok: false,
    needs_user_decision: true,
    message: lines.join("\n"),
    template: entry.id,
    title: entry.title,
    missing: error.missing ?? [],
    alternatives,
    detail,
    images: [],
  };
}

/**
 * Fetch the weights a template needs, once the user has asked for them.
 *
 * Only reached through `download=true`, which the caller sets after the report
 * has already shown the sizes, the licences and the free space. Every file
 * goes through the same mirror the ComfyUI process runs on, so there is one
 * source of truth rather than three code paths with three ideas of the origin.
 */
async function downloadMissing(error, exec) {
  const files = (error.detail?.files ?? []).filter((file) => file.repo !== undefined);
  if (files.length === 0) {
    return {
      ok: false,
      message:
        "None of the missing files has a known download source in this plugin. " +
        "Check each model's own repository and download it manually.",
      images: [],
    };
  }
  const done = [];
  for (const file of files) {
    const written = await fetchModelFile(file.repo, pathFor(file), file.target, { signal: exec?.signal });
    done.push({ name: file.name, bytes: written.bytes });
  }
  return { ok: true, downloaded: done };
}

/** The repository-relative path for a catalogued file, defaulting to its name. */
function pathFor(file) {
  return file.repoPath ?? file.name;
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
      download: {
        type: "boolean",
        required: false,
        description:
          "Fetch any missing model weights from the mirror and then run. Only pass this after the " +
          "user has seen the missing-model report and agreed — it puts gigabytes on their disk.",
      },
    },
    output: {
      schema: templateOutputSchema({ template: { type: "string" } }),
      render(_args, value) {
        if (value.needs_user_decision === true) {
          return [{ type: "text", text: value.message }];
        }
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
      let result;
      try {
        result = await runBlueprint({
          entry,
          overrides: clean,
          timeoutMs: TEMPLATE_TIMEOUT_MS,
          logger: exec?.logger,
          signal: exec?.signal,
        });
      } catch (error) {
        // A missing weight is not something the agent should retry around: the
        // download is gigabytes onto the user's disk, which is their call to
        // make. `download=true` is how they have made it — and it is only
        // honoured after they have seen the sizes and the licences.
        if (error?.needsUserDecision === true) {
          if (args.download !== true) return missingModelsResult(entry, error);
          const fetched = await downloadMissing(error, exec);
          if (fetched.ok !== true) return fetched;
          result = await runBlueprint({
            entry,
            overrides: clean,
            timeoutMs: TEMPLATE_TIMEOUT_MS,
            logger: exec?.logger,
            signal: exec?.signal,
          });
        } else {
          throw error;
        }
      }

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
      // Say which release actually ran. Substituting a different release is
      // usually right — the machine owns the model — but the caller should not
      // have to guess whether they got what the template named.
      const swaps = result.substitutions ?? [];
      const releases = swaps.filter((swap) => swap.kind === "release");
      if (releases.length > 0) {
        notes.push(
          `Ran with a different release already installed: ${releases.map((swap) => `${swap.template.split("/")[1]} -> ${swap.using.split("/")[1]}`).join(", ")}`,
        );
      }
      const precisions = swaps.filter((swap) => swap.kind === "precision");
      if (precisions.length > 0) {
        notes.push(
          `Used a different precision of the same model: ${precisions.map((swap) => swap.using.split("/")[1]).join(", ")}`,
        );
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