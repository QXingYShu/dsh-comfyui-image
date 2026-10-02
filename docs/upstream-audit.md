# 上游审计：fandc520/dsh-comfyui

调研对象：<https://github.com/fandc520/dsh-comfyui>
调研日期：2026-10-02（上游 HEAD `3440ad6`，2026-09-27，`v0.5.4`）
调研方式：`gh api` 取 LICENSE 原文 → `git clone --depth 1` 后 `git fetch --unshallow`（仓库共 37 个提交）→ 通读 `src/`、`src/client/`、`README.md`、`README.en.md`、`package.json`、`docs/`；另查 <https://awesome-dsh-plugin.com/plugins.json>。

> **阅读约定**：本文用「**代码**」标注直接读源码得到的事实，用「**README 宣称**」标注只在文档里出现、源码未逐条验证的说法。凡是没查到的，一律写「未确认」，不做推断补全。

---

## 1. 许可证（最关键）

### 1.1 结论先行

**MIT License。可以复用其源代码。** 唯一义务是在所有副本或实质性部分中保留版权声明与许可声明全文。没有 copyleft、没有非商业限制、没有字段级 copyleft。

### 1.2 原文证据

`gh api repos/fandc520/dsh-comfyui/contents/LICENSE --jq .content` 解码后的完整内容：

```
MIT License

Copyright (c) 2026 dsh-comfyui contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

交叉验证（**代码**）：

| 来源 | 结果 |
| --- | --- |
| `LICENSE` 文件 | MIT 全文，`Copyright (c) 2026 dsh-comfyui contributors` |
| `package.json` 的 `"license"` | `"MIT"` |
| `README.md` / `README.en.md` 末尾 | `## License` → `MIT` |
| `gh api repos/fandc520/dsh-comfyui` | `license: { key: "mit", name: "MIT License", spdx_id: "MIT" }` |

### 1.3 关于「GitHub API 之前返回 license 是 none」

**该现象本次未复现，但原因可以定位。**

`git log --follow -- LICENSE`（unshallow 后）显示：LICENSE **从仓库的第一个提交起就存在**，从未被删除或后补。

```
fbe9295 2026-08-21 v0.2.0: workflow library, extraction, load area, tags, queue, bilingual UI
```

`git rev-list --count HEAD` = 37，即整个历史只有这一个提交触碰过 LICENSE，且它是首个提交。

结论：LICENSE 一直存在且是标准 MIT。GitHub 的 license 字段是**启发式识别**结果（Licensee 靠匹配已知许可证文本），它偶尔会因为内容改动、首次抓取失败或 API 缓存而短暂报 `none`。**这不是"无许可证"，不要按保留所有权利处理。**

### 1.4 MIT 授予什么、禁止什么

**允许（无需任何额外条件）：**
- 商业使用，包括闭源商业产品
- 自由修改
- 再分发（原文分发、随产品打包、作为依赖）
- 集成进闭源/私有仓库
- 卖出副本 / 提供付费服务
- 私有 fork，不必开源
- 署名不强制（可署可不署），但**保留 notice 是强制的**

**禁止：**
- 实质上没有禁止事项。唯一的"限制"是必须保留上述 notice。

**需要注意的两个 MIT 固有缺口：**
- MIT **不包含明示的专利授权**（无 "patent grant" 条款），专利风险由使用者自行承担。
- MIT 不提供任何担保（`AS IS`），出问题上游不承担责任。

### 1.5 我们能不能复用它的源代码？

**能。** 具体到我们 `dsh-comfyui-image` 的场景：

| 复用方式 | 可行性 | 需要做的事 |
| --- | --- | --- |
| 直接复制 `convert.ts` / `graph.ts` / `params.ts` 等源文件 | ✅ 可行 | 保留原版权声明 + MIT 全文；保留文件头或在你的 LICENSE / NOTICE 里注明"改编自 fandc520/dsh-comfyui (MIT)" |
| 翻译成 JS 后移植 | ✅ 可行 | 同上。注意 MIT 覆盖"实质性部分"，翻译改写**仍然**是衍生作品，义务不变 |
| 只借鉴设计思路、自行实现 | ✅ 可行且最推荐 | 无法律义务，加分项：在 README 致谢里提一句上游 |
| 直接 fork 整个仓库改成我们的 | ✅ 可行 | 保留 LICENSE，保留 git 历史 |

**如果将来上游改了许可证**（改用 AGPL 之类）：已合法获取的旧版本代码仍是 MIT，后续版本不自动传染。这是"尽早锁定当前 HEAD 的 LICENSE 与源码快照"的实际理由。

我们自己的 `dsh-comfyui-image` 已经是 MIT，与上游一致——后续混用两者代码不会出现许可证冲突。

### 1.6 如果真是"无许可证"会怎样（预案，本次不适用）

如果查下来真是无许可证 / "保留所有权利"，法律含义是：**默认全版权保留**。著作权人未作任何许可，公众不获得复制、修改、分发、展示、运行的权利。仅"阅读源码学习思路"属于思想不受著作权保护（著作权不保护思想、方法、原理），这是安全的；但**逐行复制代码、改写代码、抽取函数**都是复制/改编行为，需要授权。

本次**不是**这种情况，无需预案。

### 1.7 dshmarket 注册表条目

`https://awesome-dsh-plugin.com/plugins.json` 中 `owner: "fandc520"` 的条目：

```json
{
  "name": "dsh-comfyui",
  "owner": "fandc520",
  "url": "https://github.com/fandc520/dsh-comfyui",
  "page": "https://awesome-dsh-plugin.com/p/fandc520/dsh-comfyui/",
  "category": "vision",
  "npm": "dsh-comfyui",
  "version": "0.5.4",
  "stars": 94,
  "downloads": 4102,
  "capabilities": ["shell", "fs-write", "fs-read", "network", "credentials", "env"],
  "capabilityRedLines": ["reads credentials/secrets AND has network access"],
  "capabilityCheckedAt": "2026-10-02T03:25:30.995Z",
  "install": "dsh plugin --profile web add dsh-comfyui",
  "added": "2026-08-28"
}
```

要点：

