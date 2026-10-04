# 模型家族 → 官方仓库与提示词指南

调查目的：`dsh-comfyui-image` 希望在 agent 写提示词前，能按需拉取**模型作者官方发布的提示词指南**。本文记录对全部 45 个家族（加上此前已注册的 8 个）实际发出的 HTTP 请求与结果。

## 方法与可信度

```sh
# 搜索候选仓库
https://hf-mirror.com/api/models?search=<关键词>&limit=8
# 读文件（记录状态码）
https://hf-mirror.com/<owner>/<repo>/raw/main/README.md
# 仓库元数据（license / gated / 完整文件清单）
https://hf-mirror.com/api/models/<owner>/<repo>
```

指南路径不是猜的：先取 `/api/models/<repo>` 的完整 `siblings` 文件清单，在其中筛选 `*.md` 且文件名含 `prompt` 或 `guide` 的文件。**没有匹配项时如实记为"仅 README"**。

本文所有状态码均为本机实测。

---

## 最重要的结论：几乎没有独立的提示词指南文件

**45 个家族中，带专门提示词指南文件的：0 个。**

逐一核对了每个仓库的完整文件清单，命中的 `.md` 文件几乎全部只有 `README.md`（少数另有 `LICENSE.md`、`THIRD_PARTY_NOTICES.md`、子目录 README）。这与 MiniMax H3 形成鲜明对比 —— H3 是唯一把提示词规范单独成文的家族（`docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md` 15.7 KB、`_ref_en.md` 23.5 KB），而 H3 官方 FAQ 恰恰也说明了原因：

> H3 对 prompt 结构的敏感度高于多数模型——它用完整的多模态语言模型读你的提示词。

**推论**：插件的 `prompts=<family>` 能力对绝大多数模型只会返回 README。这仍然有价值（见下），但不应被描述成"官方指南"。

### 但 README 里往往含有实质提示词指引

这不是"没有内容"，而是内容在 README 正文里。例如 `Wan-AI/Wan2.1-VACE-14B`（readme=200，39,531 字符）包含：

```
> For the first-last frame to video generation, we train our model primarily on
  Chinese text-video pairs. Therefore, we recommend...
##### (1) Without Prompt Extension
```

——即**该模型主要用中文文本-视频对训练，官方建议中文提示词**。这类信息不进 `lib/model-knowledge.js` 就一定会被 agent 忽略。

**建议**：把 `README.md` 作为降级来源接入（去掉徽章、目录等噪声），并在知识层补充上述"训练语言偏好"等从 README 提取的结论。

---

## 仓库可达性总览

| 状态 | 数量 | 说明 |
|---|---|---|
| README 可达（200） | 38 | 可直接接入 |
| README 401 | 6 | **gated**，仓库存在但需登录授权 |
| 未找到官方仓库 | 1 | VOID |

**401 的六个**（仓库真实存在，`gated` 已验证）：`Wan-AI/Wan2.2`、`stabilityai/stable-audio-3-medium`、`black-forest-labs/FLUX.1-dev`、`black-forest-labs/FLUX.1-Krea-dev`、`black-forest-labs/FLUX.2-klein-9B`、`Lightricks/LTX-2.5`。

对 gated 仓库，插件应退回到 Comfy-Org 的重打包版（这些通常不 gated，且正是模板实际加载的文件）。

---

## 逐家族结果

标注说明：`[200]`=本机实测 README 可达；`[401]`=本机实测 gated；`官方`=组织账号；`候选`=个人账号需人工确认。

### 图像生成

