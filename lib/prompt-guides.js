/**
 * Author documentation, fetched once and kept.
 *
 * A model reads a prompt the way it was trained to, and the difference matters.
 * MiniMax H3 is unusually strict about it — it reads your text with a full
 * multimodal language model — and its authors publish two dedicated guides, one
 * per mode. Most others do not: across the 67 families ComfyUI ships, H3 is the
 * only one whose prompt rules exist as a document in their own right.
 *
 * That does not make the others useless. The model card is where a vendor
 * states what they trained on, which prompt language they recommend, and what
 * the model is bad at — and an agent that has never read it will not know any of
 * that. `Wan2.1-VACE` says it was trained "primarily on Chinese text-video
 * pairs" and recommends Chinese prompts; nothing in the template says so.
 *
 * So this is "the author's own documentation", not "a prompt guide". Naming it
 * the second would have set an expectation that forty-five of these do not meet.
 *
 * Not bundled. They are tens of kilobytes each, they move when the model is
 * revised, and a stale copy shipped inside a release is worse than none — so
 * they are fetched from the vendor's own repository, through the same mirror
 * everything else downloads from, and cached on disk.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mirrorEndpoint } from "./mirror.js";

/** Where a vendor's model card lives, and what it is for. */
export const PROMPT_GUIDES = {
  // --- A dedicated prompt guide exists. ---------------------------------
  "MiniMax H3": {
    repo: "MiniMaxAI/MiniMax-H3",
    kind: "prompt-guide",
    note: "官方提示词写作指南。H3 对提示词结构最敏感，务必按结构写。",
    files: [
      { path: "docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md", role: "base (T2VA/I2VA/FL2VA/L2VA) 基础模式" },
      { path: "docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md", role: "reference (Ref2VA) 全参照模式" },
    ],
  },

  // --- Vendor repository, reachable. -------------------------------------
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
  "LTX 2.0": {
    repo: "Lightricks/LTX-Video",
    kind: "model-card",
    note: "视频模型；提示词需写运动与镜头。",
    files: [{ path: "README.md", role: "model card" }],
  },
  "LTX-2.3": {
    repo: "Lightricks/LTX-Video",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "LTX-2.5": {
    // The vendor's LTX-2.5 repo is gated; the LTX-Video card is not, and covers
    // the family's prompting conventions.
    repo: "Lightricks/LTX-Video",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Bernini-R": {
    repo: "ByteDance/Bernini-R",
    kind: "model-card",
    note: "Apache-2.0。",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Boogu Turbo": {
    repo: "Boogu/Boogu-Image-0.1-Turbo",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Boogu Image Edit": {
    repo: "Comfy-Org/Boogu-Image",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Ernie Image Turbo": {
    repo: "baidu/ERNIE-Image-Turbo",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Ernie Image": {
    repo: "Comfy-Org/ERNIE-Image",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "FireRed Image Edit 1.1": {
    repo: "FireRedTeam/FireRed-Image-Edit-1.0",
    kind: "model-card",
    note: "仓库版本号为 1.0，与家族名 1.1 不一致；以仓库为准。",
    files: [{ path: "README.md", role: "model card" }],
  },
  "LongCat Image Edit": {
    repo: "meituan-longcat/LongCat-Image",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Joy Image Edit": {
    repo: "Comfy-Org/JoyAI-Image-Edit",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Krea-2 Turbo": {
    repo: "Comfy-Org/Krea-2",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Ideogram v4": {
    repo: "Comfy-Org/Ideogram-4",
    kind: "model-card",
    note: "文字排版见长；商用需付费方案。",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Flux.1 Dev": {
    // BFL's own repo is gated; this is the repack a local install loads from.
    repo: "Comfy-Org/flux1-dev",
    kind: "model-card",
    note: "FLUX.1-dev 非商用许可证。",
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
    note: "FLUX.2 非商用许可证。",
    files: [{ path: "README.md", role: "model card" }],
  },

  // --- Video. Wan states its training language in the card, which is the
  //     single most useful thing an agent can learn about it.
  "Wan 2.2": {
    repo: "Comfy-Org/Wan_2.2_ComfyUI_Repackaged",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Wan2.1 VACE": {
    repo: "Wan-AI/Wan2.1-VACE-14B",
    kind: "model-card",
    note: "官方称主要用中文文本-视频对训练，建议中文提示词。",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Wan Dancer": {
    repo: "Comfy-Org/Wan-Dancer",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Wan Animate 2": {
    repo: "Comfy-Org/Wan-Animate-2",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Wan Animate 2 Distilled": {
    repo: "Comfy-Org/Wan-Animate-2",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },

  // --- Control, depth, matting, upscaling, 3D. --------------------------
  "SCAIL-2 Base": {
    repo: "zai-org/SCAIL-2",
    kind: "model-card",
    note: "MIT。人物替换。",
    files: [{ path: "README.md", role: "model card" }],
  },
  "SCAIL-2 Extend": {
    repo: "zai-org/SCAIL-2",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "SCAIL-2 Int8 Base": {
    repo: "zai-org/SCAIL-2",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "SDPose Multi-Person": {
    repo: "Comfy-Org/SDPose",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "SDPose-OOD": {
    repo: "Comfy-Org/SDPose",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Anima LLLite": {
    repo: "Comfy-Org/Anima-LLLite",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  SAM3: {
    repo: "Comfy-Org/sam3.1",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Depth Anything 3": {
    repo: "Comfy-Org/Depth-Anything-3",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Marigold V2": {
    repo: "Comfy-Org/marigold-v2-0",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  MoGe: {
    repo: "Comfy-Org/MoGe",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  BiRefNet: {
    repo: "ZhengPeng7/BiRefNet",
    kind: "model-card",
    note: "MIT。抠图。",
    files: [{ path: "README.md", role: "model card" }],
  },
  SeedVR2: {
    repo: "ByteDance-Seed/SeedVR2-7B",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  TripoSplat: {
    repo: "VAST-AI/TripoSplat",
    kind: "model-card",
    note: "MIT。图转高斯泼溅。",
    files: [{ path: "README.md", role: "model card" }],
  },
  "Hunyuan3d 2.1": {
    repo: "tencent/Hunyuan3D-2",
    kind: "model-card",
    note: "仓库版本为 2.x；以仓库为准。",
    files: [{ path: "README.md", role: "model card" }],
  },

  // --- Audio. ------------------------------------------------------------
  "ACE-Step 1.5": {
    repo: "ACE-Step/Ace-Step1.5",
    kind: "model-card",
    note: "MIT。音乐/音频生成。",
    files: [{ path: "README.md", role: "model card" }],
  },
  "MiniMax Music 3": {
    repo: "MiniMaxAI/MiniMax-Music3",
    kind: "model-card",
    files: [{ path: "README.md", role: "model card" }],
  },
  YuE2: {
    repo: "m-a-p/YuE2-3B",
    kind: "model-card",
    note: "CC-BY-NC-4.0，禁止商用。",
    files: [{ path: "README.md", role: "model card" }],
  },
};

/**
 * Families deliberately absent.
 *
 * Each of these was searched and the best match was a different model, so
 * registering it would hand an agent a stranger's documentation. Recorded here
 * because the reasoning matters more than the absence does.
 *
 *   VOID, Mediapipe, GAN x4, Anima, Anima Base 1.0, Mage-Flow Turbo,
 *   Mage-Flow-Edit, Mage-Flow-Edit Turbo, Flux.2 Klein 4B, Stable Audio 3
 *
 * `GAN x4` matched a general-purpose upscaler rather than the specific network;
 * `Anima` matched Animagine-XL; `Flux.2 Klein 4B` is published as `klein-9B`,
 * a different size than the family name claims; the Mage-Flow variants all
 * resolved to one community account that does not distinguish them.
 */
export const UNVERIFIED_FAMILIES = new Set([
  "VOID",
  "Mediapipe",
  "GAN x4",
  "Anima",
  "Anima Base 1.0",
  "Mage-Flow Turbo",
  "Mage-Flow-Edit",
  "Mage-Flow-Edit Turbo",
  "Flux.2 Klein 4B",
  "Stable Audio 3 Medium",
  "Stable Audio 3 Medium Base",
]);

/** Where fetched documents are kept, inside the workspace the agent is working in. */
function cacheDir(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  const base = typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
  return join(base, ".dsh-cache", "comfyui-prompts");
}

/** The raw URL a document is fetched from. */
export function guideUrl(guide, file) {
  return `${mirrorEndpoint()}/${guide.repo}/resolve/main/${file.path}`;
}

/**
 * Fetch a family's documentation, using the cache when it is current enough.
 *
 * Returns the text alongside where it came from, so an agent can cite the
 * source rather than presenting a vendor's statement as its own. A fetch
 * failure is reported rather than thrown, and the caller falls back to the local
 * notes — silence is never allowed to read as "nothing to say".
 */
export async function loadPromptGuide(family, { exec, signal, maxAgeMs = 7 * 24 * 60 * 60_000 } = {}) {
  const guide = PROMPT_GUIDES[family];
  if (guide === undefined) {
    const unverified = UNVERIFIED_FAMILIES.has(family);
    return {
      family,
      available: false,
      kind: undefined,
      documents: [],
      reason: unverified
        ? "no vendor repository could be matched with confidence; its documentation is not registered to avoid handing over a different model's"
        : "no author documentation is registered for this model",
    };
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
          ? `${guide.repo} is gated: accept its licence on the model page, then the card becomes readable`
          : `the document could not be fetched (${documents.map((d) => d.error ?? "empty").join("; ")})`
        : undefined,
    documents: usable,
  };
}

/**
 * Strip the badge wall and table of contents from a model card.
 *
 * A Hugging Face README opens with a dozen shields and a generated contents list
 * that together can outrun the prose. For a model card — where the prompting
 * advice is a few paragraphs rather than the whole document — that noise is most
 * of the text, and an agent asked to "read the model card" should get the card.
 * A dedicated guide is passed through untouched: there the structure *is* the
 * content.
 */
export function stripCardNoise(text, kind) {
  if (kind === "prompt-guide") return text;
  const withoutBadges = text
    .replace(/^\s*<p[^>]*>[\s\S]*?<\/p>\s*$/gm, "")
    .replace(/^\s*<img[^>]*>\s*$/gm, "")
    .replace(/^\s*!\[[^\]]*\]\([^)]*\)\s*$/gm, "");
  const withoutToc = withoutBadges.replace(/\n#{1,3}\s*(table of contents|contents|目录)\n[\s\S]*?(?=\n##\s)/i, "\n");
  return withoutToc.replace(/\n{3,}/g, "\n\n").trim();
}

async function readCache(dir, repo, file, maxAgeMs) {
  const path = cachePath(dir, repo, file);
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > maxAgeMs) return undefined;
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