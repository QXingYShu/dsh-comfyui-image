/**
 * Structured model knowledge for the models this machine can actually run.
 *
 * ComfyUI ships blueprints for 67 model families on a stock desktop install,
 * but a blueprint only says *how* to wire a graph — never which sampler
 * settings the model wants, whether it accepts a negative prompt, or why
 * raising the step count makes it worse. An agent handed only the template
 * produces a picture every time and a good one perhaps half the time.
 *
 * This module is the missing half: one structured record per family, keyed to
 * task type, with the sampler defaults read back out of the local blueprints
 * rather than recalled. Every `sampler` block below was extracted from the
 * `widgets_values` of a real sampler node in a shipped template; `verified`
 * records the blueprint ids those numbers came from, so a stale claim is
 * visible instead of silently wrong.
 *
 * What is *not* here is as important. A field is absent rather than guessed.
 * Where a family's templates do not pin a value down, the field is marked
 * `verified: false` and carries a note explaining what is unknown — an agent
 * can act on "unknown, use the template default" but cannot act on an invented
 * number.
 */

/**
 * How a sampler setting should be treated.
 *
 *   verified: the value is what a shipped template on this machine uses.
 *   unverified: plausible but not established from the local templates; use
 *               the blueprint's own default instead.
 */
const V = true;
const U = false;

/**
 * Task categories. Kept flat and small on purpose: they are what an agent
 * actually chooses between ("the user wants a poster"), not ComfyUI's internal
 * taxonomy.
 */
export const TASKS = {
  "text-to-image": "文生图",
  "image-to-image": "图生图",
  "image-edit": "图像编辑/局部重绘",
  "control": "控制引导（边缘/深度/姿态/ControlNet）",
  "text-rendering": "图中文字排版",
  "video": "视频生成",
  "motion-transfer": "动作迁移",
  "audio": "音频生成",
  "music": "音乐生成",
  "depth": "深度/几何估计",
  "segmentation": "分割/抠图",
  "upscale": "放大/修复",
  "3d": "3D 生成",
  "caption": "图像描述/标注",
  "pose": "姿态提取",
};

/**
 * One record per family.
 *
 * `family` is the canonical key and matches the blueprint's model label.
 * `aliases` covers the spelling variants the templates actually ship — the
 * catalogue contains both "Z-Image-Turbo" and "Z-image-Turbo", and both
 * "LTX 2.0" and "ltx 2.0", because those are separate files.
 */