| 家族 | 仓库 | README | 许可证 | 判定 |
|---|---|---|---|---|
| Anima | `cagliostrolab/animagine-xl-3.0-base` | [200] | openrail++ | **候选/存疑** — 匹配到的是 Animagine-XL，与蓝本里的 Anima 可能不是同一模型 |
| Anima Base 1.0 | 同上 | [200] | openrail++ | **候选/存疑** — 同上 |
| Anima LLLite | `Comfy-Org/Anima-LLLite` | [200] | other | 重打包版 |
| Bernini-R | `ByteDance/Bernini-R` | [200] | apache-2.0 | 官方 |
| Boogu Image Edit | `Comfy-Org/Boogu-Image` | [200] | apache-2.0 | 重打包版 |
| Boogu Turbo | `Boogu/Boogu-Image-0.1-Turbo` | [200] | apache-2.0 | 官方 |
| Ernie Image | `Comfy-Org/ERNIE-Image` | [200] | apache-2.0 | 重打包版 |
| Ernie Image Turbo | `baidu/ERNIE-Image-Turbo` | [200] | apache-2.0 | 官方 |
| FireRed Image Edit 1.1 | `FireRedTeam/FireRed-Image-Edit-1.0` | [200] | apache-2.0 | 官方（版本号 1.0 与家族名 1.1 不符，**需人工确认**） |
| Flux.1 Krea Dev | `black-forest-labs/FLUX.1-Krea-dev` | [401] | other | 官方，gated |
| Flux.1 Dev | `black-forest-labs/FLUX.1-dev` | [401] | other | 官方，gated |
| Flux.2 Dev | `Comfy-Org/flux2-dev` | [200] | other | 重打包版（原作者仓库 gated） |
| Flux.2 Klein 4B | `black-forest-labs/FLUX.2-klein-9B` | [401] | other | 官方，gated；**注意仓库名为 9B，与家族名 4B 不符，需确认** |
| Ideogram v4 | `Comfy-Org/Ideogram-4` | [200] | other | 重打包版 |
| Joy Image Edit | `Comfy-Org/JoyAI-Image-Edit` | [200] | apache-2.0 | 重打包版 |
| Krea-2 Turbo | `Comfy-Org/Krea-2` | [200] | other | 重打包版 |
| LongCat Image Edit | `meituan-longcat/LongCat-Image` | [200] | apache-2.0 | 官方 |
| Mage-Flow | `Comfy-Org/Mage-Flow` | [200] | mit | 重打包版 |
| Mage-Flow Turbo | `mage-flow-community/Mage-Flow-Edit-Turbo` | [200] | mit | **候选，需人工确认** — 社区账号，且四个 Mage-Flow 变体搜索结果完全相同，很可能未区分 |
| Mage-Flow-Edit | 同上 | [200] | mit | **候选，同上** |
| Mage-Flow-Edit Turbo | 同上 | [200] | mit | **候选，同上** |
| NetaYume Lumina | `duongve/NetaYume-Lumina-Image-2.0` | [200] | apache-2.0 | **候选**，个人账号但名称高度匹配 |
| VOID | — | — | — | **未找到官方仓库**。搜索 `VOID` 命中 Netflix 的 `void-model`（动画模型，与图像生成无关）等无关结果 |

### 视频

| 家族 | 仓库 | README | 许可证 | 判定 |
|---|---|---|---|---|
| LTX 2.0 | `Lightricks/LTX-Video` | [200] | other | 官方（`LTX-2.5` 为 [401] gated） |
| LTX-2.3 / 2.5 | `Lightricks/LTX-2.5` | [401] | other | 官方，gated；退回用 LTX-Video |
| Wan 2.2 | `Comfy-Org/Wan_2.2_ComfyUI_Repackaged` | [200] | apache-2.0 | 重打包版（`Wan-AI/Wan2.2` 为 [401]） |
| Wan2.1 VACE | `Wan-AI/Wan2.1-VACE-14B` | [200] | apache-2.0 | 官方 |
| Wan Dancer | `Comfy-Org/Wan-Dancer` | [200] | apache-2.0 | 重打包版（`Wan-AI/Wan-Dancer-14B` meta 200） |
| Wan Animate 2 | `Comfy-Org/Wan-Animate-2` | [200] | apache-2.0 | 重打包版（`Wan-AI/Wan2.2-Animate-14B` meta 200） |
| SCAIL-2 | `zai-org/SCAIL-2` | [200] | mit | 官方（比 Comfy-Org 版点赞更高） |

### 控制 / 姿态

| 家族 | 仓库 | README | 许可证 | 判定 |
|---|---|---|---|---|
| SDPose Multi-Person / OOD | `Comfy-Org/SDPose` | [200] | mit | 重打包版 |
| SAM3 | `Comfy-Org/sam3.1` | [200] | other | 重打包版 |

### 深度 / 几何

| 家族 | 仓库 | README | 许可证 | 判定 |
|---|---|---|---|---|
| Depth Anything 3 | `Comfy-Org/Depth-Anything-3` | [200] | apache-2.0 | 重打包版 |
| Marigold V2 | `Comfy-Org/marigold-v2-0` | [200] | apache-2.0 | 重打包版 |
| MoGe | `Comfy-Org/MoGe` | [200] | mit | 重打包版 |
| Lotus Depth | `jingheya/lotus-depth-g-v1-0` | [200] | apache-2.0 | **候选**，个人账号 |

### 抠图 / 放大 / 3D

| 家族 | 仓库 | README | 许可证 | 判定 |
|---|---|---|---|---|
| BiRefNet | `Comfy-Org/BiRefNet` | [200] | mit | 重打包版（原作者 `ZhengPeng7/BiRefNet` 搜索未出现在前三，插件已注册该仓库且实测 200） |
| SeedVR2 | `ByteDance-Seed/SeedVR2-7B` | [200] | apache-2.0 | 官方 |
| GAN x4 | `ai-forever/Real-ESRGAN` | [200] | 未声明 | **候选** — 这是通用超分仓库，非专门对应蓝本的 4x GAN |
| TripoSplat | `VAST-AI/TripoSplat` | [200] | mit | 官方（**修正**：首轮误匹配到 `stabilityai/TripoSR`，已复核改正） |
| Hunyuan3d 2.1 | `tencent/Hunyuan3D-2` | [200] | 未声明 | 官方（Comfy-Org 版是 2.0，**版本不符需注意**） |