- **注册表条目里不含任何许可证字段**——法律判断只能以仓库 `LICENSE` 为准（已按上节处理）。
- `capabilityRedLines` 标了红线：**"reads credentials/secrets AND has network access"**。这是注册表的能力画像，不是法律结论，但它是一个客观信号：上游同时拥有网络访问权和读取凭据/环境变量的能力（`apiKeyEnv` 默认 `COMFYUI_API_KEY`，读凭据存储）。
- 同表里还有一个相关项目 `dsh-comfyui-canvas`（owner `wbin0001`，10 star，2516 下载），走的是另一条路线——把 ComfyUI 画布当可视 IDE 嵌进 DSH，并提供 `batch_run` / `get_outputs` / `upgrade`。**许可证未查**（不在本次任务范围）。如果我们考虑"通用化"路线，它可能比 fandc520 这条路更贴近目标，值得后续单独审计。

---

## 2. 架构梳理

### 2.1 整体分层（**代码**）

```
宿主侧 TypeScript（Node / cordis）              客户端侧 React（src/client/）
───────────────────────────────                ──────────────────────────
index.ts        431   插件装配 / inject 声明     panel.tsx      3519   右侧停靠面板（单文件）
tools.ts       1060   4 个 agent 工具定义         i18n.ts        592   本地 zh/en 词表
routes.ts      1552   33 条 /comfyui/* HTTP      styles.ts      437   注入样式
skillpack.ts    906   技能包文件存储             card.tsx       373   工具调用结果卡片
params.ts       756   参数契约层                 settings.tsx   226   设置页分区
comfyui.ts      647   ComfyUI HTTP 客户端        connection.tsx 155   连接探测
transfer.ts     548   zip 预设包导入导出          lightbox.tsx    68   图片灯箱
convert.ts      464   UI 图 → API 图              panel-store.ts  67   面板状态
store.ts        345   workflows.json + 资产索引   index.ts        57   slots 注入入口
analyze.ts      172   连通分量分析                trigger.tsx     51   会话头部按钮
skill.ts        159   伴生 skill 全文             api.ts          47   面板 fetch 封装
graph.ts        159   links 归一化 + 虚拟节点
proxy.ts        142   /comfyui/media 媒体代理
config.ts       125   配置 schema
queue.ts        123   队列追踪
progress.ts     103   WebSocket 进度
host-hint.ts     91   浏览器 origin 自学习
http.ts          47   HTTP 小工具
templates.ts     97   3 个内置模板
                                    src 总计 13519 行
```

运行时依赖只有两个：`@deepseek-ai/schemastery`（配置校验）+ `fflate`（zip 预设包）。React 是 devDependency（宿主提供）。peer 是 `@deepseek-ai/cordis ^4.0.1` 和 `@deepseek-ai/dsh-settings` 的四段版本区间。

**关键架构决定（**代码**，见 `src/index.ts:39`）**：`export const inject = ['tools']`——只有 `tools` 是必需服务。`webServer` / `settings` / `credentials` 全部刻意留在 inject 之外**，缺失时优雅降级（无面板、但工具照常可用；无 settings 服务则不挂设置页）。`docs/INCIDENTS.md` 记录了一次真实事故：读了 `ctx.tools` 却没声明 inject，cordis 直接拒绝启动、且报错点远离肇事代码。

### 2.2 它怎么把"任意工作流"变成可调用能力？

答案是**四层叠加**，而不是"把任意图直接暴露给 agent"：

```
第 4 层  comfyui_object_info 工具 ── 让 agent 能现场查服务器支持哪些节点
第 3 层  技能包（skill pack）   ── 告诉 agent 这个工作流"适合什么、哪里会翻车"
第 2 层  params.ts 参数契约层    ── 把 API 图折叠成 {prompt, seed, width, height, steps} 这样的具名旋钮
第 1 层  存储层（store.ts）      ── workflows.json 里的一批 API 格式工作流
────────  入口 ────────
      convert.ts + graph.ts + analyze.ts   把用户画布上的 UI 图转成第 1 层的东西
```

README 宣称的工具是 `comfyui_run` / `comfyui_object_info` / `comfyui_workflow` / `comfyui_skill` 四个（**代码**确认 `tools.ts` 里就是这四个 `ToolDefinition`），另有伴生 skill `dsh-comfyui-workflows`。

### 2.3 图（graph）怎么处理？

分两个文件，职责很干净。

#### `graph.ts`（159 行）——只做两件事

**(a) links 序列化格式归一化。** ComfyUI 前端改过 `links` 数组的写法：

- 旧：`[linkId, originId, originSlot, targetId, targetSlot, type]`（位置数组）
- v0.4 前端：`{ id, origin_id, origin_slot, target_id, target_slot, type }`（对象条目）

`normalizeLink` / `normalizeLinks` 把两者统一成 canonical `GraphLink = [number, number, number, number, number, string]`，读不出来的条目直接跳过。分析和转换都先过这一层。

**(b) 虚拟节点改线（`resolveVirtualLinks`）。** 有些节点只存在于前端画布，服务端根本没有，必须在转换前把它们的连线改写掉：

- **KJNodes `SetNode` / `GetNode`** —— "无线"连线，按名字配对。`GetNode` 的输出等于同名 `SetNode` 的输入；同名多个 `SetNode` 时取 `order` 小于它的最大者（复刻前端的作用域规则）；找不到匹配的 `SetNode`（例如空的 optional slot），消费端保持未连接。
- **rgthree `Mute / Bypass Relay` / `Repeater`** —— 它们的 `OPT_CONNECTION` 连线只传递静音/绕过状态，不传数据；状态已经存在各节点自己的 `mode` 里，所以连线直接丢弃。

**实现上有个值得学的细节**：改线时**保持 link id 不变**，只改 `origin` 段。这样节点 `inputs[].link` 里的引用不用重算。递归解析带 `seen: Set` 防环。

#### `convert.ts`（464 行）——UI 图 → API 图

对标 ComfyUI 前端的 `convertToApiFormat`，核心是把 `widgets_values` 这个**位置数组**还原成按名字索引的 `inputs` 对象：

