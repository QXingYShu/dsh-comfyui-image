/**
 * One image generation: resolve an instance, render the workflow, queue it,
 * wait for completion, and read the finished image back out of ComfyUI.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  delay,
  discoverInstallations,
  getJson,
  postJson,
  sharedInstance,
  stopAllInstances,
} from "./comfy.js";
import { renderWorkflow, roundTo32 } from "./workflows.js";

/** How long to wait for one generation before giving up. */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** Ports probed in order when nothing is configured. */
const DEFAULT_PORTS = [8188, 8189, 8190, 8191, 8192];

/** Read the plugin's configured port for a kind, or the default. */
function configuredPort(kindId) {
  const envKey = `DSH_COMFY_PORT_${kindId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  const raw = process.env[envKey] ?? process.env.DSH_COMFY_PORT;
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Get (or create) the instance that will serve this kind.
 *
 * Resolution order: an explicit port from configuration, then any configured
 * port that already answers, then the first port a probe finds live, and
 * finally the default port, which the caller will launch.
 */
async function resolveInstance(kindId, logger, signal) {
  const installations = discoverInstallations(kindId);
  const descriptor = installations[0];
  const explicit = configuredPort(kindId);
  const candidates = explicit !== undefined ? [explicit] : DEFAULT_PORTS;

  // Attach to anything already listening before considering a launch, and go
  // through the shared registry so a template run and a text-to-image run land
  // on the same ComfyUI process rather than each starting their own.
  for (const port of candidates) {
    const instance = sharedInstance(descriptor, port, logger);
    if ((await instance.probe(signal)) !== undefined) return { instance, descriptor, reused: true };
  }

  const port = explicit ?? candidates[candidates.length - 1];
  return { instance: sharedInstance(descriptor, port, logger), descriptor };
}

/** Report what a kind can do and whether this machine looks ready to run it. */
export function describeKind(kindId) {
  const installations = discoverInstallations(kindId);
  return {
    kind: kindId,
    installations: installations.map((installation) => ({
      id: installation.id,
      label: installation.label,
      comfyRoot: installation.comfyRoot,
      source: installation.source,
    })),
    ready: installations.length > 0,
  };
}

/**
 * Queue one API-format graph on a live instance and resolve with the images.
 *
 * This is the shared tail of every generation: the caller only has to hand
 * over a graph. Keeping it separate from the instance resolution is what lets
 * a blueprint run — which may come from any ComfyUI checkout, not only one
 * that was installed for a particular model — reuse the same polling, timeout
 * and image-collection behaviour.
 */
export async function runGraph(instance, graph, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  await instance.ensure(signal);
  const queued = await postJson(`${instance.baseUrl}/prompt`, { prompt: graph }, 60_000, signal);
  const id = queued.prompt_id;
  if (typeof id !== "string") {
    throw new Error(`ComfyUI accepted the prompt but returned no prompt_id: ${JSON.stringify(queued)}`);
  }

  const started = Date.now();
  const deadline = started + timeoutMs;
  const pollMs = 1500;
  while (Date.now() < deadline) {
    await delay(pollMs);
    let history;
    try {
      history = await getJson(`${instance.baseUrl}/history/${id}`, 15_000, signal);
    } catch {
      // A dropped poll is not a failure; the next tick retries.
      continue;
    }
    const entry = history?.[id];
    if (entry === undefined) continue;

    const status = entry.status ?? {};
    const images = collectImages(entry.outputs);
    const elapsedMs = Date.now() - started;

    if (status.status_str === "error") {
      const messages = (status.messages ?? [])
        .filter(([type]) => type === "execution_error")
        .map(([, payload]) => payload?.exception_message ?? "unknown error");
      throw new Error(`ComfyUI execution failed after ${elapsedMs}ms: ${messages.join("; ") || "see the ComfyUI log"}`);
    }
    if (status.completed === true) {
      if (images.length === 0) {
        throw new Error(`ComfyUI finished prompt ${id} but produced no images`);
      }
      return {
        promptId: id,
        elapsedMs,
        images: images.map((image) => ({
          filename: image.filename,
          subfolder: image.subfolder ?? "",
          type: image.type ?? "output",
          url: imageUrl(instance.baseUrl, image),
        })),
        server: instance.baseUrl,
      };
    }
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ComfyUI prompt ${id}. The job may still be running; check ${instance.baseUrl}.`,
  );
}

/**
 * Queue one workflow and resolve with the produced images.
 *
 * The returned images are described the way ComfyUI addresses them, so the
 * caller can either keep the remote URL or copy the bytes to a local path.
 */
export async function generate(options) {
  const {
    kindId,
    spec,
    template,
    parameters,
    models,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger,
    signal,
  } = options;

  const { instance, descriptor } = await resolveInstance(kindId, logger, signal);
  if (descriptor === undefined) {
    throw new Error(
      `no local ComfyUI installation was found that can serve ${kindId}. ` +
        `Install Comfy Desktop with the matching template, or set DSH_COMFYUI_PATH to a ComfyUI checkout whose models contain ${models.unet_name}.`,
    );
  }

  const width = roundTo32(parameters.width ?? spec.defaults.width);
  const height = roundTo32(parameters.height ?? spec.defaults.height);
  // Defaults first, then only the keys the caller actually supplied. Spreading
  // `parameters` wholesale would let an explicitly-present-but-undefined key
  // (the natural shape of a tool-argument object) erase the default it should
  // have fallen back to, which the renderer then reports as a missing
  // parameter rather than as the argument mistake it is.
  const merged = { ...spec.defaults, ...models };
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) merged[key] = value;
  }
  merged.width = width;
  merged.height = height;

  const graph = renderWorkflow(template, spec, merged);
  return runGraph(instance, graph, { timeoutMs, signal });
}

/** Flatten ComfyUI's per-node output structure into one image list. */
function collectImages(outputs) {
  const images = [];
  for (const nodeOutput of Object.values(outputs ?? {})) {
    for (const image of nodeOutput?.images ?? []) {
      if (typeof image?.filename === "string") images.push(image);
    }
  }
  return images;
}

/** Build the URL ComfyUI serves one stored image from. */
function imageUrl(baseUrl, image) {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? "",
    type: image.type ?? "output",
  });
  return `${baseUrl}/view?${params.toString()}`;
}

/**
 * Copy one produced image to a local path.
 *
 * The ComfyUI output directory is shared and managed by Comfy Desktop, so the
 * agent asks for its own copy inside the workspace instead of handing back a
 * path into an application-owned folder.
 */
export async function saveImageTo(image, targetPath) {
  const response = await fetch(image.url);
  if (!response.ok) {
    throw new Error(`could not download ${image.filename}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(join(targetPath, ".."), { recursive: true });
  await writeFile(targetPath, bytes);
  return { path: targetPath, bytes: bytes.length, filename: basename(targetPath) };
}

/**
 * Stop every ComfyUI process this plugin started. Used on dispose.
 *
 * Goes through the shared registry, so this is the same set the template runner
 * uses. Two separate shutdown paths could each kill half the picture and leave
 * an agent holding a server that had just been stopped underneath it.
 */
export function stopAll() {
  stopAllInstances();
}