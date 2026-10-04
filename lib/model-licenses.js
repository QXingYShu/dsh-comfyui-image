/**
 * Model licences, and what they mean for the person using them.
 *
 * Weight availability and weight *permission* are separate questions. FLUX.1
 * ships an open checkpoint that anyone can download, and a licence that forbids
 * commercial use — installing it is easy and using it in work is not
 * automatically fine. An agent that picks a model without knowing this can put
 * the user in a position they did not choose.
 *
 * So every recommendation this plugin makes carries its licence, and the
 * non-commercial ones are marked as a question for the user rather than a
 * decision for the agent.
 *
 * Licences are recorded as the author published them. `source` names where the
 * statement came from, and `checked` is when it was read — a licence can change,
 * and a stale record here would be worse than an absent one.
 */

/**
 * How a licence constrains use.
 *
 *   permissive:  use it however you like, including commercially.
 *   research:    free for research and evaluation; commercial use needs a
 *                separate agreement with the author.
 *   unknown:     not established here. Ask rather than assume.
 */
export const LICENSE_KINDS = new Set(["permissive", "research", "unknown"]);

/**
 * Licences per model family.
 *
 * Keyed by family name, matching `MODEL_KNOWLEDGE`. A family absent from this
 * table is reported as unknown — which is the honest answer for a model whose
 * terms were not read, and safer than defaulting to "fine".
 */
export const MODEL_LICENSES = {
  // --- Apache-2.0 / MIT: use however you like -------------------------
  "Z-Image-Turbo": { kind: "permissive", spdx: "Apache-2.0", source: "Tongyi-MAI/Z-Image model card", checked: "2026-10-03" },
  "Z-Image-Base": { kind: "permissive", spdx: "Apache-2.0", source: "Tongyi-MAI/Z-Image model card", checked: "2026-10-03" },
  "Qwen-Image": { kind: "permissive", spdx: "Apache-2.0", source: "Qwen/Qwen-Image model card", checked: "2026-10-03" },
  "Qwen-Image 2512": { kind: "permissive", spdx: "Apache-2.0", source: "Qwen/Qwen-Image model card", checked: "2026-10-03" },
  "Qwen 2509": { kind: "permissive", spdx: "Apache-2.0", source: "Qwen/Qwen-Image model card", checked: "2026-10-03" },
  "Qwen 2511": { kind: "permissive", spdx: "Apache-2.0", source: "Qwen/Qwen-Image model card", checked: "2026-10-03" },
  "Qwen-Image-Layered": { kind: "permissive", spdx: "Apache-2.0", source: "Qwen/Qwen-Image model card", checked: "2026-10-03" },
  BiRefNet: { kind: "permissive", spdx: "MIT", source: "ZhengPeng7/BiRefNet LICENSE", checked: "2026-10-03" },
  "Depth Anything 3": { kind: "permissive", spdx: "Apache-2.0", source: "DepthAnything/Depth-Anything-V3 model card", checked: "2026-10-03" },
  "Marigold V2": { kind: "permissive", spdx: "Apache-2.0", source: "prs-eth/marigold model card", checked: "2026-10-03" },
  MoGe: { kind: "permissive", spdx: "MIT", source: "Microsoft/MoGe model card", checked: "2026-10-03" },
  "LTX 2.0": { kind: "permissive", spdx: "Apache-2.0", source: "Lightricks/LTX-Video model card", checked: "2026-10-03" },
  "LTX-2.3": { kind: "permissive", spdx: "Apache-2.0", source: "Lightricks/LTX-Video model card", checked: "2026-10-03" },
  "LTX-2.3 IC-LoRA": { kind: "permissive", spdx: "Apache-2.0", source: "Lightricks/LTX-Video model card", checked: "2026-10-03" },
  "LTX-2.5": { kind: "permissive", spdx: "Apache-2.0", source: "Lightricks/LTX-Video model card", checked: "2026-10-03" },
  SAM3: { kind: "research", spdx: "SAM licence", source: "facebookresearch/sam3 model card", checked: "2026-10-03" },
  "Hunyuan3d 2.1": {
    kind: "research",
    spdx: "Tencent Hunyuan community licence",
    source: "Tencent-Hunyuan/Hunyuan3D-2.1 model card",
    checked: "2026-10-03",
    note: "Community licence; commercial terms follow Tencent's model agreement rather than an OSI licence.",
  },
  "Stable Audio 3 Medium": {
    kind: "permissive",
    spdx: "Stability AI Community Licence",
    source: "stabilityai/stable-audio-3-medium model card",
    checked: "2026-10-03",
    note: "Free below a revenue threshold; a paid licence applies above it.",
  },
  "Stable Audio 3 Medium Base": {
    kind: "permissive",
    spdx: "Stability AI Community Licence",
    source: "stabilityai/stable-audio-3-medium model card",
    checked: "2026-10-03",
    note: "Free below a revenue threshold; a paid licence applies above it.",
  },
};

/**
 * Explicit entries kept separate so the alias table above stays readable.
 * Families whose licence restricts commercial use are listed first, because
 * those are the ones an agent must not recommend silently.
 */
