/**
 * ComfyUI discovery and process control.
 *
 * The plugin never assumes a running server: every request resolves an
 * instance descriptor first, connects to it if it is already listening, and
 * otherwise launches the bundled ComfyUI headless and waits for readiness.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Port used when nothing else is configured; ComfyUI's own default. */
export const DEFAULT_PORT = 8188;

/**
 * Per-instance defaults. `probe` identifies the instance by the model file it
 * can serve, so a machine with one Comfy Desktop install can drive both
 * workflows without hard-coded absolute paths.
 */
const INSTANCE_KINDS = {
  "z-image-turbo": {
    id: "z-image-turbo",
    label: "Z-Image-Turbo",
    probe: "z_image_turbo_bf16.safetensors",
    hint: "Comfy Desktop installation named like 'Z-image'.",
    models: {
      unet_name: "z_image_turbo_bf16.safetensors",
      clip_name: "qwen_3_4b.safetensors",
      vae_name: "ae.safetensors",
    },
  },
  "qwen-image-2.1": {
    id: "qwen-image-2.1",
    label: "Qwen-Image-2.1",
    probe: "qwen_image_2.1_int8_convrot.safetensors",
    hint: "Comfy Desktop installation named like 'Qwen-Image-2.1'.",
    models: {
      unet_name: "qwen_image_2.1_int8_convrot.safetensors",
      clip_name: "qwen3vl_8b_int8_convrot.safetensors",
      vae_name: "qwen_image_2.1_vae_bf16.safetensors",
    },
  },
};

/**
 * Locate Comfy Desktop's roaming settings, which records every installation.
 * Returns undefined when Comfy Desktop is not installed for this user.
 */
function desktopSettingsPath() {
  const appData = process.env.APPDATA;
  if (!appData) return undefined;
  const candidate = join(appData, "Comfy Desktop", "installations.json");
  return existsSync(candidate) ? candidate : undefined;
}

/** Read a JSON file, returning undefined instead of throwing. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Shared model roots Comfy Desktop can point an install at. */
function sharedModelRoots() {
  const roots = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData === undefined) return roots;
  roots.push(join(localAppData, "Comfy-Desktop", "ComfyUI-Shared", "models"));
  const installs = join(localAppData, "Comfy-Desktop", "ComfyUI-Installs");
  if (existsSync(installs)) {
    try {
      for (const entry of readdirSync(installs, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        roots.push(join(installs, entry.name, "ComfyUI", "models"));
      }
    } catch {
      /* an unreadable installs folder just narrows the search */
    }
  }
  return roots;
}

/**
 * Whether any model folder this installation can reach contains the probe
 * file.
 *
 * Matching on the probe file rather than the directory name is what keeps an
 * unrelated install (a video model, say) from being picked up: a ComfyUI
 * checkout is only usable here when the workflow's weights are actually
 * visible to it, whether through extra_model_paths.yaml or its own models
 * directory.
 */
function servesProbe(comfyRoot, extraModelPaths, probe) {
  const subfolders = ["diffusion_models", "unet", "checkpoints"];
  const roots = [join(comfyRoot, "models")];
  if (extraModelPaths !== undefined) {
    for (const root of extraModelPathsRoots(extraModelPaths)) roots.push(root);
  }
  roots.push(...sharedModelRoots());
  for (const root of roots) {
    for (const folder of subfolders) {
      if (existsSync(join(root, folder, probe))) return true;
    }
  }
  return false;
}

/**
 * Resolve a generated extra_model_paths.yaml into model roots.
 *
 * Comfy Desktop writes one file per install that points at the shared model
 * directory, so reading it is the only reliable way to know which models a
 * given ComfyUI process would see.
 */
function extraModelPathsRoots(yamlPath) {
  const roots = [];
  let text;
  try {
    text = readFileSync(yamlPath, "utf8");
  } catch {
    return roots;
  }
  // A minimal reader is enough here: we only need base_path values, and the
  // generated file has no other multi-line scalars that matter to us.
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*base_path:\s*'?([^'#\r\n]+?)'?\s*$/);
    if (match !== null) roots.push(match[1].trim());
  }
  return roots;
}

