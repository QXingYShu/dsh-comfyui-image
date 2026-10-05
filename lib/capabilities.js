/**
 * What a model can actually do, derived from the templates that drive it.
 *
 * The knowledge layer records what a model is *for*, written by hand. That is
 * the wrong source for a question like "can this do image-to-image", because a
 * capability is a property of a template's inputs, not a matter of opinion: the
 * graph takes an IMAGE and cannot do otherwise. Asking a human to keep 67
 * records in step with 116 templates is how `Qwen-Image` ended up not appearing
 * when asked for image-to-image — it has six templates that take an image, and
 * the record never said so.
 *
 * So capability here is read off the blueprints, and the hand-written `bestFor`
 * is kept for ranking only. A template that accepts an IMAGE makes the model
 * answer to `image-to-image`; one that takes a MASK also answers to
 * `image-inpainting`; one that takes no image at all does not, however good it
 * is.
 */

import { unwrapBlueprint } from "./blueprint.js";
import { taskKey } from "./blueprint-runner.js";

/**
 * Input type -> capability it establishes.
 *
 * `IMAGE` is the one that matters most and was the one most often missing: a
 * model with an image-taking template is an image-to-image model whether or not
 * anybody remembered to say so.
 */
const TYPE_CAPABILITY = new Map([
  ["IMAGE", "image-to-image"],
  ["VIDEO", "video-to-video"],
  ["AUDIO", "audio-to-audio"],
  ["MASK", "image-inpainting"],
]);

/** Task words -> the capability they ask about, so a question maps to an answer. */
const TASK_ALIASES = new Map([
  ["text to image", "text-to-image"],
  ["image to image", "image-to-image"],
  ["image edit", "image-edit"],
  ["edit image", "image-edit"],
  ["image inpainting", "image-inpainting"],
  ["image outpainting", "image-outpainting"],
  ["character replacement", "image-edit"],
  ["image to layers", "image-edit"],
  ["video to video", "video-to-video"],
  ["text to video", "video"],
  ["image to video", "video"],
]);

/**
 * The template task a capability implies, for the ones where the template's own
 * wording does not already say it. Inpainting and outpainting templates name
 * their model under an edit-ish task, and a caller asking "image-inpainting"
 * should still find them.
 */
const CAPABILITY_FROM_TASK = new Map([
  ["image inpainting", "image-inpainting"],
  ["image outpainting", "image-outpainting"],
  ["character replacement", "image-edit"],
]);

/** Cache: parsing 116 blueprints is not something to do per question. */
const capabilityCache = new Map();

/**
 * Every capability each model family demonstrates, from its templates.
 *
 * Returns a map of family -> Set of capability, including the two curated
 * workflows, which have no blueprint and are added by their own definition.
 */
export function modelCapabilities(catalogue) {
  const key = catalogue.map((entry) => entry.id).join("|");
  const cached = capabilityCache.get(key);
  if (cached !== undefined) return cached;

  const byFamily = new Map();
  const add = (family, capability) => {
    if (typeof family !== "string" || family === "") return;
    const name = family.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!byFamily.has(name)) byFamily.set(name, new Set());
    byFamily.get(name).add(capability);
  };

  for (const entry of catalogue) {
    let subgraph;
    try {
      subgraph = unwrapBlueprint(JSON.parse(entry.raw))?.subgraph;
    } catch {
      continue;
    }
    if (subgraph === undefined) continue;

    const task = taskKey(entry);
    const declared = TASK_ALIASES.get(task) ?? TASK_ALIASES.get(task.replace(/\s+/g, " "));
    if (declared !== undefined) add(entry.model, declared);
    if (CAPABILITY_FROM_TASK.has(task)) add(entry.model, CAPABILITY_FROM_TASK.get(task));

    for (const input of subgraph.inputs ?? []) {
      const capability = TYPE_CAPABILITY.get(input?.type);
      if (capability !== undefined) add(entry.model, capability);
    }
  }

  capabilityCache.set(key, byFamily);
  return byFamily;
}

/** The key a family is stored under. */
export function capabilityKey(family) {
  return String(family ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * What one family can do, as a set.
 *
 * The curated workflows are added here rather than derived: they have no
 * blueprint, and they are the two the user reaches for first, so a question
 * about them must not come back empty.
 */
export function capabilitiesOf(family, catalogue) {
  const byFamily = modelCapabilities(catalogue);
  return new Set(byFamily.get(capabilityKey(family)) ?? []);
}

/**
 * Families that can do `task`, by capability rather than by declaration.
 *
 * Falls back to the hand-written `bestFor` when no templates could be read —
 * a missing capability list should narrow the answer, not empty it, because the
 * alternative is telling the agent a model cannot do something it demonstrably
 * can.
 */
export function familiesForTask(task, catalogue, records) {
  const wanted = TASK_ALIASES.get(taskKey({ task })) ?? String(task).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const byFamily = modelCapabilities(catalogue);

  if (byFamily.size === 0) {
    return records
      .filter((record) => (record.bestFor ?? []).includes(wanted))
      .map((record) => record.family);
  }

  const capable = new Set();
  for (const [key, capabilities] of byFamily) {
    if (capabilities.has(wanted)) capable.add(key);
  }

  const names = new Map(records.map((record) => [capabilityKey(record.family), record.family]));
  return [...capable].map((key) => names.get(key)).filter((name) => name !== undefined);
}