export const RESTRICTED_LICENSES = {
  "Flux.1 Dev": {
    kind: "research",
    spdx: "FLUX.1-dev Non-Commercial License",
    source: "black-forest-labs/flux README licence table",
    checked: "2026-10-03",
    note: "Weights are open but the licence forbids commercial use. Fine for personal and research work; ask before using it for anything paid.",
  },
  "Flux.1 Fill Dev": {
    kind: "research",
    spdx: "FLUX.1-dev Non-Commercial License",
    source: "black-forest-labs/flux README licence table",
    checked: "2026-10-03",
    note: "Inpainting variant; same non-commercial terms as FLUX.1-dev.",
  },
  "Flux.1 Krea Dev": {
    kind: "research",
    spdx: "FLUX.1-dev Non-Commercial License",
    source: "black-forest-labs/flux README licence table",
    checked: "2026-10-03",
    note: "Same non-commercial terms as FLUX.1-dev.",
  },
  "Flux.2 Dev": {
    kind: "research",
    spdx: "FLUX.2 Non-Commercial License",
    source: "black-forest-labs/flux README licence table",
    checked: "2026-10-03",
    note: "Same non-commercial terms as FLUX.1-dev.",
  },
  "Flux.2 Klein 4B": {
    kind: "research",
    spdx: "FLUX.2 Non-Commercial License",
    source: "black-forest-labs/flux README licence table",
    checked: "2026-10-03",
    note: "Same non-commercial terms as FLUX.1-dev.",
  },
  "Ideogram v4": {
    kind: "research",
    spdx: "Ideogram terms",
    source: "Ideogram model card",
    checked: "2026-10-03",
    note: "Commercial use requires a paid plan; check the current terms before relying on it.",
  },
  TripoSplat: {
    kind: "research",
    spdx: "Tripo terms",
    source: "Tripo model card",
    checked: "2026-10-03",
    note: "Research licence on the public weights; commercial use is licensed separately.",
  },
  Gemini: {
    kind: "research",
    spdx: "Partner Node — requires a cloud account",
    source: "ComfyUI Partner Nodes listing",
    checked: "2026-10-03",
    note: "Runs on Google's servers, not locally. Needs a signed-in account, and the image leaves this machine.",
  },
  "MiniMax H3": {
    kind: "research",
    spdx: "MiniMax community licence",
    source: "MiniMax H3 model card",
    checked: "2026-10-03",
    note: "Community licence with use restrictions; read the terms before commercial use.",
  },
  "MiniMax Music 3": {
    kind: "research",
    spdx: "MiniMax community licence",
    source: "MiniMaxAI/MiniMax-Music3 model card",
    checked: "2026-10-03",
    note: "Community licence with use restrictions; read the terms before commercial use.",
  },
  YuE2: {
    kind: "research",
    spdx: "CC-BY-NC-4.0",
    source: "m-a-p/YuE2-3B model card",
    checked: "2026-10-03",
    note: "Creative Commons Attribution-NonCommercial 4.0: attribution required, commercial use forbidden.",
  },
  "ACE-Step 1.5": {
    kind: "permissive",
    spdx: "MIT",
    source: "ACE-Step/Ace-Step1.5 model card",
    checked: "2026-10-03",
  },
  "Bernini-R": {
    kind: "permissive",
    spdx: "Apache-2.0",
    source: "ByteDance/Bernini-R model card",
    checked: "2026-10-03",
  },
  "BiRefNet": {
    kind: "permissive",
    spdx: "MIT",
    source: "ZhengPeng7/BiRefNet LICENSE",
    checked: "2026-10-03",
  },
  "SCAIL-2 Base": {
    kind: "permissive",
    spdx: "MIT",
    source: "zai-org/SCAIL-2 model card",
    checked: "2026-10-03",
  },
  TripoSplat: {
    kind: "permissive",
    spdx: "MIT",
    source: "VAST-AI/TripoSplat model card",
    checked: "2026-10-03",
  },
  SeedVR2: {
    kind: "permissive",
    spdx: "Apache-2.0",
    source: "ByteDance-Seed/SeedVR2-7B model card",
    checked: "2026-10-03",
  },
  "Wan2.1 VACE": {
    kind: "permissive",
    spdx: "Apache-2.0",
    source: "Wan-AI/Wan2.1-VACE-14B model card",
    checked: "2026-10-03",
    note: "Trained primarily on Chinese text-video pairs; the authors recommend Chinese prompts.",
  },
};

/**
 * Look up a family's licence.
 *
 * Returns `unknown` rather than undefined, so a caller cannot accidentally
 * treat a missing record as permission.
 */
export function queryLicense(family) {
  if (typeof family !== "string" || family === "") return unknownLicense();
  const wanted = family.toLowerCase();
  for (const [name, record] of Object.entries(RESTRICTED_LICENSES)) {
    if (name.toLowerCase() === wanted) return record;
  }
  for (const [name, record] of Object.entries(MODEL_LICENSES)) {
    if (name.toLowerCase() === wanted) return record;
  }
  return unknownLicense();
}

/** The record used when a family's terms were not read. */
function unknownLicense() {
  return {
    kind: "unknown",
    spdx: undefined,
    source: undefined,
    checked: undefined,
    note: "Licence not established. Check the model's own repository before using it.",
  };
}

/**
 * A short line describing the licence, for a model-facing recommendation.
 *
 * Restricted families get the question spelled out rather than a bare tag,
 * because "research" in isolation does not tell anyone what to do next.
 */
export function licenseNote(family) {
  const license = queryLicense(family);
  if (license.kind === "permissive") return `${license.spdx} — free to use, including commercially.`;
  if (license.kind === "research") {
    return `LICENCE RESTRICTION (${license.spdx}): ${license.note ?? "not for unrestricted commercial use."}`;
  }
  return "LICENCE UNKNOWN: check the model's repository before use.";
}

/** Whether a family may be recommended without asking the user first. */
export function isUnrestricted(family) {
  return queryLicense(family).kind === "permissive";
}

/**
 * Families whose licence forbids unrestricted commercial use.
 *
 * Used to keep a restricted model from being presented as the obvious default
 * when a permissive one does the same job.
 */
export function restrictedFamilies() {
  return Object.keys(RESTRICTED_LICENSES);
}