1. **连线** → `[String(nodeId), slot]`。节点 id 必须转成字符串——服务端 `execution.py validate_inputs` 用字符串键做字典查找，传数字直接 KeyError。
2. **widget 顺序**（`widgetNamesFor`）：以图节点自身的 `inputs` 数组为准（含 `widget.name` 的条目），而不是 object_info 顺序。因为图里的顺序包含动态子 widget，且**被连线接住的 widget 仍占据 widgets_values 的位置**。
3. **`control_after_generate` 占位**：前端在名为 `seed`/`noise_seed` 的 INT 后面渲染一个"生成后控制"下拉，它的值占 `widgets_values` 一个槽位但**没有对应的 API 输入**。转换时消费这个槽位但不写进工作流——否则后续所有 widget 全部错位。
4. **`Reroute` 与 `mode === 4`（bypass）直通**：输出跟随第一条有连线的输入。
5. **`UI_ONLY` 节点跳过**：`Note` / `StickyNote` / `Reroute` / `Fast Groups Bypasser (rgthree)`。
6. **未注册节点**：`Primitive*` 内联第一个 widget 值；其它 → 整体失败并报出节点类型。
7. **子图实例**（`workflow*` 开头的节点类型）→ 明确不支持，直接报错让用户回 ComfyUI 展开。
8. **DynamicCombo V3 保持扁平**：主输入的值是 option key 字符串，子控件以 `主名.子名` 平铺。注释里明确写着不要包成 `{key, inputs}`（Issue #10，`SaveVideo` 的 `codec` 就在这里炸过）。
9. **输出槽位越界**检查：画布声称 SaveImage 有 2 个输出但服务端只有 1 个 → 断开该引用并给 warning。
10. **引用完整性终检**：任何 `[nodeId, slot]` 指向不在本次提取结果里的节点 → 整体失败（否则提取时"成功"、运行时才炸）。
11. **必需输入缺失** → 报错而不是产出"能转但跑不起来"的工作流；`lazy: true` / 带 `template` 的（`COMFY_AUTOGROW_V3` 一类）豁免。
12. 返回 `{ ok: true, workflow, warnings }` 或 `{ ok: false, error }`，**失败一律带可执行的中文提示**（告诉用户去画布上改哪根线）。

#### `analyze.ts`（172 行）——连通分量分析

用户的画布常常同时躺着好几条独立流程。`groups` 只是视觉矩形、没有执行语义，真正的可执行单元是**按 links 计算的连通分量**（排除 bypassed 和悬空节点）。产出 `components`（按大小排序）、`isolated`（悬空节点）、`bypassedCount`、`mode: 'single' | 'multi'`，喂给面板的"提取"选项：整体 / 按分量 / 主流程（最大分量）。

---

### 2.4 `params.ts` 的参数快照机制

#### 数据结构

`WorkflowParameter`（**代码**，`params.ts:13-50`）：

```ts
{ id, name, label, type: 'string'|'number'|'boolean',
  nodeId, inputKey, default, description?,
  random?,        // number(种子)类：不传时每次随机
  numberKind?,    // 'int' | 'float'（来自 object_info）
  min?, max?, step?,
  options?,       // 下拉候选值（来自 object_info）
  upload?,        // 'image'|'video'|'audio'|'media' 加载节点
  subfolder? }
```

`name` 是 agent 传值用的英文标识（`prompt` / `seed` / `width` / `height` / `steps` / `duration` / `aspect_ratio` / `size`），`label` 是面板展示的中文。

#### 自动识别（`analyzeWorkflowParameters`，**代码**）

文件头注释自己写明"**刻意保守**"：只认文本提示词、`EmptyLatentImage` 宽高、`KSampler` 的 `steps`/`seed`。另外加了一层 key 名启发式兜底自定义节点（MiniMax 等）：

- `TEXT_CLASSES` 集合（`CLIPTextEncode` / `CLIPTextEncodeFlux` / `CLIPTextEncodeSDXL` / `CLIPTextEncodeWithModel` / `CLIPTextEncodeWithContext` / `PrimitiveString` / `PrimitiveStringMultiline` / `TextGenerate`）× `TEXT_KEYS`（`text` / `value` / `prompt`）
- `consumed` 集合：节点的输出没被任何节点消费 → 它自己的文本输入是"死输入"，不暴露成 prompt（防止把画布上孤立的文本框当成提示词）
- `take(category, limit)` 每类别配额：prompt 最多 2（正/负），steps/seed/duration/aspect_ratio 各 1，size 只认第一个 resolution 节点
- 加载节点靠 object_info 的 upload 标记（`image_upload` / `video_upload` / `audio_upload`）或"文件列表型 COMBO + 类 loader 的 key 名"识别
- 名字去重：重复的自动变 `prompt_2` / `prompt_3`

#### 快照是什么、为什么需要 refresh

**快照 = 存进 `workflows.json` 的那个 `parameters: WorkflowParameter[]`**。其中 `options` / `numberKind` / `min` / `max` / `step` 这几个字段是**从 object_info 派生的、在保存那一刻拷下来的**。

`refreshParameterMetadata` 的注释把为什么需要 refresh 讲得很直白（**代码**，`params.ts:506-524`）：

> 保存的工作流参数清单在 save/analyze 时写进 workflows.json 之后再也不会看到 object_info 了。自那以后长出来的音色库或新挂上的 loader，会在运行期把新值拒掉（`applyWorkflowParameters` 里的 options 检查）。面板下拉没这个问题——它每次打开都重查 object_info——**这就是刷新必须是显式一步的原因，而不是静默自动更新**。

过期后的症状非常具体：agent 传了一个新值，`action: run` 报 `parameter "x" value "y" is not one of the allowed options: ...`。**这是快照过期，不是服务器没有这个值**——但两者的报错长得几乎一样，这就是坑的深度。

刷新入口有三个（**代码**）：`comfyui_workflow action: refresh {id}`、`POST /comfyui/workflows/refresh-params`、以及面板 UI。

刷新**只重算 object_info 派生的字段**（`options` / `numberKind` / `min` / `max` / `step`），`id`/`name`/`label`/`type`/`default`/`random`/`upload`/`subfolder` 和整个参数集合原样保留——用户在面板手加的"高级参数"不会丢。返回 `changed` 列出实际变了的参数名。