### 音频

| 家族 | 仓库 | README | 许可证 | 判定 |
|---|---|---|---|---|
| ACE-Step 1.5 | `ACE-Step/Ace-Step1.5` | [200] | mit | 官方 |
| MiniMax Music 3 | `MiniMaxAI/MiniMax-Music3` | [200] | 未声明 | 官方（Comfy-Org 版 apache-2.0） |
| Stable Audio 3 Medium | `stabilityai/stable-audio-3-medium` | [401] | other | 官方，gated |
| YuE2 | `m-a-p/YuE2-3B` | [200] | cc-by-nc-4.0 | 官方。**许可证为 CC-BY-NC-4.0，禁止商用** |

### 工具

| 家族 | 仓库 | README | 许可证 | 判定 |
|---|---|---|---|---|
| Mediapipe | `opencv/handpose_estimation_mediapipe` | [200] | 未声明 | **匹配不佳** — 搜索命中的是 OpenCV 的 mediapipe 封装，与蓝本中的 Mediapipe 无明确对应关系 |

---

## 建议接入 `lib/prompt-guides.js` 的条目

分三档，避免把不确定的当权威：

**A. 官方且 README 可达（可直接接入）**
`ByteDance/Bernini-R`、`Boogu/Boogu-Image-0.1-Turbo`、`baidu/ERNIE-Image-Turbo`、`FireRedTeam/FireRed-Image-Edit-1.0`、`meituan-longcat/LongCat-Image`、`Lightricks/LTX-Video`、`Wan-AI/Wan2.1-VACE-14B`、`zai-org/SCAIL-2`、`ByteDance-Seed/SeedVR2-7B`、`tencent/Hunyuan3D-2`、`ACE-Step/Ace-Step1.5`、`MiniMaxAI/MiniMax-Music3`、`m-a-p/YuE2-3B`、`VAST-AI/TripoSplat`

**B. Comfy-Org 重打包版（模板实际加载的文件，README 可达）**
`Comfy-Org/Mage-Flow`、`Comfy-Org/Wan_2.2_ComfyUI_Repackaged`、`Comfy-Org/SDPose`、`Comfy-Org/sam3.1`、`Comfy-Org/Depth-Anything-3`、`Comfy-Org/marigold-v2-0`、`Comfy-Org/MoGe`、`Comfy-Org/SeedVR2`、`Comfy-Org/BiRefNet`、`Comfy-Org/Krea-2`、`Comfy-Org/flux2-dev`、`Comfy-Org/ERNIE-Image`、`Comfy-Org/Boogu-Image`、`Comfy-Org/JoyAI-Image-Edit`、`Comfy-Org/Ideogram-4`、`Comfy-Org/Anima-LLLite`、`Comfy-Org/SCAIL-2`、`Comfy-Org/YuE2`、`Comfy-Org/MiniMax-Music-3`、`Comfy-Org/Wan-Dancer`、`Comfy-Org/Wan-Animate-2`

**C. Gated，需退回重打包版或标记不可用**
所有 401 仓库：Flux 全系、Stable Audio 3、`Wan-AI/Wan2.2`、`Lightricks/LTX-2.5`

**D. 未找到 / 存疑，不建议接入**
`VOID`（未找到）、`Mediapipe`（匹配不佳）、`GAN x4`（匹配到通用超分仓库）、`Anima` / `Anima Base 1.0`（匹配到 Animagine-XL，疑似不同模型）、`Mage-Flow` 三个变体（社区账号，四者搜索结果相同）、`Flux.2 Klein 4B`（仓库实为 9B）

---

## 方法学提醒

- **401 不等于不存在**。必须同时看 `/api/models/<repo>`：能返回元数据但 README 401，就是 gated。本文中六个 401 仓库都验证了这一点。
- **仓库名 ≠ 家族名**。`Flux.2 Klein 4B` 的仓库叫 `FLUX.2-klein-9B`，`FireRed 1.1` 的仓库叫 `FireRed-Image-Edit-1.0`，`Hunyuan3d 2.1` 的 Comfy-Org 版是 2.0。按家族名搜会漏，按仓库元数据里的 likes 反查更可靠。
- **首轮自动匹配的准确率约 85%**。错误集中在：个人转述型社区账号、多变体家族互相串号、名称相近但语义无关的模型（TripoSR vs TripoSplat、Animagine vs Anima）。**复核环节不可省**。