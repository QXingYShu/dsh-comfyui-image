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
 * (see `resolveBypassedOrigin`). Likewise `PreviewAny` and `PrimitiveNode` are real
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
 * The set of ComfyUI node types that are safe to bypass outright.
 *
 * These are preview widgets: they exist so a human sees a thumbnail while
 * dragging, they have no output wired into anything, and ComfyUI already
 * tolerates their absence — an image the user never previewed is still an image
 * the user can save. Every muted node in the shipped catalogue is one of these.
 *
 * A bypass is *not* on this list. Rewiring one means finding an upstream output
 * of a compatible type, which is real graph surgery; see
 * `resolveBypassedOrigin`.
 */
const BYPASSABLE_TYPES = new Set(["PreviewImage", "MaskPreview", "PreviewAny"]);

/**
 * The concrete type of a node's output, when the canvas states one.
 *
 * ComfyUI's `*` means "whatever arrives here", so it carries no type
 * information at all: a chain of `*` nodes can still carry a STRING, and
 * resolving one is a question about the far end of the chain, not this link.
 * That is why `compliesWith` treats a wildcard as matching only a wildcard.
 */
function declaredType(node, slot) {
  return node?.outputs?.[slot]?.type;
}

/** Whether an upstream type can legally feed a downstream slot. */
function compliesWith(upstreamType, downstreamType) {
  if (upstreamType === undefined || downstreamType === undefined) return false;
  if (upstreamType === "*" || downstreamType === "*") return true;
  return upstreamType === downstreamType;
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

/** Whether a node type is one of the bypassable preview widgets. */
/**
 * Resolve the link a consumer should actually read from.
 *
 * Two kinds of node can stand between a consumer and a real producer:
 *
 * - a `Reroute`, a canvas splint that forwards its single input, and
 * - a muted node, which is not emitted at all.
 *
 * Both are followed through. For a muted node the chain is additionally checked
 * against the type the consumer's slot accepts, because "whatever was going in"
 * is only useful if it fits: the STRING a bypassed `PreviewAny` carries may sit
 * behind two `*` links, and connecting to the first `*` instead would hand a
 * non-string to `CLIPTextEncode.text`.
 */
function resolveBypassedOrigin(link, subgraph, links, nodeTypes, downstreamType) {
  if (link === undefined) return undefined;
  const seen = new Set();

  let current = link;
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);

    const originNode = subgraph.nodes?.find((node) => node.id === current.origin_id);
    const isSplint = PASSTHROUGH_TYPES.has(originNode?.type);
    const isBypassed = originNode !== undefined && isMuted(originNode);

    if (!isSplint && !isBypassed) {
      // A real, emitted node. A concrete upstream type that contradicts the
      // consumer is left for the executor to report; a `*` always complies.
      return current;
    }

    if (isBypassed && !BYPASSABLE_TYPES.has(originNode.type)) {
      // A muted node that is not a preview widget may carry a genuinely
      // different value; refuse rather than rewire it into something else.
      return undefined;
    }

    // Step to whatever fed the node standing in the way.
    const upstream = (subgraph.links ?? []).find(
      (other) => other.target_id === current.origin_id && other.target_slot === current.origin_slot,
    );
    if (upstream === undefined) return undefined;
    const upstreamNode = subgraph.nodes?.find((node) => node.id === upstream.origin_id);
    const upstreamType = declaredType(upstreamNode, upstream.origin_slot);
    if (
      current !== link &&
      upstreamType !== undefined &&
      upstreamType !== "*" &&
      downstreamType !== undefined &&
      downstreamType !== "*" &&
      !compliesWith(upstreamType, downstreamType)
    ) {
      // This hop's type is known and does not fit the consumer; keep looking.
      current = upstream;
      continue;
    }
    current = upstream;
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
      // Neither a splint nor a bypassed node is a real dependency: the consumer
      // depends on whatever ends up feeding it, and counting the intermediary
      // would both invent a cycle and order the graph wrongly.
      if (PASSTHROUGH_TYPES.has(node.type) || isMuted(node)) continue;
      const origin = resolveBypassedOrigin(links.get(input.link), subgraph, links, nodeTypes, input.type);
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

    // A muted node is the canvas's own "bypassed" switch. A preview widget is
    // safe to drop: nothing downstream reads it, and the executor treats the
    // image it would have shown as just another image to save. Anything else
    // has to be rewired to an upstream output of a fitting type, which the
    // consumer loop below does link by link.
    if (isMuted(node) && !BYPASSABLE_TYPES.has(node.type)) {
      throw new Error(
        `blueprint has a bypassed node (${node.type}) whose output is consumed; rewire is not resolvable`,
      );
    }
    if (isMuted(node)) continue;
    const inputs = {};
    const widgets = widgetValues(node);
    for (const input of node.inputs ?? []) {
      if (input.link === undefined || input.link === null) {
        const value = widgets.get(input.name);
        if (value !== undefined) inputs[input.name] = value;
        continue;
      }
      const origin = resolveBypassedOrigin(links.get(input.link), subgraph, links, nodeTypes, input.type);
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
    if (link?.target_id === OUTPUT_NODE_ID) {
      outputSource = resolveBypassedOrigin(link, subgraph, links, nodeTypes, link.type);
    }
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