伴生 skill 里专门花了两大段教 agent"**先刷新，再查询**"（TTS-Audio-Suite 音色库），并强调单独打 `?refresh=1` 只重扫 TTS 进程缓存、**不更新快照**。一个 skill 要专门写这么大一段来绕开自己的设计副作用——这个设计的代价是可见的。

---

### 2.5 `templates.ts` 的内置模板

**硬编码 JSON**（**代码**，`templates.ts:17-71`），就三个，全部是 TypeScript 对象字面量内联在 `const TEMPLATES: WorkflowTemplate[] = [...]` 里，**不是读文件**：

| id | 名称 | 内容 |
| --- | --- | --- |
| `txt2img` | SDXL text-to-image | 6 节点：`CheckpointLoaderSimple`(sd_xl_base_1.0) / `EmptyLatentImage` / 两个 `CLIPTextEncode` / `KSampler` / `VAEDecode` / `SaveImage` |
| `img2img` | SDXL image-to-image | 上面 + `LoadImage` + `VAEEncode` |
| `video` | Wan 2.1 text-to-video | 8 节点：`UNETLoader` / `CLIPLoader` / `VAELoader` / `WanTextEncode` / `WanImageToVideo` / `KSampler` / `WanVideoDecode` / `SaveVideo`——**依赖第三方自定义节点 ComfyUI-WanVideoWrapper** |

每个模板还有一个 `guide: string` 字段——一段英文说明书，逐一列出"节点 4 是 checkpoint、节点 6 是正向提示词…"，**直接拼进 `comfyui_run` 的工具描述给模型看**。

三个辅助函数：`findTemplate(id)`、`applyTemplateInputs(workflow, overrides)`（按节点 id 合并部分 inputs，后合并的能看到先合并的）、`cloneWorkflow`（`JSON.parse(JSON.stringify())` 深拷贝，防止改到共享常量）。

**值得注意的事实**：它自己的"通用化"**不是靠更多内置模板**，而是靠"工作流库"——用户可以在面板里导入任意 API 工作流 JSON 或从画布提取。所以 `templates.ts` 的定位是**零配置起步的默认档**，不是能力上限。

---

### 2.6 sync / async 两种模式怎么实现的？

先纠正一个容易误解的点：**`queue.ts` 不是 sync/async 的实现**。`queue.ts`（123 行）是 `QueueTracker`（队列追踪 + 资产归档）。sync/async 在 `tools.ts`，轮询在 `comfyui.ts`。

#### 完成判定（三选一，**代码**，`comfyui.ts:530-558` + `queue.ts:119-123`）

```ts
// comfyui.ts waitForCompletion
if (status?.status_str === 'success' || status?.completed === true || hasMedia(entry)) return entry
if (status?.status_str === 'error') throw new ComfyUIError(historyErrorMessage(promptId, entry))
if (Date.now() >= deadline) throw new ComfyUIError(`... timed out after ${timeoutMs} ms ...`)
if (signal.aborted) { await this.interrupt(); throw ... }
await sleep(pollIntervalMs, signal)
```

`hasMedia(entry)` 是**兜底**：只要 `outputs` 里任何一个节点有 `images` / `videos` / `gifs` / `audio` 非空就算完成。这对自定义 Save 节点很有用——它们的 history 状态可能不标准。

失败信息从 `status.messages[].payload.exception_message` 里拼出来（截断 500 字符），不是回一句 "unknown error"。

#### sync

`waitSync()`（`tools.ts:282-321`）→ `client.waitForCompletion({promptId, timeoutMs, pollIntervalMs, signal})`。默认超时 `config.timeoutMs`，工具参数 `timeout_ms` 可覆盖（schema 上限 3,600,000 ms）。中断不算错误：signal abort 时返回一个 `status: 'interrupted'` 的结果而不是抛异常。

#### async

`mode: "async"` 时交给**宿主的 jobs 服务**（`tools.ts:376-419`）：

```ts
const jobs = ctx.get('jobs')
if (jobs === undefined) throw new Error(
  'comfyui_run: background jobs unavailable — load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs')

const jobId = jobs.start({
  kind: 'comfyui', label,
  ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
  run: () => ({ cancel: () => client.interrupt(), done }),   // done 里跑同一个 waitForCompletion
})
return { kind: 'background', jobId, promptId, label }
```

**异步怎么知道完成？——和 sync 完全一样，也是轮询 `/history/<promptId>`。** 只是把等待从工具调用线程搬到后台 job。**不是 WebSocket 订阅**。`cancel` 会向 ComfyUI 发 `POST /interrupt`。工具立刻返回 jobId，agent 之后用 `job_output` 取。

注意它显式声明了缺失 jobs 服务时的降级路径（告诉你装哪个包），而不是静默失败。

#### QueueTracker 的一个巧妙点

`sweep()`（`queue.ts:85-116`）在**读队列/资产路由时顺便执行**，而不是起后台定时器——文件头注释写明 "Sweeps run on read… so no background timers leak into the fiber lifecycle"。幂等靠 `archived: Set<string>`。可持久化，所以 web server 重启后已完成的 run 仍会落进资产索引。记忆上限 500 条，超了丢最老的。

---

### 2.7 `convert.ts` 是做什么的？

**是的，就是浏览器 UI 图 → API 图转换。** 详见 §2.3。

`POST /comfyui/comfy-workflows/analyze` 和 `POST /comfyui/comfy-workflows/extract` 是它的两个 HTTP 出口。提取时 `convertGraphToApi(graph, objectInfo, { includeNodeIds })` 的 `includeNodeIds` 限定只转换某一个连通分量——**注意注释里的设计**：link 解析仍然用完整图，因为不同分量之间不共享 link，所以这样做是安全的。

---

### 2.8 `skillpack.ts` 的技能包机制

#### 谁写

两个来源，都合法：

1. **用户**——面板的技能包编辑器（左栏文件列表 + 右栏编辑器），或从外部导入（按扩展名自动分目录：`.py/.sh/.mjs` → `scripts/`，`.png/.jpg/.webp/.csv` → `assets/`，其余进根或 `references/`）。
2. **Agent**——`comfyui_skill` 工具，9 个 action：`list` / `read` / `write` / `append` / `mkdir` / `rename` / `delete` / `enable` / `require`。

