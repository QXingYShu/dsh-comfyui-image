/**
 * ComfyUI blueprint support.
 *
 * ComfyUI ships a `blueprints/` directory next to `main.py`: one JSON file per
 * task, covering text-to-image, controlnet, video, audio, depth, 3D and more
 * across many model families (116 of them on a stock Comfy Desktop install).
 * That catalogue is what makes "let the agent drive every model" possible
 * without hand-authoring a graph per model.
 *
 * The obstacle is format. A blueprint is a *browser* graph: it carries canvas
 * positions, link objects, widget values, and wraps the real graph in a
 * subgraph. `/prompt` accepts none of that. It wants the API form:
 *
 *     { "3": { class_type: "KSampler", inputs: { seed: 8, ... } } }
 *
 * This module converts between the two.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Virtual node ids the frontend reserves for a subgraph's interface. */
const INPUT_NODE_ID = -10;
const OUTPUT_NODE_ID = -20;

/**
 * Node types that exist only in the browser canvas: notes, reroute splines and
 * bare primitives. They carry no wiring and no server implementation.
 *
 * This list is deliberately short. A type that merely *looks* frontend-only —
 * `PreviewAny` inspects whatever it is given and is a real server node used in
 * shipping templates — must stay here, because dropping it would sever every
 * downstream link instead of removing a decoration.
 */
/**
 * Node types that are pure canvas decoration: notes and markdown notes. They
 * carry no wiring and no server implementation.
 *
 * `Reroute` is not here even though it has no server node either: it is a
 * splint that carries a value from one input to one output, so dropping it
 * would sever every link behind it. Those are resolved by pass-through instead
 * (see `resolveOrigin`). Likewise `PreviewAny` and `PrimitiveNode` are real
 * server nodes that merely look canvas-ish, and shipping templates rely on them.
 */
const FRONTEND_ONLY_TYPES = new Set(["Note", "MarkdownNote"]);

/** Canvas splints: value in, same value out. */
const PASSTHROUGH_TYPES = new Set(["Reroute"]);

/**
 * Values the frontend writes into `widgets_values` right after a seeded widget
 * to record what its "control after generate" button is set to. They are not
 * inputs, and skipping them is what keeps the remaining widget values aligned
 * with their inputs.
 */
const CONTROL_AFTER_GENERATE = new Set([
  "fixed",
  "increment",
  "decrement",
  "randomize",
  "enable",
  "disable",
]);

/**
 * Widgets that carry such a trailing control value. Matching on the name is
 * deliberate: matching on type alone would also swallow a legitimate
 * "enable"/"disable" string an ordinary dropdown happens to contain.
 */
function hasControlAfterGenerate(node, inputName) {
  return /seed|noise/i.test(inputName);
}