/**
 * Enumerate local ComfyUI installations that can serve the given kind.
 * Comfy Desktop records each standalone install in installations.json; a plain
 * manual checkout is also accepted when the user points config at it.
 */
export function discoverInstallations(kindId) {
  const kind = INSTANCE_KINDS[kindId];
  if (!kind) return [];
  const found = [];
  const seen = new Set();

  const settingsPath = desktopSettingsPath();
  const settings = settingsPath ? readJson(settingsPath) : undefined;
  if (Array.isArray(settings)) {
    for (const entry of settings) {
      if (!entry || typeof entry.installPath !== "string") continue;
      const comfyRoot = join(entry.installPath, "ComfyUI");
      if (!existsSync(join(comfyRoot, "main.py"))) continue;
      if (seen.has(comfyRoot)) continue;
      const extraModelPaths = findExtraModelPaths(comfyRoot);
      if (!servesProbe(comfyRoot, extraModelPaths, kind.probe)) continue;
      const name = String(entry.name ?? entry.id ?? "comfy");
      seen.add(comfyRoot);
      found.push({
        id: `${kindId}:${name}`,
        kind: kindId,
        label: `${kind.label} (${name})`,
        comfyRoot,
        python: resolvePython(comfyRoot, entry.installPath),
        extraModelPaths,
        source: "comfy-desktop",
      });
    }
  }

  // Fall back to a manual checkout supplied by configuration.
  const configured = process.env.DSH_COMFYUI_PATH || process.env.COMFYUI_PATH;
  if (typeof configured === "string" && configured !== "") {
    const comfyRoot = configured;
    if (existsSync(join(comfyRoot, "main.py")) && !seen.has(comfyRoot)) {
      const extraModelPaths = findExtraModelPaths(comfyRoot);
      if (servesProbe(comfyRoot, extraModelPaths, kind.probe)) {
        seen.add(comfyRoot);
        found.push({
          id: `${kindId}:manual`,
          kind: kindId,
          label: `${kind.label} (manual)`,
          comfyRoot,
          python: resolvePython(comfyRoot, comfyRoot),
          extraModelPaths,
          source: "environment",
        });
      }
    }
  }

  // Rank the matches so the installation most likely to have been set up for
  // this workflow is tried first. Every match can already see the models (that
  // is what the probe guarantees), so the name is only a tie-breaker: an
  // install literally named after the model should win over an incidental one.
  found.sort((left, right) => affinity(right, kind) - affinity(left, kind));
  return found;
}

/**
 * How strongly an installation's name or path suggests it was set up for this
 * workflow. Substring matches score higher than the generic "z" prefix that
 * would otherwise make every install look like a match.
 */
function affinity(installation, kind) {
  const haystack = `${installation.id} ${installation.comfyRoot}`.toLowerCase();
  const parts = kind.id.split("-");
  const last = parts[parts.length - 1];
  if (haystack.includes(kind.id)) return 3;
  if (last !== "" && haystack.includes(last) && last.length > 3) return 2;
  return 1;
}