#### 内容存哪

`<dataDir>/skills/<workflow-slug>/`（默认 `dataDir = DSH_HOME/data/dsh-comfyui`，可配 `skillsDir` 指到同步盘/版本库）：

```
skills/<workflow>/
  SKILL.md          # 主文档：适用场景 / 关键参数 / 注意事项（不可改名、不可删）
  references/       # 参考文档：风格合集、排错记录
  scripts/          # 辅助脚本
  assets/           # 参考图（面板可预览）
```

限额（**代码**）：单文件 256 KB（`assets/` 里的二进制 4 MB），整包 2000 文件 / 20 MB。文件名正则 `/^[A-Za-z0-9_一-龥][A-Za-z0-9._一-龥-]{0,127}$/`——注释说明放宽到 128 字符是因为批量拷贝的模板库有超长描述性文件名。

**安全**（文件头注释明说）："Every path in this module arrives from the browser or from workflows.json and is therefore untrusted"——名字走严格正则、桶走白名单、解析出的路径再用 `relative()` 复查后才 read/write/unlink。

#### 怎么注入 —— 这是整个设计最值得学的一点

**技能包刻意不进宿主的 `ctx.skills` 注册表。** `skillpack.ts:12` 的注释写得很清楚：

> Nothing here is registered with the host `ctx.skills` registry: that registry publishes every model-invocable skill into a durable always-on catalog, which is exactly the cost this design avoids.

取而代之的是**三级披露阶梯**：

| 级别 | 动作 | Agent 拿到什么 | 上下文成本 |
| --- | --- | --- | --- |
| 1 | `comfyui_workflow action: list` | 每个工作流一行 `技能包: <摘要>（N 个文件）`，正文**不进来** | 一行/工作流 |
| 2 | `comfyui_workflow action: skill {id}` | SKILL.md 正文 + 绝对目录路径 | 一次，仅在选中后 |
| 3 | 模型自己 `comfyui_skill action: read {path}` | 单个 reference 文件（> 40k 字符截断） | 仅在正文点名时 |

**几十个工作流各带一整套文档，平时对话成本只是一行摘要。**

#### 伴生 skill（唯一常驻的东西）

`src/skill.ts` 里的 `COMFYUI_SKILL`（159 行中文长文，名字 `dsh-comfyui-workflows`，`source: 'runtime'`）走 `ctx.skills.register`，rank 250——用户/项目级 skill 可以覆盖它。它讲的是**概念和规则**，不是参数表：

- "图工作流"（画布，衍生主题）vs "API 工作流"（可执行，运行主题）的二分
- 连通分量判定规则（groups 只是矩形，可执行单元 = 连通分量）
- 图→API 提取的技术规则（字符串 id、widget 顺序、control_after_generate 占位、Reroute 直通、虚拟节点改线、DynamicCombo 扁平、子图不支持…）
- TTS-Audio-Suite 音色库的查询/刷新流程（**这段占了相当篇幅，是它自己的用户群特例**）
- 加载区说明

#### "运行前必读"闸门

工作流上可以勾 `requireSkill`（面板勾选，或 `comfyui_skill action: require`）。勾上后（**代码**，`tools.ts:801-806`）：

```ts
if (saved.requireSkill === true && saved.skillDir !== undefined && !hasReadSkillPack(exec.agent, saved.id)) {
  throw new Error(`comfyui_workflow: 工作流 "${saved.name}" 标记了运行前必读技能包 — 先调用 action: skill { id: "${saved.id}" } 读完再运行。`)
}
```

`hasReadSkillPack` 按 **agent 维度**记录本会话读过哪些包（`tools.ts:120`）。只有 `action: run` 这一条路径被拦，`list` / `skill` / `get` / `refresh` 都不受影响。读到 `SKILL.md` 就算解除。

---

### 2.9 它有没有 UI 面板？面板代码在哪？

**有，而且 UI 是这个项目最大的部分。**

- **面板代码在 `src/client/`，不在 `src/routes.ts`。** `src/client/panel.tsx` **3519 行 / 157 KB 单文件**，是右侧停靠面板（工作流 / 资产 / 队列三个页签）。另有 `card.tsx`(373)、`settings.tsx`(226)、`connection.tsx`(155)、`lightbox.tsx`(68)、`trigger.tsx`(51)、`panel-store.ts`(67)、`api.ts`(47)、`i18n.ts`(592)、`styles.ts`(437 注入样式)。

- **注册方式**（`src/client/index.ts`）：通过宿主 `slots` 服务注入四个位置：

  ```ts
  ctx.slots.inject('shell.overlay', ...)                       // 右侧停靠面板
  ctx.slots.inject('conversation.session.header.actions', ...)  // 会话头部「ComfyUI 面板」按钮
  ctx.slots.inject('tool.call.toolview', ...)                   // comfyui_run / comfyui_workflow 的结果卡片
  ctx.slots.inject('settings.section', ...)                     // 设置页 ComfyUI 分区
  ```

- **`src/routes.ts`（1552 行）不是 UI，是 HTTP 服务端**。33 条 `/comfyui/*` 路由，用 Node 原生 `node:http` 的 `IncomingMessage` / `ServerResponse`，通过 `webServer.register({kind:'exact', path, handler})` 注册，**没有用任何 Web 框架**。路径包括：

  ```
  /comfyui/ping                       /comfyui/config          /comfyui/test
  /comfyui/workflows                  /comfyui/workflows/delete /comfyui/workflows/run
  /comfyui/workflows/export           /comfyui/workflows/export/last
  /comfyui/workflows/import/analyze   /comfyui/workflows/import/apply
  /comfyui/workflows/refresh-params   /comfyui/workflows/skill  /comfyui/workflows/skill/import
  /comfyui/workflows/skill/raw        /comfyui/workflows/skill/reveal
  /comfyui/workflows/recognize        /comfyui/workflows/input-options
  /comfyui/comfy-workflows            /comfyui/comfy-workflows/analyze
  /comfyui/comfy-workflows/extract
  /comfyui/loadarea                   /comfyui/upload          /comfyui/media-hash
  /comfyui/media-lookup               /comfyui/media-size       /comfyui/current-image
  /comfyui/assets                     /comfyui/assets/delete
  /comfyui/queue                      /comfyui/jobs            /comfyui/jobs/actions
  /comfyui/jobs/media                 /comfyui/media (在 proxy.ts)
  ```

