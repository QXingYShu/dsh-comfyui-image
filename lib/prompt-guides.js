/**
 * Official prompt-writing guides, fetched once and kept.
 *
 * A model reads a prompt the way it was trained to, and the difference matters:
 * MiniMax H3 "is more sensitive to prompt structure than most models" because it
 * reads your text with a full multimodal language model, and its guide specifies
 * a three-part structure with a timeline, shot grammar and camera-motion
 * vocabulary. An agent writing "a cat runs across grass" gets something valid;
 * one following the guide gets what the author saw.
 *
 * The guides are not bundled. They are tens of kilobytes per model, they change
 * when the model is retrained, and a stale copy baked into a release is worse
 * than no copy. So they are fetched from the author's own repository — through
 * the same mirror everything else downloads from — and cached on disk.
 *
 * A model with no guide is a normal outcome, not an error: the entry says so,
 * and the local knowledge layer still applies.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mirrorEndpoint } from "./mirror.js";

/**
 * Where each family's guide lives.
 *
 * `files` are repository-relative paths; the mirror URL is built from them at
 * fetch time so a user who pointed the plugin at the origin gets the origin.
 * `kind` is how the document should be read — a full guide is prose to follow,
 * a model card is a broad reference to skim.
 */
export const PROMPT_GUIDES = {
  "MiniMax H3": {
    repo: "MiniMaxAI/MiniMax-H3",
    kind: "guide",
    note: "官方提示词写作指南。H3 对提示词结构最敏感，务必按结构写。",
    files: [
      { path: "docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md", role: "base (T2VA/I2VA/FL2VA/L2VA) 基础模式" },
      { path: "docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md", role: "reference (Ref2VA) 全参照模式" },
    ],
  },
  "Z-Image-Turbo": {
    repo: "Tongyi-MAI/Z-Image",
    kind: "model-card",
    note: "蒸馏模型，步数与 CFG 有硬性建议；无负面提示词通路。",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Z-Image-Base": {
    repo: "Tongyi-MAI/Z-Image",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Qwen-Image": {
    repo: "Qwen/Qwen-Image",
    kind: "model-card",
    note: "文字渲染强；负面提示词有效。",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Qwen-Image 2512": {
    repo: "Qwen/Qwen-Image",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "LTX-2.3": {
    repo: "Lightricks/LTX-Video",
    kind: "model-card",
    note: "视频模型，提示词需写运动与镜头。",
    files: [{ path: "README.md", role: "model card" }],
  },
  "LTX-2.5": {
    repo: "Lightricks/LTX-Video",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Wan 2.2": {
    // Gated: the weights repository answers 401 without an accepted licence,
    // which is the reason a fetch can fail here and must degrade rather than
    // break. Registered on purpose so that path stays exercised.
    repo: "Wan-AI/Wan2.2",
    kind: "model-card",
    gated: true,
    note: "该仓库需要先接受许可才能访问；取不到时会退回本地提示。",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Wan2.1 VACE": {
    repo: "Wan-AI/Wan2.2",
    kind: "model-card",
    gated: true,
    files: [{ path: "README.md", role: "model card" }],
  },
  "Flux.1 Dev": {
    // BFL's own repo is gated too; the Comfy-Org re-pack is not, and it is the
    // one a local install would have fetched the weights from anyway.
    repo: "Comfy-Org/flux1-dev",
    kind: "model-card",
    note: "非商用许可证（FLUX.1-dev Non-Commercial License）。",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Flux.1 Krea Dev": {
    repo: "Comfy-Org/flux1-dev",
    kind: "model-card",
    note: "非商用许可证。",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Flux.2 Dev": {
    repo: "Comfy-Org/flux2-dev",
    kind: "model-card",
    note: "非商用许可证。",
    files: [{ path: "README.md", role: "model card" }],
  },
};

/** Where fetched guides are kept, inside the workspace the agent is working in. */
function cacheDir(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  const base = typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
  return join(base, ".dsh-cache", "comfyui-prompts");
}

/** The raw URL a guide file is fetched from. */
export function guideUrl(guide, file) {
  return `${mirrorEndpoint()}/${guide.repo}/resolve/main/${file.path}`;
}

/**
 * Fetch a family's guides, using the cache when it is current enough.
 *
 * Returns the document text alongside where it came from, so an agent can cite
 * the source rather than presenting guidance as its own. A fetch failure is
 * reported as `unavailable` with the reason — the caller falls back to the
 * local hints instead of failing the request.
 */
export async function loadPromptGuide(family, { exec, signal, maxAgeMs = 7 * 24 * 60 * 60_000 } = {}) {
  const guide = PROMPT_GUIDES[family];
  if (guide === undefined) {
    return { family, available: false, reason: "no official guide is registered for this model", documents: [] };
  }

  const dir = cacheDir(exec);
  const documents = [];
  for (const file of guide.files ?? []) {
    const cached = await readCache(dir, guide.repo, file, maxAgeMs);
    if (cached !== undefined) {
      documents.push({ role: file.role, path: file.path, url: guideUrl(guide, file), text: cached, cached: true });
      continue;
    }
    const url = guideUrl(guide, file);
    try {
      const response = await fetch(url, { signal, redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      await writeCache(dir, guide.repo, file, text).catch(() => {});
      documents.push({ role: file.role, path: file.path, url, text, cached: false });
    } catch (error) {
      documents.push({ role: file.role, path: file.path, url, text: undefined, error: String(error?.message ?? error) });
    }
  }

  const usable = documents.filter((doc) => typeof doc.text === "string" && doc.text !== "");
  // "There is no guide" and "there is one you have not been granted access to"
  // are different answers, and only the second is worth sending someone to a
  // licence page for.
  const gated = usable.length === 0 && guide.gated === true;
  return {
    family,
    available: usable.length > 0,
    kind: guide.kind,
    note: guide.note,
    repo: guide.repo,
    gated,
    reason:
      usable.length === 0
        ? gated
          ? `${guide.repo} is gated: accept its licence on the model page, then this guide becomes readable`
          : `the guide could not be fetched (${documents.map((d) => d.error ?? "empty").join("; ")})`
        : undefined,
    documents: usable,
  };
}

async function readCache(dir, repo, file, maxAgeMs) {
  const path = cachePath(dir, repo, file);
  try {
    const stat = await import("node:fs/promises").then((fs) => fs.stat(path));
    if (Date.now() - stat.mtimeMs > maxAgeMs) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function writeCache(dir, repo, file, text) {
  await mkdir(dir, { recursive: true });
  await writeFile(cachePath(dir, repo, file), text, "utf8");
}

function cachePath(dir, repo, file) {
  const safeRepo = repo.replace(/[^\w.-]+/g, "_");
  const safeFile = file.path.replace(/[^\w.-]+/g, "_");
  return join(dir, `${safeRepo}__${safeFile}`);
}