/** Find the interpreter Comfy Desktop uses: the install's own .venv first. */
function resolvePython(comfyRoot, installRoot) {
  const candidates = [
    join(comfyRoot, ".venv", "Scripts", "python.exe"),
    join(comfyRoot, ".venv", "bin", "python"),
    join(installRoot ?? "", "standalone-env", "python.exe"),
    join(installRoot ?? "", "standalone-env", "Scripts", "python.exe"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "python";
}

/**
 * Prefer a generated extra_model_paths.yaml: Comfy Desktop writes one per
 * install pointing at the shared model directory, and it matters which one we
 * pass, because a bare ComfyUI launch would otherwise miss the shared models.
 */
function findExtraModelPaths(comfyRoot) {
  const local = join(comfyRoot, "extra_model_paths.yaml");
  if (existsSync(local)) return local;
  const sharedDir = join(
    process.env.LOCALAPPDATA ?? "",
    "Comfy-Desktop",
    "ComfyUI-Installs",
  );
  if (!existsSync(sharedDir)) return undefined;
  try {
    for (const entry of readdirSync(sharedDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(sharedDir, entry.name, "ComfyUI", "extra_model_paths.yaml");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* a missing or unreadable installs folder simply means "no extra paths" */
  }
  return undefined;
}

/** Public description of one kind, for tool schemas and diagnostics. */
export function kinds() {
  return Object.values(INSTANCE_KINDS).map(({ id, label, hint, models }) => ({ id, label, hint, models }));
}

/**
 * A lazily-started headless ComfyUI process bound to one port.
 * The same process is reused by every request for the same port, so repeated
 * generations do not pay model-load cost again.
 */
export class ComfyInstance {
  constructor(descriptor, port, logger) {
    this.descriptor = descriptor;
    this.port = port;
    this.logger = logger;
    this.child = undefined;
    this.starting = undefined;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Probe the server's /system_stats; resolves undefined when unreachable. */
  async probe(signal) {
    try {
      return await getJson(`${this.baseUrl}/system_stats`, 2000, signal);
    } catch {
      return undefined;
    }
  }

  /** Ensure a live server, launching headless ComfyUI when necessary. */
  async ensure(signal, extraArgs = []) {
    const existing = await this.probe(signal);
    if (existing !== undefined) return { launched: false };

    if (this.child === undefined && this.starting === undefined) {
      this.starting = this.#launch(extraArgs);
    }
    const launched = await this.starting;
    if (launched.ok) return { launched: true };
    // A failed launch leaves no child to clean up; surface the real reason.
    throw new Error(
      `could not start ComfyUI for ${this.descriptor.label} on port ${this.port}: ${launched.error}`,
    );
  }

  async #launch(extraArgs) {
    const { comfyRoot, python, extraModelPaths } = this.descriptor;
    const args = ["main.py", "--listen", "127.0.0.1", "--port", String(this.port)];
    if (extraModelPaths !== undefined) args.push("--extra-model-paths-config", extraModelPaths);
    args.push(...extraArgs);

    this.logger?.info?.(`[dsh-comfyui-image] launching ComfyUI: ${python} ${args.join(" ")}`);
    const child = spawn(python, args, {
      cwd: comfyRoot,
      windowsHide: true,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    let logTail = "";
    const capture = (chunk) => {
      logTail = `${logTail}${chunk}`.slice(-4000);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("exit", (code) => {
      this.child = undefined;
      this.starting = undefined;
      this.logger?.warn?.(
        `[dsh-comfyui-image] ComfyUI on port ${this.port} exited with code ${code}`,
      );
    });

    const ready = await this.#waitUntilReady(logTail);
    if (!ready.ok) {
      this.stop();
      return { ok: false, error: ready.error };
    }
    this.logger?.info?.(`[dsh-comfyui-image] ComfyUI ready at ${this.baseUrl}`);
    return { ok: true };
  }

  /** Poll /system_stats until the server answers or the deadline passes. */
  async #waitUntilReady(logTail) {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const answered = await this.probe(undefined).catch(() => undefined);
      if (answered !== undefined) return { ok: true };
      await delay(1000);
    }
    return {
      ok: false,
      error: `server did not become ready within 240s. Last log output: ${logTail.slice(-800) || "(empty)"}`,
    };
  }

  /** Terminate the process this instance started, if any. */
  stop() {
    const child = this.child;
    this.child = undefined;
    this.starting = undefined;
    if (child === undefined) return;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Sleep helper. */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET a JSON document with a short timeout. */
export async function getJson(url, timeoutMs, signal) {
  const response = await fetchWithTimeout(url, { method: "GET" }, timeoutMs, signal);
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return response.json();
}

/** POST a JSON document with an explicit timeout. */
export async function postJson(url, body, timeoutMs, signal) {
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
    signal,
  );
  const text = await response.text();
  let payload;
  try {
    payload = text === "" ? {} : JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.raw ?? `HTTP ${response.status}`;
    const error = new Error(`POST ${url} -> ${detail}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

/** fetch() with an abort-driven timeout that composes with the caller signal. */
async function fetchWithTimeout(url, init, timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}