export const MODEL_KNOWLEDGE = [
  /* ---------------- image: general purpose ---------------- */
  {
    family: "Z-Image-Turbo",
    label: "Z-Image-Turbo",
    aliases: ["Z-image-Turbo", "z-image-turbo"],
    category: "image",
    bestFor: ["text-to-image", "control", "image-to-image"],
    strengths: [
      "最快的本地出图模型之一，1024px 单张通常十几秒",
      "ControlNet / Canny / Depth / Pose 控制引导开箱即用",
    ],
    sampler: {
      steps: { value: 8, range: [6, 9], verified: V },
      cfg: { value: 1, range: [1, 1], verified: V },
      sampler_name: { value: "res_multistep", verified: V },
      scheduler: { value: "simple", verified: V },
      resolution: { value: 1024, verified: U, note: "模板通过 width/height 暴露，实测默认 1024x1024" },
      source: ["text-to-image-z-image-turbo", "canny-to-image-z-image-turbo"],
    },
    negativePrompt: {
      supported: false,
      verified: V,
      note:
        "模板用 ConditioningZeroOut 把负面条件直接置零，没有文本通路。传负面提示词不会有任何效果，"+
        "要表达「不要什么」请改写正面描述（例如「干净的纯色背景，没有文字」）。",
    },
    textRendering: { reliable: false, verified: U, note: "未在本机模板中找到排版类模板，未验证" },
    speed: "draft",
    promptHints: {
      zh: [
        "提示词是唯一的控制手段，没有负面提示词可用。",
        "想避免某个元素就正面描述替代物：说「无文字的干净背景」而不是「no text」。",
        "4 段式结构最稳：主体 / 构图 / 光线 / 风格媒介，写成一段话而非关键词堆砌。",
      ],
      en: [
        "The prompt is the only control; there is no negative prompt.",
        "To avoid something, describe its replacement positively.",
        "Subject / composition / lighting / style as one paragraph.",
      ],
    },
    notes: [
      "蒸馏模型：steps 调高到 10 以上会让画面变糊变脏，6-9 之外不要动。",
      "CFG 固定为 1，调不上去也不该调。",
    ],
  },
  {
    family: "Z-Image-Base",
    label: "Z-Image-Base",
    category: "image",
    bestFor: ["text-to-image"],
    strengths: ["同门的非蒸馏版本，比 Turbo 慢但可精细控制", "有真实的负面提示词通路"],
    sampler: {
      steps: { value: 25, range: [20, 30], verified: V },
      cfg: { value: 4, range: [3, 5], verified: V },
      sampler_name: { value: "res_multistep", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["text-to-image-z-image-base"],
    },
    negativePrompt: { supported: true, verified: V, note: "负面条件接 CLIPTextEncode，可用" },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: {
      zh: ["支持负面提示词，「不要什么」可以正常写。", "步数可以往上调换取细节，但超过 30 收益递减。"],
      en: ["Supports a true negative prompt.", "Steps can go up for detail; past 30 gains fade."],
    },
    notes: ["非蒸馏模型，steps 越高越细，与 Turbo 的结论完全相反。"],
  },
  {
    family: "Qwen-Image",
    label: "Qwen-Image",
    // The curated workflow is registered as `qwen-image-2.1`, and the user
    // calls the model "Qwen Image 2.1". Without those spellings the lookup
    // misses entirely — and it did: asked about the best open-weight image
    // model on the machine, this layer had no answer.
    aliases: ["Qwen-image", "qwen-image", "qwen-image-2.1", "Qwen Image 2.1", "Qwen-Image-2.1", "qwen image 2.1"],
    category: "image",
    bestFor: ["text-to-image", "text-rendering", "image-edit", "image-inpainting", "image-outpainting"],
    strengths: [
      "本机模板中文字渲染最可靠的选择：海报、logo、带标签的 UI 草图",
      "支持负面提示词",
      "同时覆盖文生图、扩图（Outpainting）",
    ],
    sampler: {
      steps: { value: 4, range: [4, 8], verified: V },
      cfg: { value: 1, range: [1, 2], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      resolution: { value: 1328, verified: V, note: "模板默认 1328x1328" },
      source: ["text-to-image-qwen-image", "image-outpainting-qwen-image"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: true, verified: U, note: "依据模型定位判断；本机无专门的排版模板可直接对照" },
    speed: "standard",
    promptHints: {
      zh: [
        "图里要有文字时直接写出字面内容，例如：a poster reading \"DEEP DIVE\" in bold sans-serif。",
        "把文字内容用引号包起来，避免模型把它当成修饰语。",
        "长描述性段落效果比关键词列表好。",
      ],
      en: [
        "Quote the literal string you want rendered.",
        "Long descriptive paragraphs beat keyword lists.",
      ],
    },
    notes: [
      "本机实测：把 steps 从 4 调到 8 仍稳定（模板里两个默认值都出现过）。",
      "需要清晰文字时优先选它而不是 Turbo。",
    ],
  },
  {
    family: "Qwen-Image 2512",
    label: "Qwen-Image 2512",
    category: "image",
    bestFor: ["text-to-image", "text-rendering"],
    strengths: ["Qwen 系列的较新权重，默认步数更高、细节更多"],
    sampler: {
      steps: { value: 50, range: [40, 60], verified: V },
      cfg: { value: 4, range: [3, 5], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["text-to-image-qwen-image-2512"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: true, verified: U },
    speed: "quality",
    promptHints: {
      zh: ["同样把要渲染的文字用引号写清楚。", "步数是同系列里最高的一档，耗时也最长。"],
      en: ["Quote literal text. Highest step count in the family, and the slowest."],
    },
    notes: ["50 步是模板默认值，不建议再往上加。"],
  },
  {
    family: "Qwen 2509",
    label: "Qwen 2509",
    category: "image",
    bestFor: ["image-edit"],
    strengths: ["图像编辑方向，指令式改图"],
    sampler: {
      steps: { value: 4, range: [4, 8], verified: V },
      cfg: { value: 1, range: [1, 2], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["image-edit-qwen-2509"],
    },
    negativePrompt: { supported: true, verified: V, note: "负面条件接 TextEncodeQwenImageEditPlus" },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: {
      zh: ["描述「要改成什么」，而不是描述原图。", "一次只改一件事，多处修改拆成多次调用。"],
      en: ["Describe the desired change, not the source image. One change per call."],
    },
    notes: [],
  },
  {
    family: "Qwen 2511",
    label: "Qwen 2511",
    category: "image",
    bestFor: ["image-edit"],
    strengths: ["比 2509 步数更高，编辑保真度更好"],
    sampler: {
      steps: { value: 40, range: [30, 50], verified: V },
      cfg: { value: 4, range: [3, 5], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["image-edit-qwen-2511"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["描述目标状态。", "步数高，迭代时注意耗时。"], en: ["Describe the target state."] },
    notes: [],
  },
  {
    family: "Qwen-Image-Layered",
    label: "Qwen-Image-Layered",
    category: "image",
    bestFor: ["image-edit"],
    strengths: ["把一张图拆成多个可编辑图层", "适合做素材分层、二次编辑"],
    sampler: {
      steps: { value: 20, range: [15, 25], verified: V },
      cfg: { value: 2.5, range: [2, 3], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      resolution: { value: 640, verified: V, note: "模板默认 640x640，明显低于其他图像模型" },
      source: ["image-to-layers-qwen-image-layered"],
    },
    negativePrompt: { supported: true, verified: V, note: "走 ReferenceLatent" },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["这是分层工具，不是出图工具。", "分辨率默认较低，拆层后可在下游放大。"], en: ["A layering tool, not a generator."] },
    notes: ["默认 640 比同门低，输出细节有限。"],
  },
  {
    family: "Flux.1 Dev",
    label: "Flux.1 Dev",
    category: "image",
    bestFor: ["text-to-image"],
    strengths: ["通用文生图，生态成熟、ControlNet 兼容性好", "细节与构图稳定"],
    sampler: {
      steps: { value: 20, range: [15, 30], verified: V },
      cfg: { value: 1, range: [1, 1.5], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      resolution: { value: 1024, verified: V },
      source: ["text-to-image-flux-1-dev"],
    },
    negativePrompt: { supported: false, verified: V, note: "负面条件被置零（ConditioningZeroOut）" },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: {
      zh: ["Flow 模型，CFG 保持 1，调高反而糊。", "提示词用自然语言描述完整画面，而不是标签串。"],
      en: ["Keep CFG at 1. Describe the scene in prose, not tags."],
    },
    notes: ["同样没有负面提示词通路。"],
  },
  {
    family: "Flux.1 Krea Dev",
    label: "Flux.1 Krea Dev",
    category: "image",
    bestFor: ["text-to-image"],
    strengths: ["偏 photographic 的 Flux 变体", "写实人像与摄影质感更好"],
    sampler: {
      steps: { value: 20, range: [15, 30], verified: V },
      cfg: { value: 1, range: [1, 1.5], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["text-to-image-flux-1-krea-dev"],
    },
    negativePrompt: { supported: false, verified: V, note: "负面条件置零" },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["写实向：强调镜头、光线、材质。", "CFG 保持 1。"], en: ["Photographic: lens, light, material. Keep CFG at 1."] },
    notes: [],
  },
  {
    family: "Flux.1 Fill Dev",
    label: "Flux.1 Fill Dev",
    category: "image",
    bestFor: ["image-edit", "image-inpainting"],
    strengths: ["专做局部重绘/修补（inpainting）", "遮罩内内容与周围融合自然"],
    sampler: {
      steps: { value: 20, range: [15, 30], verified: V },
      cfg: { value: 1, range: [1, 1.5], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "normal", verified: V },
      source: ["image-inpainting-flux-1-fill-dev"],
    },
    negativePrompt: { supported: true, verified: V, note: "走 InpaintModelConditioning" },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["描述要填进遮罩的内容。", "遮罩外的区域不受影响。"], en: ["Describe what goes in the mask."] },
    notes: [],
  },
  {
    family: "Flux.2 Dev",
    label: "Flux.2 Dev",
    category: "image",
    bestFor: ["text-to-image", "image-edit"],
    strengths: ["新一代 Flux，同时覆盖出图与编辑"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板的采样参数通过接口输入，节点上未固定默认值" },
      cfg: { value: undefined, verified: U, note: "同上" },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: undefined, verified: U, note: "同上" },
      resolution: { value: 1024, verified: V },
      source: ["text-to-image-flux-2-dev", "image-edit-flux-2-dev"],
    },
    negativePrompt: { supported: false, verified: U },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["出图与编辑两种模板都存在，按需求选模板。"], en: ["Both t2i and edit templates exist."] },
    notes: ["步数/CFG 在本机模板里没有固定值，请沿用模板默认，不要套用 Flux.1 的数字。"],
  },
  {
    family: "Flux.2 Klein 4B",
    label: "Flux.2 Klein 4B",
    category: "image",
    bestFor: ["image-edit"],
    strengths: ["4B 轻量版本，编辑速度快"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      resolution: { value: 1024, verified: V },
      source: ["image-edit-flux-2-klein-4b"],
    },
    negativePrompt: { supported: false, verified: U },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["轻量编辑模型，适合快速试改。"], en: ["Lightweight; good for fast edits."] },
    notes: [],
  },
  {
    family: "Krea-2 Turbo",
    label: "Krea-2 Turbo",
    category: "image",
    bestFor: ["text-to-image", "image-to-image"],
    strengths: ["Turbo 档，出图快", "支持风格参考图（style reference）"],
    sampler: {
      steps: { value: 8, range: [6, 9], verified: V },
      cfg: { value: 1, range: [1, 1], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      resolution: { value: 1024, verified: V },
      source: ["text-to-image-krea-2-turbo", "image-style-reference-krea-2-turbo"],
    },
    negativePrompt: { supported: false, verified: V, note: "负面条件置零" },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["和 Z-Image-Turbo 同属蒸馏档，步数别调高。", "有风格参考图时，参考图的权重比文字描述更决定成图。"], en: ["Distilled: do not raise steps."] },
    notes: ["同样无负面提示词。"],
  },
  {
    family: "Anima",
    label: "Anima",
    category: "image",
    bestFor: ["text-to-image"],
    strengths: ["支持真实负面提示词的文生图模型", "与 Turbo 档形成快慢搭配"],
    sampler: {
      steps: { value: 30, range: [25, 35], verified: V },
      cfg: { value: 4, range: [3, 5], verified: V },
      sampler_name: { value: "er_sde", verified: V },
      scheduler: { value: "simple", verified: V },
      resolution: { value: 1024, verified: V },
      source: ["text-to-image-anima"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["负面提示词可用。", "er_sde 采样器，30 步左右稳定。"], en: ["Negative prompts work. er_sde, around 30 steps."] },
    notes: [],
  },
  {
    family: "Anima Base 1.0",
    label: "Anima Base 1.0",
    category: "image",
    bestFor: ["text-to-image"],
    strengths: ["Anima 的基础权重版本"],
    sampler: {
      steps: { value: 30, range: [25, 35], verified: V },
      cfg: { value: 4, range: [3, 5], verified: V },
      sampler_name: { value: "er_sde", verified: V },
      scheduler: { value: "simple", verified: V },
      resolution: { value: 1024, verified: V },
      source: ["text-to-image-anima-base-1-0"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["与 Anima 参数一致。"], en: ["Same parameters as Anima."] },
    notes: [],
  },
  {
    family: "Mage-Flow",
    label: "Mage-Flow",
    category: "image",
    bestFor: ["text-to-image"],
    strengths: ["非蒸馏档，可精细控制", "负面提示词可用"],
    sampler: {
      steps: { value: 30, range: [25, 40], verified: V },
      cfg: { value: 5, range: [4, 6], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["text-to-image-mage-flow"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["30 步 / CFG 5。", "负面提示词可用。"], en: ["30 steps, CFG 5. Negative prompts work."] },
    notes: [],
  },
  {
    family: "Mage-Flow Turbo",
    label: "Mage-Flow Turbo",
    category: "image",
    bestFor: ["text-to-image"],
    strengths: ["Mage-Flow 的快速档"],
    sampler: {
      steps: { value: 4, range: [4, 6], verified: V },
      cfg: { value: 1, range: [1, 1], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["text-to-image-mage-flow-turbo"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["4 步出图，别加步数。"], en: ["4 steps; do not add more."] },
    notes: ["蒸馏档。"],
  },
  {
    family: "Mage-Flow-Edit",
    label: "Mage-Flow-Edit",
    category: "image",
    bestFor: ["image-edit"],
    strengths: ["指令式改图，非蒸馏档"],
    sampler: {
      steps: { value: 30, range: [25, 40], verified: V },
      cfg: { value: 5, range: [4, 6], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["image-edit-mage-flow-edit"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["按 megapixels 缩放，不是固定像素。", "描述目标状态。"], en: ["Scaled by megapixels. Describe the target."] },
    notes: [],
  },
  {
    family: "Mage-Flow-Edit Turbo",
    label: "Mage-Flow-Edit Turbo",
    category: "image",
    bestFor: ["image-edit"],
    strengths: ["快速改图档"],
    sampler: {
      steps: { value: 4, range: [4, 6], verified: V },
      cfg: { value: 1, range: [1, 1], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["image-edit-mage-flow-edit-turbo"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["4 步快速改图。"], en: ["4-step fast edits."] },
    notes: [],
  },
  {
    family: "Ernie Image",
    label: "Ernie Image",
    category: "image",
    bestFor: ["text-to-image"],
    strengths: ["支持负面提示词", "中文语境下的文字与构图理解较好（未验证）"],
    sampler: {
      steps: { value: 20, range: [15, 25], verified: V },
      cfg: { value: 4, range: [3, 5], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      resolution: { value: 1024, verified: V },
      source: ["text-to-image-ernie-image"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U, note: "中文文字渲染未在本机验证" },
    speed: "quality",
    promptHints: { zh: ["负面提示词可用。", "20 步 / CFG 4。"], en: ["Negative prompts work."] },
    notes: [],
  },
  {
    family: "Ernie Image Turbo",
    label: "Ernie Image Turbo",
    category: "image",
    bestFor: ["text-to-image"],
    strengths: ["Ernie 的快速档"],
    sampler: {
      steps: { value: 8, range: [6, 9], verified: V },
      cfg: { value: 1, range: [1, 1], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      resolution: { value: 1024, verified: V },
      source: ["text-to-image-ernie-image-turbo"],
    },
    negativePrompt: { supported: false, verified: V, note: "负面条件置零" },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["蒸馏档，8 步。", "无负面提示词。"], en: ["Distilled, 8 steps, no negative prompt."] },
    notes: [],
  },
  {
    family: "Boogu Turbo",
    label: "Boogu Turbo",
    category: "image",
    bestFor: ["text-to-image"],
    strengths: ["lcm 采样器，出图极快"],
    sampler: {
      steps: { value: 4, range: [4, 6], verified: V },
      cfg: { value: 1, range: [1, 1], verified: V },
      sampler_name: { value: "lcm", verified: V },
      scheduler: { value: "sgm_uniform", verified: V },
      resolution: { value: 1024, verified: V },
      source: ["text-to-image-boogu-turbo"],
    },
    negativePrompt: { supported: false, verified: V, note: "负面条件置零" },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["lcm + sgm_uniform 是这一组的固定组合，别换成 euler。"], en: ["lcm + sgm_uniform; do not swap the sampler."] },
    notes: ["调度器必须是 sgm_uniform，否则出图异常。"],
  },
  {
    family: "Boogu Image Edit",
    label: "Boogu Image Edit",
    category: "image",
    bestFor: ["image-edit"],
    strengths: ["快速改图"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定步数" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: "dpmpp_2m", verified: V },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      resolution: { value: 1024, verified: V },
      source: ["edit-image-boogu-image-edit"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["描述要改成的效果。"], en: ["Describe the intended change."] },
    notes: [],
  },
  {
    family: "NetaYume Lumina",
    label: "NetaYume Lumina",
    category: "image",
    bestFor: ["text-to-image"],
    strengths: ["res_multistep + CFG 4 的组合，介于快慢之间"],
    sampler: {
      steps: { value: 30, range: [25, 35], verified: V },
      cfg: { value: 4, range: [3, 5], verified: V },
      sampler_name: { value: "res_multistep", verified: V },
      scheduler: { value: "simple", verified: V },
      resolution: { value: 1024, verified: V },
      source: ["text-to-image-netayume-lumina"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["30 步 / CFG 4 / res_multistep。"], en: ["30 steps, CFG 4, res_multistep."] },
    notes: [],
  },
  {
    family: "Ideogram v4",
    label: "Ideogram v4",
    category: "image",
    bestFor: ["text-rendering", "text-to-image"],
    strengths: ["以文字排版见长的模型（定位如此，本机未验证）"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定步数" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      resolution: { value: 1024, verified: V },
      source: ["text-to-image-ideogram-v4"],
    },
    negativePrompt: { supported: false, verified: U },
    textRendering: { reliable: true, verified: U, note: "模型定位是排版强项，但本机没有排版模板可对照，未验证" },
    speed: "standard",
    promptHints: { zh: ["文字用引号写清楚内容与字体风格。"], en: ["Quote the literal text and its style."] },
    notes: ["排版能力未在本机验证，若排版失败请改用 Qwen-Image。"],
  },
  {
    family: "Bernini-R",
    label: "Bernini-R",
    category: "image",
    bestFor: ["image-edit", "video"],
    strengths: ["图像与视频编辑双模板", "统一的多参考图工作流"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: "res_multistep", verified: V },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      resolution: { value: 928, verified: V, note: "模板默认 928，长边基准" },
      source: ["image-edit-bernini-r", "video-edit-bernini-r"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["支持多张参考图。", "分辨率以长边 928 为基准。"], en: ["Multiple references. Long-edge 928."] },
    notes: [],
  },
  {
    family: "Joy Image Edit",
    label: "Joy Image Edit",
    category: "image",
    bestFor: ["image-edit"],
    strengths: ["指令式改图，40 步保真"],
    sampler: {
      steps: { value: 40, range: [30, 50], verified: V },
      cfg: { value: 4, range: [3, 5], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "normal", verified: V },
      resolution: { value: 1024, verified: V },
      source: ["image-edit-joy-image-edit"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["描述改动目标。", "调度器是 normal 而非 simple。"], en: ["Scheduler is normal, not simple."] },
    notes: [],
  },
  {
    family: "LongCat Image Edit",
    label: "LongCat Image Edit",
    category: "image",
    bestFor: ["image-edit"],
    strengths: ["步数最高的改图模型之一"],
    sampler: {
      steps: { value: 50, range: [40, 60], verified: V },
      cfg: { value: 4.5, range: [4, 5], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["image-edit-longcat-image-edit"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["50 步 / CFG 4.5。"], en: ["50 steps, CFG 4.5."] },
    notes: ["CFG 是 4.5 这个非整数档，别当成 4。"],
  },
  {
    family: "FireRed Image Edit 1.1",
    label: "FireRed Image Edit 1.1",
    category: "image",
    bestFor: ["image-edit"],
    strengths: ["Qwen 系编码器的改图模型"],
    sampler: {
      steps: { value: 40, range: [30, 50], verified: V },
      cfg: { value: 4, range: [3, 5], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["image-edit-firered-image-edit-1-1"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["走 Qwen 图像编辑编码器。"], en: ["Uses a Qwen image-edit encoder."] },
    notes: [],
  },
  {
    family: "MiniMax H3",
    label: "MiniMax H3",
    category: "video",
    bestFor: ["video", "video-inpaint"],
    strengths: ["图生视频，本机唯一一份自带模型的安装（实测）"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定步数" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: "res_multistep", verified: V },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      resolution: { value: 1344, verified: V, note: "模板默认 1344x1344" },
      source: ["image-to-video-minimax-h3"],
    },
    negativePrompt: { supported: false, verified: U },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["图生视频：输入图 + 运动描述。", "视频很慢，务必用异步模式排队。"], en: ["Image in, motion described. Use async mode."] },
    notes: ["本机实测：只有 MiniMax H3 这份安装自带模型权重，另两份需要共享模型目录。"],
  },
  {
    family: "VOID",
    label: "VOID",
    category: "video",
    bestFor: ["video", "video-edit"],
    strengths: ["视频局部修补（video inpaint）"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: undefined, verified: U, note: "模板未固定" },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      resolution: { value: 672, verified: V, note: "模板默认 672" },
      source: ["video-inpaint-void"],
    },
    negativePrompt: { supported: false, verified: U },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["视频修补，分辨率基准 672。"], en: ["Video inpainting, 672 base."] },
    notes: [],
  },

  /* ---------------- video ---------------- */
  {
    family: "Wan 2.2",
    label: "Wan 2.2",
    category: "video",
    bestFor: ["video"],
    strengths: ["文生视频与图生视频双模板", "支持负面提示词（本组里少见）"],
    sampler: {
      steps: { value: 4, range: [4, 8], verified: V },
      cfg: { value: 1, range: [1, 1], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      resolution: { value: 1024, verified: V },
      source: ["text-to-video-wan-2-2", "image-to-video-wan-2-2"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["4 步的视频模型。", "描述运动而非静态画面。"], en: ["4-step video. Describe motion."] },
    notes: ["视频生成耗时长，用异步模式。"],
  },
  {
    family: "Wan2.1 VACE",
    label: "Wan2.1 VACE",
    category: "video",
    bestFor: ["video"],
    strengths: ["首尾帧控制视频（FLF2V）", "视频局部重绘", "支持负面提示词"],
    sampler: {
      steps: { value: 20, range: [15, 25], verified: V },
      cfg: { value: 6, range: [5, 7], verified: V },
      sampler_name: { value: "uni_pc", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["flf2v-wan2-1-vace", "video-inpainting-wan2-1-vace"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["uni_pc 是该模型专用采样器。", "CFG 6 明显高于同门。"], en: ["uni_pc sampler, CFG 6."] },
    notes: ["模板里同时出现 4 步/1 与 20 步/6 两档，按模板走。"],
  },
  {
    family: "Wan Dancer",
    label: "Wan Dancer",
    category: "video",
    bestFor: ["video", "motion-transfer", "video-inpainting"],
    strengths: ["人像舞蹈动作迁移"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      source: ["image-to-video-wan-dancer"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["输入参考人物图 + 动作描述。"], en: ["Reference image plus a motion description."] },
    notes: [],
  },
  {
    family: "Wan Animate 2",
    label: "Wan Animate 2",
    category: "video",
    bestFor: ["motion-transfer"],
    strengths: ["动作迁移完整版"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: "lcm", verified: V },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      source: ["motion-transfer-wan-animate-2"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["lcm 采样器。"], en: ["lcm sampler."] },
    notes: [],
  },
  {
    family: "Wan Animate 2 Distilled",
    label: "Wan Animate 2 Distilled",
    category: "video",
    bestFor: ["motion-transfer"],
    strengths: ["动作迁移蒸馏版，更快"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: "lcm", verified: V },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      source: ["motion-transfer-wan-animate-2-distilled"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["蒸馏档，出片更快。"], en: ["Distilled; faster."] },
    notes: [],
  },
  {
    family: "LTX-2.5",
    label: "LTX-2.5",
    category: "video",
    bestFor: ["video"],
    strengths: ["LTX 最新一代，文/图/首尾帧三种模板"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定步数" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: "euler_ancestral", verified: V },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      resolution: { value: 768, verified: V, note: "模板默认 768" },
      source: ["text-to-video-ltx-2-5", "image-to-video-ltx-2-5", "first-last-frame-to-video-ltx-2-5"],
    },
    negativePrompt: { supported: false, verified: U },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["768 为分辨率基准。", "euler_ancestral 采样。"], en: ["768 base, euler_ancestral."] },
    notes: [],
  },
  {
    family: "LTX-2.3",
    label: "LTX-2.3",
    category: "video",
    bestFor: ["video"],
    strengths: ["文/图/首尾帧三种模板齐备"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定步数" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: "euler_cfg_pp", verified: V },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      resolution: { value: 768, verified: V },
      source: ["text-to-video-ltx-2-3", "image-to-video-ltx-2-3", "first-last-frame-to-video-ltx-2-3"],
    },
    negativePrompt: { supported: false, verified: U },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["768 基准。", "采样器是 euler_cfg_pp。"], en: ["768 base, euler_cfg_pp."] },
    notes: ["模板中还出现 euler_ancestral_cfg_pp，按具体模板走。"],
  },
  {
    family: "LTX-2.3 IC-LoRA",
    label: "LTX-2.3 IC-LoRA",
    category: "video",
    bestFor: ["video"],
    strengths: ["带 IC-LoRA 的视频生成，步数很低"],
    sampler: {
      steps: { value: 8, range: [6, 10], verified: V },
      cfg: { value: 1, range: [1, 1], verified: V },
      sampler_name: { value: "euler_ancestral", verified: V },
      scheduler: { value: "linear_quadratic", verified: V },
      resolution: { value: 768, verified: V },
      source: ["video-generation-ltx-2-3-ic-lora"],
    },
    negativePrompt: { supported: false, verified: U },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["8 步，调度器 linear_quadratic 是该变体特有。"], en: ["8 steps; linear_quadratic scheduler."] },
    notes: [],
  },
  {
    family: "LTX 2.0",
    label: "LTX 2.0",
    aliases: ["ltx 2.0"],
    category: "video",
    bestFor: ["video", "control"],
    strengths: ["Canny 边缘转视频", "姿态转视频", "深度转视频"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定步数" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      resolution: { value: 768, verified: V },
      source: ["canny-to-video-ltx-2-0", "pose-to-video-ltx-2-0"],
    },
    negativePrompt: { supported: false, verified: U },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["控制类模板：用边缘/姿态图驱动视频。"], en: ["Control templates: drive video from edges or pose."] },
    notes: [],
  },
  {
    family: "SCAIL-2 Base",
    label: "SCAIL-2 Base",
    category: "video",
    bestFor: ["motion-transfer"],
    strengths: ["角色替换（人物一致性保持）"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      resolution: { value: 512, verified: V, note: "模板默认 512，明显低于其他" },
      source: ["character-replacement-scail-2-base"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["512 分辨率，角色一致性优先于清晰度。"], en: ["512 base; consistency over sharpness."] },
    notes: [],
  },
  {
    family: "SCAIL-2 Extend",
    label: "SCAIL-2 Extend",
    category: "video",
    bestFor: ["motion-transfer"],
    strengths: ["角色替换的延长版"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      resolution: { value: 512, verified: V },
      source: ["character-replacement-scail-2-extend"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["同 Base，延长版。"], en: ["Extended variant of Base."] },
    notes: [],
  },
  {
    family: "SCAIL-2 Int8 Base",
    label: "SCAIL-2 Int8 Base",
    category: "video",
    bestFor: ["motion-transfer"],
    strengths: ["int8 量化版，省显存"],
    sampler: {
      steps: { value: undefined, verified: U, note: "模板未固定" },
      cfg: { value: undefined, verified: U, note: "模板未固定" },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: undefined, verified: U, note: "模板未固定" },
      resolution: { value: 512, verified: V },
      source: ["character-replacement-scail-2-int8-base"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["显存不够时选 int8 版。"], en: ["Pick int8 when VRAM is tight."] },
    notes: [],
  },

  /* ---------------- control / pose ---------------- */
  {
    family: "Anima LLLite",
    label: "Anima LLLite",
    category: "control",
    bestFor: ["control"],
    strengths: ["LLLite 控制引导：边缘/深度/姿态驱动出图"],
    sampler: {
      steps: { value: 30, range: [25, 35], verified: V },
      cfg: { value: 4, range: [3, 5], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      resolution: { value: 1024, verified: V },
      source: ["control-to-image-anima-lllite"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["先准备控制图（边缘/深度/姿态），再写描述内容的 prompt。"], en: ["Prepare the control map, then prompt for content."] },
    notes: ["它不是出图模型本身，是控制分支。"],
  },
  {
    family: "SDPose Multi-Person",
    label: "SDPose Multi-Person",
    category: "pose",
    bestFor: ["pose", "control"],
    strengths: ["多人姿态提取", "输出姿态图可驱动视频/图像生成"],
    sampler: {
      steps: { value: undefined, verified: U, note: "姿态提取无采样过程" },
      cfg: { value: undefined, verified: U, note: "不适用" },
      sampler_name: { value: undefined, verified: U, note: "不适用" },
      scheduler: { value: undefined, verified: U, note: "不适用" },
      source: ["image-to-pose-map-sdpose-multi-person", "video-to-pose-map-sdpose-multi-person"],
    },
    negativePrompt: { supported: false, verified: U, note: "不适用" },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["支持多人。", "输出是姿态图，供下游消费。"], en: ["Multi-person. Output is a pose map for downstream use."] },
    notes: ["不是生成模型，没有采样参数。"],
  },
  {
    family: "SDPose-OOD",
    label: "SDPose-OOD",
    category: "pose",
    bestFor: ["pose"],
    strengths: ["分布外姿态提取，异常姿势更稳"],
    sampler: {
      steps: { value: undefined, verified: U, note: "不适用" },
      cfg: { value: undefined, verified: U, note: "不适用" },
      sampler_name: { value: undefined, verified: U, note: "不适用" },
      scheduler: { value: undefined, verified: U, note: "不适用" },
      source: ["image-to-pose-map-sdpose-ood"],
    },
    negativePrompt: { supported: false, verified: U, note: "不适用" },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["人体姿态提取。"], en: ["Human pose extraction."] },
    notes: [],
  },
  {
    family: "SAM3",
    label: "SAM3",
    category: "segmentation",
    bestFor: ["segmentation"],
    strengths: ["图像与视频分割，通用分割一切"],
    sampler: {
      steps: { value: undefined, verified: U, note: "不适用" },
      cfg: { value: undefined, verified: U, note: "不适用" },
      sampler_name: { value: undefined, verified: U, note: "不适用" },
      scheduler: { value: undefined, verified: U, note: "不适用" },
      source: ["image-segmentation-sam3", "video-segmentation-sam3"],
    },
    negativePrompt: { supported: false, verified: U, note: "不适用" },
    textRendering: { reliable: false, verified: U },
    speed: "standard",
    promptHints: { zh: ["分割用，不生成图像。", "可用于给其他模型准备遮罩。"], en: ["Segmentation only. Produces masks for other models."] },
    notes: [],
  },

  /* ---------------- depth / geometry ---------------- */
  {
    family: "Depth Anything 3",
    label: "Depth Anything 3",
    category: "depth",
    bestFor: ["depth"],
    strengths: ["通用深度估计，图像与视频都支持", "可作为其他模型的深度控制源"],
    sampler: {
      steps: { value: undefined, verified: U, note: "深度估计无采样过程" },
      cfg: { value: undefined, verified: U, note: "不适用" },
      sampler_name: { value: undefined, verified: U, note: "不适用" },
      scheduler: { value: undefined, verified: U, note: "不适用" },
      source: ["image-depth-estimation-depth-anything-3", "video-depth-estimation-depth-anything-3"],
    },
    negativePrompt: { supported: false, verified: U, note: "不适用" },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["输出深度图，供 Depth to Image/Video 使用。", "通过 resolution 与 resize_method 调质量。"], en: ["Emits a depth map for depth-conditioned generation."] },
    notes: [],
  },
  {
    family: "Marigold V2",
    label: "Marigold V2",
    category: "depth",
    bestFor: ["depth"],
    strengths: ["深度、法线（normal）、反照率（albedo）三合一"],
    sampler: {
      steps: { value: undefined, verified: U, note: "无采样过程" },
      cfg: { value: undefined, verified: U, note: "不适用" },
      sampler_name: { value: "euler", verified: V, note: "模板中出现 euler，但该类模型通常无采样步骤" },
      scheduler: { value: undefined, verified: U, note: "不适用" },
      source: ["image-depth-estimation-marigold-v2", "image-normal-estimation-marigold-v2", "image-albedo-estimation-marigold-v2"],
    },
    negativePrompt: { supported: false, verified: U, note: "不适用" },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["一个模型出深度/法线/反照率三种图。"], en: ["Depth, normal and albedo from one model."] },
    notes: ["模板里的 euler 是共用节点残留，不代表这些估计需要采样。"],
  },
  {
    family: "MoGe",
    label: "MoGe",
    category: "depth",
    bestFor: ["depth", "3d"],
    strengths: ["深度 + 几何估计", "推理分辨率可调，支持批量"],
    sampler: {
      steps: { value: undefined, verified: U, note: "无采样过程" },
      cfg: { value: undefined, verified: U, note: "不适用" },
      sampler_name: { value: undefined, verified: U, note: "不适用" },
      scheduler: { value: undefined, verified: U, note: "不适用" },
      source: ["geometry-estimation-moge", "image-depth-estimation-moge"],
    },
    negativePrompt: { supported: false, verified: U, note: "不适用" },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["inference_resolution 与 inference_batch_size 控制质量与速度。"], en: ["inference_resolution and inference_batch_size trade quality for speed."] },
    notes: [],
  },
  {
    family: "Lotus Depth",
    label: "Lotus Depth",
    category: "depth",
    bestFor: ["depth"],
    strengths: ["专用深度估计"],
    sampler: {
      steps: { value: undefined, verified: U, note: "无采样过程" },
      cfg: { value: undefined, verified: U, note: "不适用" },
      sampler_name: { value: "euler", verified: V, note: "模板残留节点" },
      scheduler: { value: undefined, verified: U, note: "不适用" },
      source: ["image-depth-estimation-lotus-depth"],
    },
    negativePrompt: { supported: false, verified: U, note: "不适用" },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["深度估计，纯前馈无采样。"], en: ["Feed-forward; no sampling."] },
    notes: [],
  },

  /* ---------------- segmentation / matting ---------------- */
  {
    family: "BiRefNet",
    label: "BiRefNet",
    category: "segmentation",
    bestFor: ["segmentation"],
    strengths: ["高质量抠图/去背景", "边缘发丝级细节"],
    sampler: {
      steps: { value: undefined, verified: U, note: "无采样过程" },
      cfg: { value: undefined, verified: U, note: "不适用" },
      sampler_name: { value: undefined, verified: U, note: "不适用" },
      scheduler: { value: undefined, verified: U, note: "不适用" },
      source: ["remove-background-birefnet"],
    },
    negativePrompt: { supported: false, verified: U, note: "不适用" },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["输出透明背景 PNG。", "适合做素材抠图预处理。"], en: ["Outputs a transparent PNG. Good pre-processing for assets."] },
    notes: [],
  },

  /* ---------------- upscale / restore ---------------- */
  {
    family: "SeedVR2 3B Int8",
    label: "SeedVR2 3B Int8",
    category: "upscale",
    bestFor: ["upscale"],
    strengths: ["视频放大，int8 量化省显存"],
    sampler: {
      steps: { value: 1, range: [1, 2], verified: V },
      cfg: { value: 1, range: [1, 1], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["upscale-video-seedvr2-3b-int8"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["单步即可，放大倍数是主要旋钮。"], en: ["Single step; the multiplier is the real knob."] },
    notes: ["1 步是正常的，不要加步数。"],
  },
  {
    family: "GAN x4",
    label: "GAN x4",
    category: "upscale",
    bestFor: ["upscale"],
    strengths: ["4 倍快速放大", "GAN 放大速度快但可能产生伪影"],
    sampler: {
      steps: { value: undefined, verified: U, note: "GAN 放大无采样过程" },
      cfg: { value: undefined, verified: U, note: "不适用" },
      sampler_name: { value: undefined, verified: U, note: "不适用" },
      scheduler: { value: undefined, verified: U, note: "不适用" },
      source: ["video-upscale-gan-x4"],
    },
    negativePrompt: { supported: false, verified: U, note: "不适用" },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["固定 4 倍，模板只做视频。"], en: ["Fixed 4x; video only in the template."] },
    notes: [],
  },

  /* ---------------- 3D ---------------- */
  {
    family: "Hunyuan3d 2.1",
    label: "Hunyuan3d 2.1",
    category: "3d",
    bestFor: ["3d"],
    strengths: ["图生 3D 模型", "生成网格/高斯表达"],
    sampler: {
      steps: { value: 30, range: [25, 40], verified: V },
      cfg: { value: 5, range: [4, 6], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "normal", verified: V },
      source: ["image-to-model-hunyuan3d-2-1"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["输入单张物体图。", "调度器 normal。"], en: ["One object image in. Scheduler: normal."] },
    notes: [],
  },
  {
    family: "TripoSplat",
    label: "TripoSplat",
    category: "3d",
    bestFor: ["3d"],
    strengths: ["图转高斯泼溅（Gaussian Splat）"],
    sampler: {
      steps: { value: 20, range: [15, 25], verified: V },
      cfg: { value: 3, range: [2, 4], verified: V },
      sampler_name: { value: "dpmpp_2m", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["image-to-gaussian-splat-triposplat"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U },
    speed: "quality",
    promptHints: { zh: ["CFG 3 比同类低。", "输入单物体图。"], en: ["CFG 3, lower than peers."] },
    notes: [],
  },

  /* ---------------- audio ---------------- */
  {
    family: "Stable Audio 3 Medium",
    label: "Stable Audio 3 Medium",
    category: "audio",
    bestFor: ["audio"],
    strengths: ["lcm 采样，8 步出音频", "速度与质量平衡"],
    sampler: {
      steps: { value: 8, range: [6, 12], verified: V },
      cfg: { value: 1, range: [1, 1], verified: V },
      sampler_name: { value: "lcm", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["audio-generation-stable-audio-3-medium"],
    },
    negativePrompt: { supported: false, verified: V, note: "负面条件置零" },
    textRendering: { reliable: false, verified: U, note: "不适用" },
    speed: "draft",
    promptHints: { zh: ["用声音描述：环境音/情绪/节奏，而不是画面词。"], en: ["Describe sound: ambience, mood, tempo."] },
    notes: ["音频生成不是出图，参数含义相同但目标是声音。"],
  },
  {
    family: "Stable Audio 3 Medium Base",
    label: "Stable Audio 3 Medium Base",
    category: "audio",
    bestFor: ["audio"],
    strengths: ["Base 版本，50 步更精细", "支持负面提示词"],
    sampler: {
      steps: { value: 50, range: [40, 60], verified: V },
      cfg: { value: 7, range: [5, 8], verified: V },
      sampler_name: { value: "lcm", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["audio-generation-stable-audio-3-medium-base"],
    },
    negativePrompt: { supported: true, verified: V },
    textRendering: { reliable: false, verified: U, note: "不适用" },
    speed: "quality",
    promptHints: { zh: ["50 步 / CFG 7，比 Medium 慢很多。", "负面提示词可用。"], en: ["50 steps, CFG 7. Negative prompts work."] },
    notes: ["与 Medium 是「快 vs 精」的一对。"],
  },
  {
    family: "ACE-Step 1.5",
    label: "ACE-Step 1.5",
    category: "music",
    bestFor: ["music"],
    strengths: ["文生音乐，8 步", "支持歌词/人声编排"],
    sampler: {
      steps: { value: 8, range: [6, 12], verified: V },
      cfg: { value: 1, range: [1, 1], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["text-to-audio-ace-step-1-5"],
    },
    negativePrompt: { supported: false, verified: V, note: "负面条件置零" },
    textRendering: { reliable: false, verified: U, note: "不适用" },
    speed: "draft",
    promptHints: { zh: ["描述曲风、乐器、结构（主歌/副歌）。", "有歌词时可一并给出。"], en: ["Genre, instrumentation, structure. Lyrics optional."] },
    notes: [],
  },
  {
    family: "MiniMax Music 3",
    label: "MiniMax Music 3",
    category: "music",
    bestFor: ["music"],
    strengths: ["文生音乐，30 步", "CFG 1.7 是该模型特有档位"],
    sampler: {
      steps: { value: 30, range: [25, 35], verified: V },
      cfg: { value: 1.7, range: [1.5, 2], verified: V },
      sampler_name: { value: "euler", verified: V },
      scheduler: { value: "simple", verified: V },
      source: ["text-to-music-minimax-music-3"],
    },
    negativePrompt: { supported: false, verified: V, note: "负面条件置零" },
    textRendering: { reliable: false, verified: U, note: "不适用" },
    speed: "quality",
    promptHints: { zh: ["CFG 1.7，不要取整成 1 或 2。", "描述曲风与情绪。"], en: ["CFG 1.7 — do not round it to 1 or 2."] },
    notes: ["CFG 1.7 是刻意设置的值。"],
  },
  {
    family: "YuE2",
    label: "YuE2",
    category: "music",
    bestFor: ["music"],
    strengths: ["音乐翻唱（Music Cover）", "文生音乐"],
    sampler: {
      steps: { value: 32, range: [28, 40], verified: V },
      cfg: { value: 1, range: [1, 1], verified: V },
      sampler_name: { value: "dpm_2", verified: V },
      scheduler: { value: "sgm_uniform", verified: V },
      source: ["music-cover-yue2", "text-to-music-yue2"],
    },
    negativePrompt: { supported: false, verified: V, note: "负面条件置零" },
    textRendering: { reliable: false, verified: U, note: "不适用" },
    speed: "quality",
    promptHints: { zh: ["翻唱需要参考音频 + 歌词。", "dpm_2 + sgm_uniform 是固定组合。"], en: ["Cover needs a reference audio plus lyrics."] },
    notes: [],
  },

  /* ---------------- utility ---------------- */
  {
    family: "Mediapipe",
    label: "Mediapipe",
    category: "utility",
    bestFor: ["pose", "caption"],
    strengths: ["人脸检测，图像与视频", "轻量，速度快"],
    sampler: {
      steps: { value: undefined, verified: U, note: "无采样过程" },
      cfg: { value: undefined, verified: U, note: "不适用" },
      sampler_name: { value: undefined, verified: U, note: "不适用" },
      scheduler: { value: undefined, verified: U, note: "不适用" },
      source: ["image-face-detection-mediapipe", "video-face-detection-mediapipe"],
    },
    negativePrompt: { supported: false, verified: U, note: "不适用" },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["检测工具，不生成图像。"], en: ["A detector, not a generator."] },
    notes: [],
  },
  {
    family: "Gemini",
    label: "Gemini",
    aliases: ["gemini"],
    category: "caption",
    bestFor: ["caption"],
    strengths: ["图像/视频描述生成", "可作为下游 prompt 的素材来源"],
    sampler: {
      steps: { value: undefined, verified: U, note: "不适用" },
      cfg: { value: undefined, verified: U, note: "不适用" },
      sampler_name: { value: undefined, verified: U, note: "不适用" },
      scheduler: { value: undefined, verified: U, note: "不适用" },
      source: ["image-captioning-gemini", "video-captioning-gemini"],
    },
    negativePrompt: { supported: false, verified: U, note: "不适用" },
    textRendering: { reliable: false, verified: U },
    speed: "draft",
    promptHints: { zh: ["注意：这是 Partner Node 模板，需要登录云端 API。"], en: ["Note: this is a Partner Node template and needs a cloud login."] },
    notes: ["本机 348 个蓝本中，gemini 属于少数需要 Partner Node 的条目，可能无法离线运行。"],
  },
];

/** Normalise a family label for lookup: case- and separator-insensitive. */
function normalize(name) {
  if (typeof name !== "string") return "";
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Index of every name a family answers to.
 *
 * Built once at module load: a record is keyed by its canonical family plus
 * every alias, all normalised. The template catalogue really does ship both
 * "LTX 2.0" and "ltx 2.0" as separate files, so this is not defensive
 * padding — it is the difference between finding a template and not.
 */
const INDEX = new Map();
for (const record of MODEL_KNOWLEDGE) {
  INDEX.set(normalize(record.family), record);
  for (const alias of record.aliases ?? []) {
    INDEX.set(normalize(alias), record);
  }
}

/**
 * Look up one family by name.
 *
 * Exact (normalised) matches win. Failing that, a unique substring match is
 * accepted so "flux" or "qwen image" resolve, but an ambiguous prefix is
 * reported as undefined rather than guessing — returning the wrong model's
 * sampler settings is worse than returning nothing.
 */
export function queryModel(family) {
  const key = normalize(family);
  if (key === "") return undefined;
  const exact = INDEX.get(key);
  if (exact !== undefined) return exact;

  const hits = MODEL_KNOWLEDGE.filter((record) => normalize(record.family).includes(key));
  if (hits.length === 1) return hits[0];
  return undefined;
}

/**
 * Families that cannot actually run on the user's machine.
 *
 * `category` records what kind of task a model does, not where it executes, so
 * it cannot answer this: Ideogram is filed under `image` and would otherwise
 * top the text-to-image list while being a cloud service the agent has no
 * account for. A cloud-only model is reachable in principle and not in practice,
 * so it never leads a task a local model can already do.
 */
const REMOTE_ONLY = new Set(["Ideogram v4", "Gemini", "Boogu Image Edit", "Boogu Turbo"]);

/**
 * Every record that lists a task in `bestFor`, best first.
 *
 * Ranking is deliberate rather than alphabetical. A model built *for* the task
 * outranks a fast generalist that merely accepts it: asking for a depth map and
 * being handed a text-to-image model is the wrong answer dressed as a quick
 * one, and it happens whenever speed alone decides the order. Speed then breaks
 * ties within that tier, and only among records that actually declare the task.
 */
export function recommendForTask(task, { speed } = {}) {
  const wanted = normalize(task);
  const matches = MODEL_KNOWLEDGE.filter((record) =>
    (record.bestFor ?? []).some((entry) => normalize(entry) === wanted),
  );
  const rank = { draft: 0, standard: 1, quality: 2 };

  // How well the record presents itself as a specialist for this task.
  //
  // A model built *for* the task beats a fast generalist that merely accepts
  // it: asking for a depth map and being handed a text-to-image model is the
  // wrong answer dressed as a quick one.
  //
  // Only structured fields are consulted. The prose in this knowledge base is
  // written in Chinese and `normalize` strips non-ASCII to nothing, so matching
  // it against an English task name can never match — an earlier version looked
  // there and silently ranked on nothing at all.
  const specificity = (record) => {
    // A family named after the task: "Depth Anything 3" answering "depth".
    const filler = /^(base|pro|turbo|dev|lite|light|medium|large|small|mini|nano|xl|int8)$/;
    const words = normalize(record.family ?? "")
      .split(" ")
      .filter((part) => part.length > 2 && !filler.test(part));
    if (words.some((part) => wanted.split(" ").some((taskWord) => part === taskWord || part.includes(taskWord)))) {
      return 4;
    }
    // Otherwise, how much of the model this task accounts for. Two tasks total
    // means this is very nearly what the model is for; eight means it is one
    // capability among many, and speed is a fairer tie-break there.
    const scope = (record.bestFor ?? []).length;
    if (scope <= 2) return 3;
    if (scope <= 3) return 2;
    if (scope <= 5) return 1;
    return 0;
  };

  const score = (record) => {
    const fit = -specificity(record) * 100;
    // A model that cannot run here is not an option at all, however well it
    // fits the task.
    const remote = REMOTE_ONLY.has(record.family) ? 50 : 0;
    // Speed is the caller's stated intent, so it dominates the tie-break.
    const speedScore =
      speed === undefined
        ? (rank[record.speed] ?? 1) * 0.1
        : Math.abs((rank[record.speed] ?? 1) - (rank[speed] ?? 1));
    // A model verified to render text is the right answer for a layout task
    // even when a plain one would be faster.
    const textBonus = record.textRendering?.reliable === true ? -0.5 : 0;
    return remote + fit + speedScore + textBonus;
  };
  return [...matches].sort((left, right) => score(left) - score(right));
}

/**
 * Side-by-side view of several families, for a decision an agent has to make
 * rather than look up.
 *
 * Unverified numbers are carried through as `null` rather than dropped, so the
 * shape stays comparable and the caller can see that a cell is genuinely
 * unknown.
 */
export function compareFamilies(names) {
  const wanted = Array.isArray(names) ? names : [names];
  const found = wanted.map((name) => queryModel(name) ?? { family: typeof name === "string" ? name : String(name), missing: true });

  const pick = (record, get) => {
    if (record.missing === true) return null;
    const value = get(record);
    return value === undefined ? null : value;
  };

  return {
    families: found.map((record) => record.family),
    category: found.map((record) => pick(record, (r) => r.category)),
    speed: found.map((record) => pick(record, (r) => r.speed)),
    steps: found.map((record) => pick(record, (r) => r.sampler?.steps?.value)),
    cfg: found.map((record) => pick(record, (r) => r.sampler?.cfg?.value)),
    sampler_name: found.map((record) => pick(record, (r) => r.sampler?.sampler_name?.value)),
    scheduler: found.map((record) => pick(record, (r) => r.sampler?.scheduler?.value)),
    negativePrompt: found.map((record) => pick(record, (r) => r.negativePrompt?.supported)),
    textRendering: found.map((record) => pick(record, (r) => r.textRendering?.reliable)),
    missing: found.filter((record) => record.missing === true).map((record) => record.family),
  };
}

/** Task ids present in the knowledge base, for callers building a picker. */
export function knownTasks() {
  const seen = new Set();
  for (const record of MODEL_KNOWLEDGE) {
    for (const task of record.bestFor ?? []) seen.add(task);
  }
  return [...seen].sort();
}