- **媒体代理**（`src/proxy.ts`）有两个设计细节值得单独拎出来：
  1. **按文件名寻址而非 prompt+node+index**。因为 ComfyUI 的 `/history` 在内存里，重启或点一下"清空历史"就丢，按文件名寻址能让旧资产照样打开。旧的 prompt 形式还保留着，靠资产索引兜底。
  2. **Range 透传 + 流式转发**。`<audio>` / `<video>` 播放器要发 `Range: bytes=…` 请求，没有 206 + Content-Range 的话进度条会弹回、时长会算错。ComfyUI 的 `/view` 原生支持 Range，直接把它的状态码和头透传出去。

- **host-hint 自学习**（`src/host-hint.ts` + `index.ts:415-425`）：往 `index.html` 的 `</head>` 前注入一行 `fetch("/comfyui/ping")`，让后端学到浏览器实际用的 origin（LAN IP / 域名 / 反代），生成的媒体 URL 才对。零配置。

- **密钥不下发**：README 宣称"API Key 不下发浏览器"（**代码**支持：`/comfyui/config` 返回前经 `redact(runtime, apiKey)` 处理；`/comfyui/test` 走 `sameOrigin` 校验）。远程 ComfyUI 在鉴权代理后面时，密钥从凭据存储或 `apiKeyEnv`（默认 `COMFYUI_API_KEY`）读。

- **进度**（`progress.ts`）：一条共享 WebSocket 连 ComfyUI 的 `/ws`，监听 `progress` 事件。设计取舍很诚实——注释明说它跟踪的是**服务器广播给所有客户端的进度，包括非本插件提交的任务**；连不上（远程带鉴权代理）就退化成"有队列行但没进度条"，3 秒重连直到 dispose。**注意 progress 只服务面板，工具路径完全不走它。**

---

## 3. 值得借鉴的架构思想清单

> **借鉴设计思路 ≠ 复制代码。** 下表右列是复杂度估计，按"我们目前的代码基础（`lib/comfy.js` 647 行级别的 HTTP 客户端 + `lib/workflows.js` 占位符模板）"估算。

| # | 设计 | 解决什么问题 | 我们该怎么用 | 复杂度 |
| --- | --- | --- | --- | --- |
| 1 | **`/object_info` 作为一等工具** | agent 凭空写的 `class_type` 大概率在用户服务器上不存在，失败还很难懂 | 加一个 `comfyui_object_info`（带 `filter` 子串过滤），并在生成前用它校验 `class_type` 存在 | **低**。我们已有 HTTP 客户端，加个 GET + 截断输出即可。60 s TTL 缓存照抄思路即可 |
| 2 | **links 序列化双格式归一化** | ComfyUI 前端改过 `links` 的写法，只认一种格式会让老工作流全废 | 我们的图→API 转换第一步就做归一化。同时防御性地读 `Array.isArray` 和对象两种形态 | **极低**。~40 行纯函数 |
| 3 | **虚拟节点改线** | KJNodes Set/Get、rgthree Relay 在画布上有连线，但服务端没有这些节点，不改线就跑不了 | 如果要做图→API 转换，这是必需项。注意保持 link id 不变这个技巧 | **中**。~120 行，但需要大量真实工作流验证才能确认覆盖够了 |
| 4 | **转换期严格校验 + 引用完整性终检** | "提取成功但运行时才炸"是最差的失败模式 | 采纳它的失败标准：引用了不在范围内的节点、缺必需输入 → **提取时**就失败并给出可执行的中文提示（告诉用户改哪根线） | **中**。逻辑本身不难，难在错误信息要具体到可执行 |
| 5 | **参数契约层** | 裸 nodeId+inputKey 的覆盖对 agent 极不友好（它得先读完整个 JSON 才知道该改哪） | 把我们的 `WORKFLOW_SPECS` 从"代码常量"泛化成"JSON 描述符"，每个参数声明 `{nodeId, inputKey, type, default, range, options}`。这样参数名从节点语义里解耦 | **中**。我们已有 `renderWorkflow` + `coerceParameter` + `ranges`，主要是把"从图里扫出来"改成"从描述符里声明"，**反而比上游的启发式更可靠** |
| 6 | **三态完成判定** | 只判 `status_str === 'success'` 在自定义 Save 节点上会挂死 | 采纳 `success || completed || hasMedia(entry)` 三选一 + 超时 + abort 时发 `/interrupt`。这条几乎没有成本 | **极低**。~20 行，但救命 |
| 7 | **sync/async 双模式** | 视频/大图生成几分钟，工具同步等待必然超时 | 完全采纳：async 交给宿主 jobs 服务（`jobs.start({run: () => ({cancel, done})})`），返回 jobId 让 agent 用 `job_output` 取。缺 jobs 服务时明确报错并说装哪个包 | **低**。~40 行，我们只需确认目标 dsh 版本有 jobs 服务 |
| 8 | **同源媒体代理（按文件名寻址 + Range 透传）** | 浏览器直连 ComfyUI → CORS、混合内容、密钥泄露；按 prompt 寻址 → ComfyUI 一重启所有历史卡片变白图 | **优先级最高的一条**。我们的图片现在是怎么给用户看的值得复查。文件名寻址 + 206 透传这两点尤其重要（`<img>` 无感，但将来有音频/视频就致命） | **中**。路由本身简单，难在正确透传 Range/Content-Range/206 |
| 9 | **`apiKeyEnv` + 密钥永不下发浏览器** | 远程 ComfyUI 在鉴权代理后需要 key | 采纳。我们现在只连本地，但通用化必然带远程。配置项和 `redact` 一起做 | **低** |
| 10 | **伴生 skill 讲"概念与规则"而不是"参数表"** | 参数表会随工作流变化而过期；概念和判据是稳定的 | 我们的 `skills/SKILL.md` 应该讲：怎么选模型、什么时候用哪个 kind、ComfyUI 报错的常见原因——**不重复 `lib/define-tool.js` 的工具描述** | **低**。纯文档 |
| 11 | **三级披露而非全量注入** | 几十个工作流各带整套文档会把常驻上下文吃光 | 如果我们将来也支持用户自定义工作流+文档，用它的阶梯：`list` 给一行摘要 → 按需取正文 → 只读被点名的引用文件。**关键是不要把它们注册进 `ctx.skills`** | **低**（纯协议设计）。做完整编辑功能则**高** |
| 12 | **加载区（load area）** | agent 不用猜服务器上的文件名——这是 img2img 最大的失败源 | 采纳"多槽位 + 按类型顺序自动填充未指定的 loader 参数"这个**语义**。UI 可以不做（我们只做工具），但"用户已经选好的图 → 隐式成为默认值"这个交互值得提供 | **语义层低 / UI 层高**。建议先只支持"显式传文件名" |
| 13 | **进度条（共享 WebSocket）** | 用户看不到生成到哪一步 | 可选。`progress.ts` 只有 103 行，逻辑很干净（一条 socket 跟所有任务，断了重连）。但**先确认我们的工具路径需不需要**——agent 侧其实不需要进度 | **低**（如果要做） |
| 14 | **"运行前必读"闸门** | 防止 agent 不看说明书就乱跑一个复杂工作流 | 概念可直接借鉴：按 agent 维度记"本会话读过哪些文档"，没读过就拒绝并指路。实现依赖 skill pack 体系（第 11 条） | **低**（依赖第 11 条先落地） |
| 15 | **惰性 sweep，不起后台定时器** | 往 cordis fiber 生命周期里漏定时器是常见事故源 | 采纳这个纪律。我们现在做资产/历史追踪时，任何轮询都挂在请求路径上 | **零成本**。是个纪律而不是功能 |
| 16 | **可选服务 + `inject` 纪律** | 插件因为读了没声明的服务导致宿主起不来 | `export const inject = [...]` 里只放**必需**服务，`webServer` / `settings` 之类留外面并优雅降级。`docs/INCIDENTS.md` 那次事故值得我们当规范读 | **零成本**。纪律 |
| 17 | **templates 里带 `guide` 字段** | agent 不知道"节点 6 是正向提示词" | 采纳：我们已有 `spec.summary` / `spec.guidance`，把 `guidance` 拼进工具描述是对的。再往前一步——加"哪些参数值得调、哪些别动"（上游明确说 cfg/denoise 不在自动集里） | **零成本**。我们已经在做 |

