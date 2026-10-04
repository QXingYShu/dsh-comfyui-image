/**
 * Where model weights are fetched from.
 *
 * Hugging Face is often slow or unreachable from mainland China, and ComfyUI's
 * own downloader goes straight to it. Setting `HF_ENDPOINT` on the ComfyUI
 * process is what redirects that: `huggingface_hub`, and anything built on it
 * inside ComfyUI, reads that variable at import time and rewrites every URL it
 * builds. Without it the plugin can *tell* the user a mirror URL and still see
 * ComfyUI crawl to huggingface.co the moment they install a model by hand.
 *
 * `HF_HUB_ENABLE_HF_TRANSFER` is deliberately left alone: it selects a Rust
 * downloader that the mirror does not serve, and turning it on turns a slow
 * download into a failed one.
 */

/** The mirror used unless configuration says otherwise. */
export const DEFAULT_MIRROR = "https://hf-mirror.com";

/**
 * The mirror to use.
 *
 * Overridable because the right answer is not universal: a machine with direct
 * access is better off on the origin, and `HF_ENDPOINT` set in the environment
 * is the user telling us so.
 */
export function mirrorEndpoint() {
  const configured = process.env.DSH_HF_ENDPOINT ?? process.env.HF_ENDPOINT;
  if (typeof configured !== "string" || configured === "") return DEFAULT_MIRROR;
  return configured.replace(/\/+$/, "");
}

/**
 * Environment for a ComfyUI child process.
 *
 * Merged over `process.env` rather than replacing it, so the interpreter still
 * finds its own `PATH` and the model paths Comfy Desktop configured are intact.
 */
export function comfyEnv(extra = {}) {
  return {
    ...process.env,
    // Read by huggingface_hub at import time; this is the whole mechanism.
    HF_ENDPOINT: mirrorEndpoint(),
    ...extra,
  };
}

/**
 * A direct download URL for a repository file.
 *
 * Built from the same mirror the ComfyUI process will use, so a URL printed for
 * the user and a URL ComfyUI fetches agree.
 */
export function downloadUrl(repo, path) {
  if (typeof repo !== "string" || repo === "" || typeof path !== "string" || path === "") {
    return undefined;
  }
  return `${mirrorEndpoint()}/${repo}/resolve/main/${path}`;
}

/** The same URL as a URL object, or undefined when either part is missing. */
export function downloadUrlObject(repo, path) {
  const text = downloadUrl(repo, path);
  return text === undefined ? undefined : new URL(text);
}

/**
 * Fetch one model file into place.
 *
 * The plugin does not download weights on its own initiative — that is the
 * user's call, and `missingModelReport` exists to put the question to them.
 * This is what runs once they have said yes, and it exists so the download
 * agrees with the URL they were shown and with the endpoint ComfyUI was started
 * on, rather than being a third code path with its own idea of the origin.
 *
 * Downloads to a temporary name and renames on completion, so an interrupted
 * transfer cannot leave a truncated file that ComfyUI would later try to load
 * and fail on with a confusing error.
 */
export async function fetchModelFile(repo, path, target, { signal, onProgress } = {}) {
  const url = downloadUrl(repo, path);
  if (url === undefined) {
    throw new Error(`no download source is known for ${repo}/${path}`);
  }
  const partial = `${target}.partial`;
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`download failed: ${url} -> HTTP ${response.status}`);
  }

  const total = Number(response.headers.get("content-length") ?? 0);
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    received += chunk.length;
    onProgress?.(received, total);
  }

  const { mkdir, rename, unlink, writeFile } = await import("node:fs/promises");
  await mkdir(dirnameOf(target), { recursive: true });
  try {
    await writeFile(partial, Buffer.concat(chunks));
    await rename(partial, target);
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
  return { path: target, bytes: received, url };
}

/** Local helper so the dynamic import above stays minimal. */
function dirnameOf(path) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? "." : path.slice(0, index);
}