/** Slugify a blueprint file name into a stable identifier. */
export function blueprintId(fileName) {
  return fileName
    .replace(/\.json$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Split a blueprint file name into its task and the model it is for:
 * "Text to Image (Z-Image-Turbo).json" -> { task: "Text to Image", model: "Z-Image-Turbo" }.
 */
export function splitBlueprintName(fileName) {
  const base = fileName.replace(/\.json$/i, "");
  const match = base.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (match === null) return { task: base, model: undefined };
  return { task: match[1].trim(), model: match[2].trim() };
}

/** Locate a ComfyUI checkout's blueprint folder. */
export function blueprintsDir(comfyRoot) {
  const dir = join(comfyRoot, "blueprints");
  return existsSync(dir) ? dir : undefined;
}

/**
 * Enumerate the blueprints a checkout ships, newest metadata first.
 * A missing or unreadable directory yields an empty list rather than throwing:
 * an older ComfyUI simply has no blueprints, and the plugin still works.
 */
export function discoverBlueprints(comfyRoot) {
  const dir = blueprintsDir(comfyRoot);
  if (dir === undefined) return [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".json")) continue;
    let raw;
    try {
      raw = readFileSync(join(dir, entry), "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const { task, model } = splitBlueprintName(entry);
    found.push({
      id: blueprintId(entry),
      file: entry,
      title: parsed?.nodes?.[0]?.title ?? task,
      task,
      model,
      raw,
    });
  }
  return found;
}

/**
 * Unwrap a blueprint into the subgraph holding the executable graph.
 * Returns undefined when the file is not the subgraph-wrapped shape this
 * module understands.
 */
export function unwrapBlueprint(blueprint) {
  const subgraphs = blueprint?.definitions?.subgraphs;
  if (!Array.isArray(subgraphs) || subgraphs.length === 0) return undefined;
  const node = (blueprint.nodes ?? []).find((candidate) =>
    subgraphs.some((sub) => sub?.id === candidate?.type),
  );
  if (node === undefined) return undefined;
  const subgraph = subgraphs.find((sub) => sub?.id === node.type);
  if (subgraph === undefined) return undefined;
  return { node, subgraph };
}

/** Index a subgraph's links by id. */
function linkIndex(subgraph) {
  const byId = new Map();
  for (const link of subgraph.links ?? []) {
    if (link && link.id !== undefined) byId.set(link.id, link);
  }
  return byId;
}

/** Whether a node was muted or bypassed in the canvas. */
function isMuted(node) {
  return node?.mode === 2 || node?.mode === 4;
}

/**
 * The subgraph's exposed inputs, in slot order.
 * Slot order matters: the inputNode's output slot number is the index into
 * this array.
 */
export function blueprintInputs(subgraph) {
  const inputs = subgraph?.inputs ?? [];
  return inputs.map((input, slot) => ({
    name: input?.name ?? `input_${slot}`,
    type: input?.type ?? "UNKNOWN",
    slot,
  }));
}

/**
 * Walk a node's widget-backed inputs against its `widgets_values`.
 *
 * `widgets_values` is positional over the node's *widget* inputs only — the
 * linked inputs (model, seed, steps, ...) are absent from it. Consuming a
 * value per widget input, and then skipping the control-after-generate entry
 * that follows a seeded widget, is what keeps the two sequences aligned; get
 * that wrong and every later value lands on the wrong input.
 *
 * Returns a name -> value map so a caller can override one input by name
 * without knowing its position.
 */
function widgetValues(node) {
  const values = new Map();
  const raw = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  let cursor = 0;
  for (const input of node.inputs ?? []) {
    if (input?.widget === undefined) continue;
    if (cursor >= raw.length) break;
    const value = raw[cursor];
    cursor += 1;
    values.set(input.name, value);
    if (hasControlAfterGenerate(node, input.name) && CONTROL_AFTER_GENERATE.has(raw[cursor])) {
      cursor += 1;
    }
  }
  return values;
}

/**
 * The widget a subgraph input feeds, for a given exposed slot.
 *
 * An exposed input reaches its destination through the subgraph's virtual
 * inputNode, so the value lives on the *destination* node rather than on any
 * node the top-level one owns.
 */
function inputNodeTarget(subgraph, links, slot) {
  for (const node of subgraph.nodes ?? []) {
    for (const input of node.inputs ?? []) {
      if (input?.link === undefined || input.link === null) continue;
      const link = links.get(input.link);
      if (link?.origin_id === INPUT_NODE_ID && link.origin_slot === slot) {
        return { node, input };
      }
    }
  }
  return undefined;
}

/**
 * Default value for an exposed subgraph input.
 *
 * A blueprint leaves the top-level interface value blank and keeps the real
 * default on the node the input feeds: "Text to Image (Z-Image-Turbo)" exposes
 * `steps`, and its KSampler carries steps=8 in `widgets_values` even though
 * that widget is wired to the interface. Reading the destination node's own
 * widget value is therefore what makes a template's tuned settings survive an
 * unset interface — and it is the only place the default exists.
 */
export function defaultForSlot(subgraph, links, slot) {
  const target = inputNodeTarget(subgraph, links, slot);
  if (target === undefined) return undefined;
  return widgetValues(target.node).get(target.input.name);
}

/**
 * Follow a link back to whatever actually produces its value.
 *
 * A `Reroute` is a canvas splint with one input and one output, so a link
 * pointing at one really points at whatever feeds the splint. Without this,
 * "Text to Video (LTX-2.3)" loses the VAE behind three downstream nodes and
 * the executor rejects the prompt. Returns undefined when the chain runs into
 * a decoration, a cycle, or nothing at all.
 */
function resolveOrigin(link, links, nodeTypes) {
  let current = link;
  const seen = new Set();
  while (current !== undefined) {
    if (seen.has(current.id)) return undefined;
    seen.add(current.id);
    if (!PASSTHROUGH_TYPES.has(nodeTypes.get(current.origin_id))) return current;
    const splint = links.values().find((other) => other.target_id === current.origin_id);
    current = splint;
  }
  return undefined;
}

/**
 * Order a subgraph's nodes so every producer precedes its consumers.
 *
 * The canvas stores nodes in creation order, which is *not* dependency order:
 * "Text to Image (Z-Image-Turbo)" lists ConditioningZeroOut (id 33) before the
 * CLIPTextEncode (id 27) it consumes. Converting in file order would resolve
 * that link before the node exists, silently dropping a required input — and
 * ComfyUI's rejection ("VAEDecode: Required input is missing: samples") points
 * at a node several steps away from the real cause.
 */
function topologicalOrder(subgraph) {
  const nodes = subgraph.nodes ?? [];
  const links = linkIndex(subgraph);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const nodeTypes = new Map(nodes.map((node) => [node.id, node.type]));

  // Dependency edges: consumer -> the producers it reads from.
  const waitingOn = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const node of nodes) {
    for (const input of node.inputs ?? []) {
      if (input?.link === undefined || input.link === null) continue;
      // A splint is not a dependency: the consumer really depends on whatever
      // the splint forwards, and counting the splint itself would introduce a
      // cycle wherever one is used in a loop back to its own producer.
      if (PASSTHROUGH_TYPES.has(node.type)) continue;
      const origin = resolveOrigin(links.get(input.link), links, nodeTypes);
      if (origin === undefined) continue;
      if (origin.origin_id === INPUT_NODE_ID || origin.origin_id === OUTPUT_NODE_ID) continue;
      if (!byId.has(origin.origin_id) || origin.origin_id === node.id) continue;
      waitingOn.get(node.id).add(origin.origin_id);
    }
  }

  // Kahn's algorithm. Sets — not counters — decide readiness, so a node with
  // two inputs from the same producer is not released early, and a diamond
  // (A -> B, A -> C, B/C -> D) releases D exactly once.
  const ready = nodes.filter((node) => waitingOn.get(node.id).size === 0).map((node) => node.id);
  const emitted = new Set();
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (emitted.has(id)) continue;
    emitted.add(id);
    ordered.push(byId.get(id));
    for (const node of nodes) {
      if (emitted.has(node.id)) continue;
      if (!waitingOn.get(node.id).delete(id)) continue;
      if (waitingOn.get(node.id).size === 0) ready.push(node.id);
    }
  }
  // Anything left is part of a cycle; keep it rather than losing nodes.
  for (const node of nodes) {
    if (!emitted.has(node.id)) ordered.push(node);
  }
  return ordered;
}