---

## 4. 我们不该照搬的部分，以及它的已知短板

### 4.1 不该照搬

1. **不要照搬 UI 面板（`src/client/`，约 5600 行 / 26% 的代码）**。3519 行的单文件 `panel.tsx` + 437 行注入样式 + 592 行本地 i18n，是一个人长期迭代的结果，不是可复制的范式。它还要求宿主提供 `slots` + `webServer` + `dsh-settings` 三个服务。对我们这种"工具优先"的插件，ROI 极低。**建议：整个 client/ 不碰。**

2. **不要照搬内置模板的硬编码方式**。我们的 `workflows/*.api.json` + `{{placeholder}}` 渲染（`lib/workflows.js`）**已经比它好**：模板可 diff、可被不懂 TS 的用户改、占位符渲染失败会响亮报错而不是静默把 `undefined` 送到 GPU。但要吸收它的 `guide` 做法——把"节点 id → 含义"写进工具描述。

3. **不要照搬参数快照语义（暂时）**。快照过期是一个真实的、用户可见的、需要在 skill 里花两大段解释才能绕开的坑。我们是"模板 + 契约"，没有工作流库就没有快照过期问题——**`refresh` 在我们是纯负担**。只有当我们接受"用户导入任意工作流"时这个问题才会出现，那时再引入，而且要引入 `refresh` 就得同时解决"agent 怎么知道该刷新了"。

4. **不要照搬 TTS-Audio-Suite 那类特例**。`skill.ts` 里 TTS 音色库的查询/刷新流程占了整个伴生 skill 相当大的篇幅——这是它自己用户群的问题，不是通用架构。**教训：伴生 skill 要保持短，通用规则才放进去。**

5. **不要照搬它的 source 混杂**。`convert.ts` / `params.ts` / `routes.ts` 里大量中文硬编码（错误信息、`label`、提示语），没有 i18n 层。我们至少应保持英文/中立错误信息，方便上游 issue 复现。

6. **不要照搬它自建的 647 行 HTTP 客户端**。我们已有 `lib/comfy.js`。

7. **不要照搬 `hasReadSkillPack` 这种"必须先读文档"的强闸门**作为默认。它很好用，但前提是用户自己写了文档；我们的模板是我们维护的、skill 已经覆盖了，闸门只会平白增加一步。

### 4.2 已知短板（诚实记录）

**A. 参数自动识别很保守，而且脆弱。** `analyzeWorkflowParameters` 靠节点类名 + key 名硬编码启发式（`TEXT_CLASSES` / `EmptyLatentImage` / `KSampler`）。Z-Image / Qwen-Image / Wan / MiniMax / TTS 这些非 SD 系全靠后面的 key 名兜底。更要命的是：**cfg、denoise 和模型选择被明确排除在自动集之外**（伴生 skill 自己写的："cfg/denoise 与模型选择不在其中，保持工作流原样"）——而这恰恰是 agent 最想调的旋钮。识别不了的输入（`media_state` JSON 数组那类）需要用户去面板手动加"高级参数"。**这说明它的"通用"是靠人工兜底的，不是靠机制的。**

**B. 参数快照过期是真实且深的坑。** 症状（"value not one of the allowed options"）和"服务器真的没有这个值"几乎无法区分，用户必须主动跑 refresh。伴生 skill 花了两大段教 agent 绕开它。设计上刻意如此（为了不让库变化悄悄影响已存工作流），但代价是用户困惑。

**C. 图→API 转换有明确的硬边界。** 代码注释里能直接读到踩过的坑编号：子图（`workflow*` 节点）**不支持**，用户必须回 ComfyUI 展开；未注册的非 `Primitive` 节点**整个提取失败**；对象型 `widgets_values`（VHS_VideoCombine）、DynamicCombo V3（Issue #10）、`control_after_generate` 占位（Issue #8）每一个都曾导致"提取出来跑不了"。这是**遇到一个 case 打一个补丁**的模式（注释大量引用具体 Issue 号），泛化能力有限：来一个新节点类型很可能又要加分支。

**D. 内置模板只有 3 个且偏旧。** `sd_xl_base_1.0` 是 2023 年的模型；`video` 模板要用户自己装 ComfyUI-WanVideoWrapper。它的通用性完全依赖用户在工作流库里手动添加——**没有一个"安装即有现代模型"的开箱体验**。

**E. 代码规模已经失控，核心文件过大。** `routes.ts` 1552 行、`tools.ts` 1060 行、`panel.tsx` 3519 行、`params.ts` 756 行、`skillpack.ts` 906 行，src 总计 13519 行。**没有一个核心文件在 500 行以内。** 这是单人高频迭代的自然结果，不是好范式——照抄结构会直接复制这个问题。

**F. 测试很弱。** `devDependencies` 里**没有测试框架**（无 vitest / jest）。测试是 7 个手写 `node scripts/*.mjs`（`test-convert` / `test-skillpack` / `test-store-params` / `test-transfer` / `analyze-sessions` / `run-16x9` / `run-cg-portrait`），而且 **`package.json` 里没有 `test` script**，CI（`cordis.patch.yml`，131 字节，内容未确认）是否跑它们存疑。相比之下我们已经有 `npm test` 跑三个脚本、`test:host`、`test:smoke` 三档——**我们的测试纪律比它好。**

**G. 能力面很宽，安全画像触红线。** dshmarket 标了 `capabilityRedLines: ["reads credentials/secrets AND has network access"]`。能力包括 `shell` / `fs-write` / `fs-read` / `network` / `credentials` / `env`。agent 能写文件到磁盘、能上传下载媒体、能读凭据。`skillpack.ts` 的路径校验做得不错（正则 + 白名单 + `relative()` 复查），但**能力面本身就宽**。对我们的启示是反向的：**能力面收窄，别为了"通用"把 `shell` / `credentials` 都引进来。**

**H. 有过真实事故，且编译期零提示。** `docs/INCIDENTS.md` 记录：`echoCompletion()` 向会话注入了一条**缺 `id` 的 message**，违反 host 的 `Message` 契约，导致整份会话日志校验失败、**整个会话拒绝加载**（2238 条 message 事件里恰好 1 条坏的就报废了整个会话）。修复要停进程、备份、重压持久化文件。教训是"宁可注入失败也不写坏数据"。**这是 DSH 插件的共性风险，不是它独有。**

**I. 版本耦合紧，而且作者为此专门写了决策文档。** `peerDependencies` 锁 `@deepseek-ai/dsh-settings` 的四段版本区间，README 顶部挂了一张"版本配对"表警告装错版本 dshmarket 会报风险提示，`docs/release-0.4.0-decisions.md` 专门记录了为什么把 `optional: true` 摘掉（为了触发 dshmarket 的 `soft-incompatible` 风险横幅）、为什么留 beta 线、为什么不做双版本兼容 shim（"宿主 0.1.x 预发布不承诺兼容，版本配对是生态约定"）。**DSH 生态插件的普遍痛点，值得我们立项时就考虑版本策略。**

**J. README 与代码存在需要留意的落差。** README 描述的是完整产品形态（面板、预设包、加载区、技能包编辑）。对**纯 headless / 无 webServer 环境**而言，只有 `tools` 服务是必需的，其余全部降级——也就是说 README 里的核心卖点（面板）在没有 web server 的宿主上完全不存在。这一点 README 没有明说（**未确认是否有其它文档补充**）。

---

## 5. 给我们的落地建议（简版）

**通用化的最短路径不是"更多内置模板"。** 上游的模板策略其实是最弱的一环，它真正的通用化靠的是"工作流库 + 图→API 转换 + 参数契约"三层。

建议分三档：

**第一档（低成本、直接抄思路，1 个迭代内可完成）**
1. `comfyui_object_info` 工具（`filter` 子串过滤 + 60 s 缓存）
2. sync/async 双模式 + jobs 服务（README 说视频强烈建议 async，我们迟早要支持视频/音频）
3. 完成判定改成三选一 + abort 时发 `/interrupt`
4. 同源媒体代理 + Range 透传（先复查我们现在的媒体路径）
5. `apiKeyEnv` + `redact`

**第二档（通用化的真正门槛）**
6. 参数契约层泛化：把 `WORKFLOW_SPECS` 变成可声明 `nodeId/inputKey` 的 JSON 描述符，取代 `{{placeholder}}` 的位置耦合——**这一步做完，"任意 ComfyUI 工作流"就基本通了**
7. 接受用户导入任意 API 格式工作流 + 参数快照 + `refresh`（**注意 #3 的教训：refresh 的坑要连着"agent 怎么知道该刷"一起设计**）
8. 图→API 转换（`graph.ts` + `convert.ts` 思路）+ 连通分量分析

**第三档（明确不做）**
- UI 面板、预设包 zip、加载区 UI、技能包编辑器 —— 对工具型插件 ROI 太低

**许可证层面：绿灯。** MIT，可以放心复用、改编、翻译移植，只需保留版权声明 + MIT 全文。我们自己的 LICENSE 也是 MIT，无冲突。

---

## 附：本次调研的未确认项

- `cordis.patch.yml`（上游 131 字节）内容未读，CI 是否跑测试存疑
- `src/client/panel.tsx`（3519 行）只读了 `src/client/index.ts` 的注册代码，未逐行读面板实现
- `src/transfer.ts`（548 行，zip 预设导入导出）只从注释和调用点了解了轮廓，未通读
- `CLAUDE.md`（31 KB）未读
- 上游是否在我们调研之后修改了 LICENSE —— 复用代码前应重新确认一次
- `README.md` 里"上千文件的模板大包也没问题"这类体验宣称，未在代码层逐条验证