/**
 * The largest numeric node id in a subgraph, or -1.
 *
 * Node ids are normally numbers, but a blueprint is untrusted JSON and a
 * non-numeric id must not be allowed to make the save node's id NaN, which
 * would serialise to `null` and be rejected by the executor.
 */
function maxNodeId(subgraph) {
  let max = -1;
  for (const node of subgraph.nodes ?? []) {
    const id = Number(node?.id);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max;
}

/**
 * Convert a blueprint into an API-format prompt graph.
 *
 * `overrides` is keyed by exposed input name (for example `text`, `steps`,
 * `unet_name`); anything omitted keeps the template's own value.
 *
 * Throws with a readable reason rather than emitting a half-built graph: a
 * muted or frontend-only node is a case worth refusing loudly, because the
 * alternative is a silently wrong image.
 */
export function toPromptGraph(blueprint, overrides = {}) {
  const wrapper = unwrapBlueprint(blueprint);
  if (wrapper === undefined) {
    throw new Error("not a subgraph-wrapped blueprint");
  }
  const { subgraph } = wrapper;
  const links = linkIndex(subgraph);
  const exposed = blueprintInputs(subgraph);

  // Resolve every exposed input once: override > template default.
  const provided = new Map();
  for (const input of exposed) {
    const override = overrides[input.name];
    const value = override !== undefined ? override : defaultForSlot(subgraph, links, input.slot);
    if (value !== undefined) provided.set(input.name, value);
  }

  const nodes = topologicalOrder(subgraph);
  const nodeTypes = new Map((subgraph.nodes ?? []).map((node) => [node.id, node.type]));
  const graph = {};
  let outputSource;
  for (const node of nodes) {
    // Canvas decorations carry no wiring and no server implementation; the
    // canvas drops them on submit, so there is nothing to convert. A splint is
    // resolved into the links that reach it, so it is not emitted either.
    if (FRONTEND_ONLY_TYPES.has(node.type) || PASSTHROUGH_TYPES.has(node.type)) continue;
    // A muted node is the canvas's own "bypassed" switch. Reproducing the
    // frontend's pass-through rewrite is a different problem from conversion,
    // so refuse loudly rather than quietly emit a different graph.
    if (isMuted(node)) {
      throw new Error(`blueprint has a muted or bypassed node (${node.type}); pass-through rewiring is not automatic`);
    }
    const inputs = {};
    const widgets = widgetValues(node);
    for (const input of node.inputs ?? []) {
      if (input.link === undefined || input.link === null) {
        const value = widgets.get(input.name);
        if (value !== undefined) inputs[input.name] = value;
        continue;
      }
      const origin = resolveOrigin(links.get(input.link), links, nodeTypes);
      if (origin === undefined) continue;
      if (origin.origin_id === OUTPUT_NODE_ID) continue;
      if (origin.origin_id === INPUT_NODE_ID) {
        const value = provided.get(exposed[origin.origin_slot]?.name);
        if (value !== undefined) inputs[input.name] = value;
        continue;
      }
      if (graph[String(origin.origin_id)] === undefined) continue;
      inputs[input.name] = [String(origin.origin_id), origin.origin_slot];
    }
    // A seeded widget left at "randomize" must become a concrete seed, because
    // the server has no idea what that control means.
    if (inputs.seed !== undefined && CONTROL_AFTER_GENERATE.has(inputs.seed)) {
      inputs.seed = Math.floor(Math.random() * 2 ** 31);
    }
    graph[String(node.id)] = {
      class_type: node.type,
      inputs,
      ...(node.title === undefined ? {} : { _meta: { title: node.title } }),
    };
  }

  // The subgraph's IMAGE output is what the user asked for, but blueprints
  // omit the save node: the executor only persists images from OUTPUT_NODE
  // classes, so without this nothing would ever reach disk.
  for (const link of subgraph.links ?? []) {
    if (link?.target_id === OUTPUT_NODE_ID) outputSource = resolveOrigin(link, links, nodeTypes);
  }
  // The id for the appended save node. It has to clear every id already in
  // use: taking max+1 is not enough when the canvas already had a node with
  // that number, and a collision silently re-points a real input at the save
  // node ("Video Stitch" wires CreateVideo to node 97 and its largest id is 98).
  const saveId = String(maxNodeId(subgraph) + 1);
  if (outputSource === undefined) {
    graph[saveId] = { class_type: "SaveImage", inputs: { filename_prefix: "dsh_blueprint" } };
  } else {
    graph[saveId] = {
      class_type: "SaveImage",
      inputs: { filename_prefix: "dsh_blueprint", images: [String(outputSource.origin_id), outputSource.origin_slot] },
    };
  }

  return graph;
}

/**
 * A compact, model-facing description of one blueprint: enough for an agent to
 * choose between templates without reading 80 KB of canvas JSON.
 */
export function describeBlueprint(entry) {
  let parsed;
  try {
    parsed = JSON.parse(entry.raw);
  } catch {
    return { id: entry.id, title: entry.title, model: entry.model, inputs: [], error: "unreadable JSON" };
  }
  const wrapper = unwrapBlueprint(parsed);
  if (wrapper === undefined) {
    return { id: entry.id, title: entry.title, model: entry.model, inputs: [], error: "unsupported blueprint shape" };
  }
  const links = linkIndex(wrapper.subgraph);
  const inputs = blueprintInputs(wrapper.subgraph).map((input) => ({
    name: input.name,
    type: input.type,
    default: defaultForSlot(wrapper.subgraph, links, input.slot) ?? null,
  }));
  return {
    id: entry.id,
    title: entry.title,
    model: entry.model,
    inputs,
  };
}