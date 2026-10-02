# ComfyUI 能力调研：模型 / 模板 / API 现状

> 调研范围：本机三份 Comfy Desktop 安装的**静态文件** + 服务端源码。
> **调研时 ComfyUI 服务器未运行**（8188–8192 全部无监听，见 §0），因此本文中所有"实测"数据来自磁盘读取与源码阅读，**没有任何一次真实的 HTTP 调用**。凡是需要跑起来才能确认的，一律标注 `未确认`。

---

## 0. 前置事实（先看这个）

| 项 | 实测值 | 来源 |
|---|---|---|
| ComfyUI 版本 | `0.37.4`（`comfyui_version.py`；日志里上次启动是 `0.37.2`） | `ComfyUI/comfyui_version.py` |
| 前端包 | `comfyui-frontend-package 1.52.7` | `.venv\Lib\site-packages\*.dist-info`、启动日志 |
| 模板元包 | `comfyui-workflow-templates 0.11.69` | 同上 |
| 模板包 | `comfyui-workflow-templates-core 0.3.360`、`-json 0.1.95`、`-media_api 0.3.84`、`-media_image 0.3.160`、`-media_video 0.3.101`、`-media_other 0.3.229`、`-media_assets_01 0.1.48`、`-media_assets_02 0.1.5` | 同上 |
| Manager | `comfyui_manager 4.2.2` | 同上 |
| Python / Torch | 3.13.12 / 2.12.1+cu130 | 启动日志 |
| GPU | RTX 5070 Ti Laptop，12227 MB VRAM | 启动日志 |
| 三份安装的 web root | 都指向各自的 `.venv\Lib\site-packages\comfyui_frontend_package\static` | 启动日志 |

**端口**：`Get-NetTCPConnection` 显示 8188/8189/8190/8191/8192 全部未监听。**三份安装的历史日志都写着 `To see the GUI go to: http://127.0.0.1:8188`** —— 它们共用同一个端口，靠"同一时刻只跑一个"来区分。这是后面 §7 里最大的坑。

三份安装目录（都在 `C:\Users\18002\AppData\Local\Comfy-Desktop\ComfyUI-Installs\`）：
`Z-image` / `MiniMax H3` / `Qwen-Image-2.1`，三者代码树完全一致（同为 ComfyUI 0.37.x），差异只在 `models/`、`user/`、`extra_model_paths.yaml`。

---

## 1. 用户核心诉求：「ComfyUI 自带的模板到底在哪」

结论先说：**模板在磁盘上，不在前端 JS 代码里**。而且是**两套完全不同的东西**，格式都是 **frontend graph 格式（version 0.4），不是 API 格式**，都不能直接 POST 给 `/prompt`。

### 1.1 系统 A —— Core Blueprints（子图蓝图）

- 位置：`<安装>\ComfyUI\blueprints\*.json`
- 数量：**116 个**，总体积 **5,546,086 字节（约 5.5 MB）**，平均约 47 KB/个
- 另有 `blueprints\.glsl\`（GLSL shader 源码，供 Image Tools 类蓝图使用）和一个占位文件 `put_blueprints_here`
- **分类方式**：`definitions.subgraphs[0].category`，形如 `"大类/子类"`。实测分布：

  ```
  18x  Image generation/Text to image        11x  Image editing/Edit image
  10x  Image Tools/Color adjust               7x  Video generation/Conditioned
   6x  Preprocessors/Depth                    6x  Audio/Music generation
   6x  Image generation/Conditioned           5x  Video generation/Image to video
   4x  Video Tools                            4x  Video editing/Video Edit
   3x  Image Tools/Crop                       3x  Preprocessors/Pose
   3x  Video generation/FLF2V                 3x  Video generation/Text to video
   ... （共 34 个不同的 category 值，见下表）
  ```

  大类只有 6 种：`Image generation`、`Image editing`、`Image Tools`、`Video generation`、`Video editing`、`Video Tools`、`Preprocessors`、`Audio`、`Text Tools`、`3D`。

- 每个蓝图同时带 `definitions.subgraphs[0].description`（英文一句话说明）。

**蓝图里到底有什么（这是最有价值的部分）。**以 `Text to Image (Qwen-Image).json` 为例：

```
cat:    Image generation/Text to image
inputs: text[STRING], width[INT], height[INT], seed[INT],
        unet_name[COMBO], clip_name[COMBO], vae_name[COMBO],
        lora_name[COMBO], value[BOOLEAN]
models: VAELoader        -> vae/qwen_image_vae.safetensors
        CLIPLoader       -> text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors
        UNETLoader       -> diffusion_models/qwen_image_fp8_e4m3fn.safetensors
        LoraLoaderModelOnly -> loras/Qwen-Image-Lightning-8steps-V1.0.safetensors
```

三个可直接利用的字段：

1. **`definitions.subgraphs[0].inputs[]`** —— 这就是"这个模板需要哪些参数"的答案。每项有 `name` / `type`（`STRING` / `INT` / `FLOAT` / `BOOLEAN` / `COMBO`）/`label`。
2. **每个内部节点的 `properties.models[]`** —— 每项有 `name` / `directory`（= `/models/{folder}` 的 folder 名）/ `url`（HuggingFace 下载地址）。**这就是模板的模型清单**，可以直接拿去和 `/models/{folder}` 求交集，算出"本机跑不跑得动"。
3. **`nodes[0].properties.proxyWidgets`** —— 顶层只有一个节点，`type` 是个 UUID（子图 id），它把暴露出去的参数映射回内部节点的 widget。例如 Z-Image-Turbo 蓝图里 `[["27","text"],["13","width"],["3","seed"],["28","unet_name"],...]`。

**服务端暴露**：`app\subgraph_manager.py:123`

```python
@routes.get("/global_subgraphs")        # → /api/global_subgraphs
@routes.get("/global_subgraphs/{id}")   # → /api/global_subgraphs/{id}
```

- `/global_subgraphs` 返回 `{ sha256id: {source, name, info:{node_pack}} }`（`data` 和 `path` 被剥掉）。`source` 为 `templates`（blueprints 目录）或 `custom_node`（`custom_nodes/*/subgraphs/*.json`）。id = `sha256(source + 绝对路径)`。
- `/global_subgraphs/{id}` 返回同一个对象，但 `data` 字段是**整个蓝图 JSON 的原文**（`app\subgraph_manager.py:55`）。
- 也就是说：**服务端确实有"列全部蓝图"的端点，只是要自己按 sha256 取内容。**没有一次调用就能拿到 `{id, name, category, inputs}` 的端点。

### 1.2 系统 B —— Workflow Templates（工作流模板）

- 位置：分散在 6 个 pip 包里，统一在各自的 `templates/` 子目录：

  | 包 | 版本 |
  |---|---|
  | `comfyui_workflow_templates_media_api` | 0.3.84 |
  | `comfyui_workflow_templates_media_image` | 0.3.160 |
  | `comfyui_workflow_templates_media_video` | 0.3.101 |
  | `comfyui_workflow_templates_media_other` | 0.3.229 |
  | `comfyui_workflow_templates_media_assets_01` | 0.1.48 |
  | `comfyui_workflow_templates_media_assets_02` | 0.1.5 |
  | `comfyui_workflow_templates_json` | 0.1.95（**所有 .json 图都在这里**，含 index 系列） |

- 机器可读的注册表：`.venv\Lib\site-packages\comfyui_workflow_templates_core\manifest.json`，**358,720 字节**，含 **588 个 template 条目**，结构为
  `{id, bundle, version, assets:[{filename, sha256}], cdn:{path}}`。**没有 category/description**。
- 人类/UI 目录：`comfyui_workflow_templates_json\templates\index.json`（**717,293 字节**，11 个 module 分组，572 个模板）。分组实测：

  ```
  module=default  category=Foundation  title=Image          type=image  n=187
  module=default  category=Foundation  title=Image Tools    type=image  n=45
  module=default  category=Foundation  title=Video          type=video  n=185
  module=default  category=Foundation  title=Video Tools    type=video  n=25
  module=default  category=Foundation  title=Audio          type=audio  n=31
  module=default  category=Foundation  title=3D Model       type=3d     n=43
  module=default  category=Foundation  title=LLM            type=llm    n=20
  module=default  category=Foundation  title=Node Basics    type=image  n=5
  module=default  category=Applied    title=Product & Ads    type=image  n=11
  module=default  category=Applied    title=Character&Fashion type=image n=12
  module=default  category=Applied    title=Brand & Design   type=image  n=8
  ```

- **★ 系统 C —— 专门给 agent 用的目录：`index.mcp.json`**

  这是本次调研最重要的发现。`comfyui_workflow_templates_json\templates\index.mcp.json`，**531,723 字节**，9 个分类，533 个模板条目。相比 `index.json` 它把字段重排成了 agent 友好的形式：

  ```json
  {
    "category": "Image",
    "description": "General-purpose workflow templates for native image generation, ...",
    "templates": [{
      "name": "image_z_image_turbo",
      "title": "Z-Image-Turbo: Text to Image",
      "task": "Text to Image",
      "model": "Z-Image-Turbo",
      "freshness": "established",
      "usage": 14647,
      "recommend": "highly_recommended",
      "description": "Generate an image from a text prompt using the fast Z-Image-Turbo model, ... Input is a text prompt; output is the generated image.",
      "io": {
        "inputs":  ["text: Text prompt describing the desired image in English or Chinese"],
        "outputs": ["image: Generated image from text prompt"]
      },
      "minComfyUIVersion": "0.11.0",
      "capabilities": {"workflow": ["text-to-image"]}
    }]
  }
  ```

  9 个分类实测：`Image[177]`、`Video[185]`、`Image Tools[44]`、`Video Tools[25]`、`Audio[28]`、`3D Model[43]`、`Product & Ads[11]`、`Character & Fashion[12]`、`Brand & Design[8]`。

  `io.inputs` 是**自然语言描述的输入清单**（不是 widget 名），`capabilities.workflow` 是可过滤的任务标签。这正是"让 agent 知道这个模板能干什么、要给什么"所需的最后一层抽象。

- 分类维度汇总：`index.schema.json`（9,664 字节，JSON Schema draft-07）定义了字段语义，包括 `status: active|archived|deprecated`、`requiresCustomNodes[]`、`models[]`、`openSource`、`minComfyUIVersion`、`searchRank` 等。**这个 schema 本身可以直接给 LLM 当检索契约用。**

**服务端暴露**：`server.py:1249-1273`

```python
if use_legacy_templates:                      # 模板版本 < 0.3.0
    web.static('/templates', workflow_templates_path)
else:                                          # 本机 0.11.69 → 走这里
    self.app.router.add_get("/templates/{path:.*}", handler)
```

本机 `comfyui-workflow-templates 0.11.69 ≥ 0.3.0`，所以走后者：`app\frontend_management.py:438` 的 `template_asset_handler()` 用 `template_asset_map()`（一份 `{扁平文件名 → 绝对路径}` 字典）做查表。

**关键推论**：因为查表键是**扁平文件名**（不是相对路径），所以

```
GET /templates/index.mcp.json          ✅ 可用（它被登记为 manifest 的一个 asset）
GET /templates/index.json              ✅
GET /templates/image_z_image_turbo.json ✅
GET /templates/image_z_image_turbo-1.webp ✅（缩略图也在同一 map 里）
GET /templates/media-image/image_z_image_turbo.json  ❌ 404（不是 key）
```

这意味着**整个模板目录是可以纯 HTTP 拉取的，不需要读磁盘**。这比现在插件"读本地 `workflows/*.api.json`"更通用（换台机器不用改代码）。

### 1.3 格式问题（最大的技术障碍）

实测 4 个模板文件，全部是 **frontend graph 格式 version 0.4**：

```
image_z_image_turbo.json      keys=id,revision,last_node_id,last_link_id,nodes,links,groups,definitions,config,extra,version  nodes=3
image_flux2_text_to_image.json 同上                                                                          nodes=3
image_qwen_image_2_1_t2i.json  同上                                                                          nodes=5
api_bfl_flux_pro_t2i.json      keys=id,revision,...,nodes,links,groups,config,extra,version（无 definitions）          nodes=6
```

- **没有 `class_type`**（那是 API 格式的字段）。
- `nodes[].type` 是 `SaveImage` / `MarkdownNote` / `LoadImage` 这类，**或者是一个 UUID**（子图引用，如 `f2fdebf6-dfaf-43b6-9eb2-7f70613cfdc1`）。绝大多数现代模板是后者：`nodes` 只有 3–5 个，真正的图在 `definitions.subgraphs[0].nodes` 里。
- `api_*` 前缀的那批用的是原生节点（`FluxProUltraImageNode` 等 Partner Nodes），不套子图，但**仍是 frontend 格式**，且需要 API key。

**服务端不认这种格式。**`execution.py:1128 validate_prompt` 要求每个节点都有 `class_type`：

```python
for x in prompt:
    if 'class_type' not in prompt[x]:
        error = {"type": "missing_node_type", "message": f"Node ... has no class_type. ..."}
        return (False, error, [], {})
    class_type = prompt[x]['class_type']
    class_ = nodes.NODE_CLASS_MAPPINGS.get(class_type, None)
    if class_ is None:
        error = {"type": "missing_node_type", "message": f"Node ... not found. The custom node may not be installed."}
```

我在整个 ComfyUI 源码里 grep 过 `class Subgraph` / `graph_to_api` / `to_api_format`，**零命中**。`NODE_CLASS_MAPPINGS` 里也不存在 `Subgraph`。

**结论：frontend graph → API graph 的展开是在浏览器里做的（`comfyui_frontend_package/static/assets/*.js` 里），服务端没有对应实现。** 官方 openapi.yaml 里也没有"上传 workflow 文件并转换"的端点。

这直接决定了两条可行路线（详见 §6）：

- **路线 1（推荐）：自己做 graph→API 转换器**。因为绝大多数模板是单层子图，展开规则很机械：把 `definitions.subgraphs[0]` 里的 `nodes` 提升到顶层、把 `links` 变成 `[nodeId, outputSlot]` 引用、把 `widgets_values` 按 `input_order` 顺序填进 `inputs`、用 `proxyWidgets` 把暴露参数覆盖到对应内部节点。这是纯本地计算，一次性写好能覆盖绝大部分模板。
- **路线 2：一次性用浏览器导出 API 格式**。前端可以"Save (API Format)"，产物是 `{node_id: {class_type, inputs}}`。可以在装机时跑一次脚本生成缓存，之后 agent 直接用。但无法覆盖用户后续新增的模板。

`未确认`：`api_*` 系列是否真的需要付费 API key（Partner Nodes 一般需要登录 Comfy 账号），本次未验证。

---

## 2. 模型现状

### 2.1 本机各安装自带的模型

**只有 `MiniMax H3` 这一份在自己的 `models/` 里放了东西**：

```
MiniMax H3\ComfyUI\models\diffusion_models\z_image_turbo_bf16.safetensors
MiniMax H3\ComfyUI\models\text_encoders\qwen_3_4b.safetensors
MiniMax H3\ComfyUI\models\vae\ae.safetensors
```

`Z-image` 和 `Qwen-Image-2.1` 的 `models/` 下**全部是 `put_*_here` 占位文件，一个真模型都没有**。

这很反直觉——因为**三份安装通过 `extra_model_paths.yaml` 共享一个模型仓库**：

### 2.2 共享模型仓库（真正生效的那些）

`C:\Users\18002\AppData\Local\Comfy-Desktop\ComfyUI-Shared\models\`

```
diffusion_models/  minimax_h3_fl2va_pruned_int8_convrot.safetensors
                   minimax_h3_ref2va_pruned_int8_convrot.safetensors
                   qwen_image_2.1_int8_convrot.safetensors
                   z_image_turbo_bf16.safetensors
text_encoders/     qwen_3_4b.safetensors
                   qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
                   qwen3vl_8b_int8_convrot.safetensors
vae/               ae.safetensors
                   minimax_h3_audio_vae_fp32.safetensors
                   minimax_h3_video_vae_fp16.safetensors
                   minimax_h3_video_vae_int8_convrot.safetensors
                   qwen_image_2.1_vae_bf16.safetensors
loras/             minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
                   minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors
.cache/            （HF 下载缓存，含一个 `.incomplete` 半成品文件）
```

**坑：`extra_model_paths.yaml` 只存在于 `Qwen-Image-2.1` 安装下，`Z-image` 和 `MiniMax H3` 没有这个文件。**（`extra_model_paths.yaml.example` 三份都有。）这意味着三份安装的可搜索路径并不一致——**具体哪份能看到共享模型，我只能从文件存在性推断，无法在没启动的情况下确认（`未确认`）**。启动日志里也没有 "Adding extra search path" 相关行。

### 2.3 `/models/{folder}` 的合法 folder 名

`server.py:342-354`：

```python
@routes.get("/models")
def list_model_types(request):
    return web.json_response(list(folder_paths.folder_names_and_paths.keys()))

@routes.get("/models/{folder}")
async def get_models(request):
    folder = request.match_info.get("folder", None)
    if folder not in folder_paths.folder_names_and_paths:
        return web.Response(status=404)          # 无 body
    files = folder_paths.get_filename_list(folder)
    return web.json_response(files)               # 扁平字符串数组
```

**实测合法 folder 名（用该安装自带的 venv 跑 `folder_paths` 得到，27 个）：**

```
audio_encoders, background_removal, checkpoints, classifiers, clip_vision,
configs, controlnet, custom_nodes, datasets, detection, diffusers,
diffusion_models, embeddings, frame_interpolation, geometry_estimation,
gligen, hypernetworks, latent_upscale_models, loras, model_patches,
optical_flow, photomaker, style_models, text_encoders, upscale_models,
vae, vae_approx
```

**注意：磁盘上有 `models/unet/` 和 `models/clip/` 目录，但它们不在这个列表里** → `GET /models/unet` 和 `GET /models/clip` 返回 **404**。它们是 ComfyUI 早期遗留的目录，现在 `UNETLoader` 读的是 `diffusion_models`、`CLIPLoader` 读的是 `text_encoders`：

```python
# nodes.py:983 UNETLoader
"unet_name": (folder_paths.get_filename_list("diffusion_models"), )
unet_path = folder_paths.get_full_path_or_raise("diffusion_models", unet_name)

# nodes.py:1008 CLIPLoader
"clip_name": (folder_paths.get_filename_list("text_encoders"), )

# nodes.py:771 VAELoader —— 注意特殊逻辑
vae_list() 读 "vae" + "vae_approx"（只有带完整 encoder./decoder. 配对的 TAESD 才并入）
```

**`/models` 还有个副作用要注意**：`custom_nodes` 和 `datasets` 也在里面，把它们当模型目录去遍历会拿到噪音。

**响应格式非常朴素**：就是一个 `["a.safetensors", "sub/b.safetensors"]` 这样的字符串数组，**没有大小、没有类型、没有路径区分**。要拿文件大小只能自己 stat 磁盘。

### 2.4 `GET /embeddings`

```python
# server.py:337
@routes.get("/embeddings")
def get_embeddings(request):
    embeddings = folder_paths.get_filename_list("embeddings")
    return web.json_response(list(map(lambda a: os.path.splitext(a)[0], embeddings)))
```

返回 `["easynegative", "badhandv4"]` 这种**去掉了扩展名**的字符串数组。本机 `models/embeddings/` 只有占位文件，所以实际返回 `[]`。

---

## 3. 路由清单（本机 `server.py` 实际注册的全部）

`server.py:1223-1244` 的关键机制：**所有非静态路由会自动复制一份挂到 `/api` 前缀下**。

```python
api_routes = web.RouteTableDef()
for route in self.routes:
    if isinstance(route, web.RouteDef):
        api_routes.route(route.method, "/api" + route.path)(route.handler, **route.kwargs)
self.app.add_routes(api_routes)
self.app.add_routes(self.routes)
```

所以 `/object_info` 和 `/api/object_info` **同时有效**，且注释写明"目前新旧两种端点都支持"。**但静态路由（`web.static`）不加前缀** —— `/templates/...`、`/api/workflow_templates/<module>/...` 走的是 `webapp.add_routes`，不受这个循环影响。

### 3.1 完整表（`server.py` 内 `@routes.*`，行号来自 Z-image 安装）

| 方法 | 路径 | 行号 | 响应 |
|---|---|---|---|
| GET | `/ws` | 269 | WebSocket（进度/执行事件） |
| GET | `/` | 329 | 前端 `index.html` |
| GET | `/embeddings` | 337 | `string[]`（去扩展名） |
| GET | `/models` | 342 | `string[]`（27 个 folder 名） |
| GET | `/models/{folder}` | 348 | `string[]`；未知 folder → **404 无 body** |
| GET | `/extensions` | 356 | `string[]`，前端 JS 的 URL |
| POST | `/upload/image` | 464 | multipart，`overwrite=true` / `subfolder` / `type` |
| POST | `/upload/mask` | 470 | 同上 |
| GET | `/view` | 516 | 二进制。见 §3.5 |
| GET | `/view_metadata/{folder_name}` | 666 | 输出文件的元数据 |
| GET | `/system_stats` | 689 | 见 §3.6 |
| GET | `/features` | 742 | feature flag 协商 |
| GET | `/prompt` | 750 | 队列信息（**GET 不是 POST**） |
| GET | `/object_info` | 803 | 全量节点 schema |
| GET | `/object_info/{node_class}` | 816 | 单节点 schema |
| GET | `/api/jobs` | 824 | 作业列表，支持过滤/排序/分页 |
| GET | `/api/jobs/{job_id}` | 922 | 单作业 |
| POST | `/api/jobs/{job_id}/cancel` | 974 | |
| POST | `/api/jobs/cancel` | 992 | 批量取消 |
| GET | `/history` | 1048 | 支持 `max_items` / `offset` |
| GET | `/history/{prompt_id}` | 1062 | |
| GET | `/queue` | 1067 | `{queue_running, queue_pending}` |
| POST | `/prompt` | 1075 | 入队 |
| POST | `/queue` | 1149 | `{clear, delete}` |
| POST | `/interrupt` | 1163 | |
| POST | `/free` | 1195 | `{unload_models, free_memory}` |
| POST | `/history` | 1206 | `{clear, delete}` |

`app/custom_node_manager.py` 额外注册：

| 方法 | 路径 | 行号 |
|---|---|---|
| GET | `/workflow_templates` | 96 |
| GET | `/i18n` | 140 |
| 静态 | `/api/workflow_templates/{module_name}` | 132-138 |

`app/subgraph_manager.py` 额外注册：

| 方法 | 路径 | 行号 |
|---|---|---|
| GET | `/global_subgraphs` | 123 |
| GET | `/global_subgraphs/{id}` | 128 |

### 3.2 `GET /object_info`

结构（`server.py:754-801` 的 `node_info()`）：一个 `{节点类名: {...}}` 的字典，每个节点的字段：

```json
{
  "input":        { "required": {...}, "optional": {...} },   // 来自 INPUT_TYPES()
  "input_order":  { "required": [...], "optional": [...] },
  "is_input_list": false,
  "output":       ["MODEL"],
  "output_is_list": [false],
  "output_name":  ["MODEL"],
  "name":         <类对象>,
  "display_name": "UNETLoader",
  "description":  "",
  "python_module": "nodes",
  "category":     "model/loaders",
  "output_node":  false,
  "has_intermediate_output": false,
  "deprecated":   false,        // 条件字段
  "experimental": true,         // 条件字段
  "dev_only":     true,         // 条件字段
  "api_node":     true,         // 条件字段
  "search_aliases": [],
  "essentials_category": "..."  // 条件字段
}
```

- **"按类别查节点"服务端不支持。** 只能 `GET /object_info/{node_class}` 查单个类（未知类名返回 `{}`，不是 404）。要按类别查，只能先拉全量再本地过滤 `category` 字段。
- `/object_info` 内部对每个节点 `try/except` 包裹（`server.py:809-813`），**单个节点炸了不会导致整体 500**，只是那个 key 缺失。
- 调用前会 `self.asset_manager.ensure_scan_started()`，首次调用可能触发模型扫描。

### 3.3 `POST /prompt`

```python
# server.py:1075
json_data = await request.json()
...
if "prompt" in json_data:
    prompt = json_data["prompt"]                       # API 格式图
    prompt_id = json_data.get("prompt_id") or str(uuid.uuid4())
    extra_data = json_data.get("extra_data", {})
    if "client_id" in json_data:
        extra_data["client_id"] = json_data["client_id"]
```

- 请求：`{"prompt": {node_id: {class_type, inputs}}, "client_id"?, "extra_data"?, "prompt_id"?, "partial_execution_targets"?}`
- `prompt_id` 可选；**如果传了必须是规范小写带连字符的 UUID**，否则 400 + `{"type": "invalid_prompt_id"}`（新加的校验）。
- 成功响应：`{"prompt_id": ..., "number": ..., "node_errors": {}}`
- 失败响应（400）：`{"error": {"type","message","details","extra_info"}, "node_errors": {...}}`
- 也接受 header `Comfy-Usage-Source`。
- **注意 `node_errors` 即使成功也一定存在**，客户端应默认处理。

### 3.4 `GET /history` / `GET /queue`

```python
# server.py:1067
queue_info['queue_running'] = _remove_sensitive_from_queue(current_queue[0])
queue_info['queue_pending'] = _remove_sensitive_from_queue(current_queue[1])
```

`/history` 响应结构（从 `comfy_client.py:112-116` 现有用法反推，本插件已在用）：

```json
{ "<prompt_id>": {
    "status": {...},
    "outputs": { "<node_id>": { "images": [{"filename","subfolder","type"}, ...] } }
} }
```

`GET /history/{prompt_id}` 不存在时返回 `{}`（现有代码靠 `if history and prompt_id in history` 判空，是对的）。

### 3.5 `GET /view`

```python
# server.py:516
if "filename" in request.rel_url.query:
    filename = request.rel_url.query["filename"]
    if filename.startswith("blake3:"):        # 新：前端 LoadImage combo 用 blake3 hash 当值
        result = resolve_hash_to_path(filename)
        ...
    else:
        filename, output_dir = folder_paths.annotated_filepath(filename)
        if not filename: return 400
        if filename[0] == '/' or '..' in filename: return 400
        output_dir = folder_paths.get_directory_by_type(request.rel_url.query.get("type", "output"))
```

参数：`filename`（必需）、`type`（`output`/`input`/`temp`，默认 `output`）、`subfolder`（有 `os.path.commonpath` 逃逸检查，违规返回 403）。
支持 `"name [output]"` 这种带类型标注的写法（`annotated_filepath`）。

### 3.6 `GET /system_stats` —— 识别"哪个安装"的唯一手段

```python
system_stats = {
  "system": { "os", "ram_total", "ram_free", "comfyui_version",
              "required_frontend_version", "installed_templates_version",
              "required_templates_version", "comfy_package_versions",
              "python_version", "pytorch_version", "embedded_python",
              "deploy_environment", "argv" },        # ← argv 是关键
  "devices": [ { "name", "type", "index",
                 "vram_total", "vram_free",
                 "torch_vram_total", "torch_vram_free" } ]
}
```

`system.argv` 包含 ComfyUI 的启动路径和 `--port`。**这是唯一能把"8188 上跑的是哪一份安装"区分出来的手段。**

### 3.7 openapi.yaml 里声明但源码中找不到的

`openapi.yaml` 有 234,654 字节，只覆盖新的 `/api/*` v0.0.x Comfy API（assets / jobs / users / settings / tasks 等），**不覆盖上面那张老路由表**。它额外声明了这些：

- `/health` —— 我 grep 全仓库，**没有任何 `.py` 注册这个路由**（只在 `comfy_api_nodes/util/_helpers.py:116` 作为**外部** Partner Node 的健康检查 URL 被拼接）。`未确认`是否可用。
- `/api/i18n`、`/api/tags`、`/api/user`、`/api/users`、`/api/userdata/...`、`/api/workflows/...`、`/api/tasks/...`、`/internal/logs` 等 —— 多数来自已安装的模块或 openapi 声明，**本次未逐一验证**。
- `/internal/folder_paths`（`api_server/routes/internal/internal_routes.py:47`）：返回 `{folder名: 第一个搜索路径}`。文件头明确写了 *"The endpoints here should NOT be depended upon. It is for ComfyUI frontend use only."* —— 可以用来诊断，但别在生产依赖。

### 3.8 官方文档：用户给的两个 URL 都 404 了

- `https://docs.comfy.org/development/core-concepts/server_overview` → **404**
- `https://docs.comfy.org/development/comfyui-server.com/route_overview` → **404**
- 试了 `comfyui-server-com/route_overview`（单数复数纠正）→ 仍然 **404**

所以本文的 API 部分**全部以本机源码为准**，没有引用官方文档。官方文档站本身能打开（[docs.comfy.org](https://docs.comfy.org/)），但这两个具体页面已下线或改路径了。**没有找到替代页面，不编造链接。**

---

## 4. 自定义节点

**三份安装的 `custom_nodes/` 基本是空的**：

```
Z-image\ComfyUI\custom_nodes\:
  __pycache__\
  example_node.py.example      ← 示例，不是真节点
  websocket_image_save.py      ← ComfyUI 自带
```

ComfyUI-Manager 已装（4.2.2），它在 `user\__manager\cache\` 下有缓存：

| 文件 | 大小 | 内容 |
|---|---|---|
| `881334633_nodes.json` | **11,363,562 字节（11.4 MB）** | 5451 个**远端**节点（来自 Comfy Registry，非本机已装） |
| `4245046894_model-list.json` | 330,077 字节 | 564 个可下载模型条目 |
| `1742899825_extension-node-map.json` / `1514988643_custom-node-list.json` / `2259715867_alter-list.json` / `746607195_github-stats.json` | — | Manager 索引 |

**这 11.4 MB 是"什么不该进 LLM 上下文"的最好量化参照**（见 §5.4）。注意它是**远端注册表**，跟 `/object_info` 不是一回事。

---

## 5. 可落地的发现方案

### 5.1 枚举服务器上"所有可用模型"

**不要去遍历 27 个 folder。** `GET /models` 返回 27 个名字，然后逐个 `GET /models/{folder}` —— 26 次 HTTP 往返，其中 24 次会拿到空数组或 `put_*_here` 占位文件。

更好的做法是**反向枚举**：从你要跑的模板出发。

```
模板 blueprints/*.json 或 templates/*.json
  → 提取每个节点的 properties.models[]  →  {directory, name}
  → 批量 GET /models/{directory}（同一个 directory 只查一次）
  → 求交集 → 得出"这个模板本机跑得动 / 缺哪些模型"
  → 缺失的 models[].url 就是 HuggingFace 直链
```

这样一次模板查询就产出：**模型齐不齐 / 缺什么 / 去哪下**。而且正好复用了模板里已经写好的清单，不用自己猜。

如果确实需要全量清单（给用户看"这台机器上有什么"），建议：

```js
const folders = await get('/models');                    // 1 次
const wanted  = ['diffusion_models','text_encoders','vae','loras','checkpoints',
                 'controlnet','upscale_models','clip_vision','style_models',
                 'embeddings','audio_encoders','photomaker'];
const picked  = folders.filter(f => wanted.includes(f));  // 排除 custom_nodes/datasets/configs
const lists   = await Promise.all(picked.map(f => get(`/models/${f}`)));
```

要点：
- **过滤掉占位文件。** `put_diffusion_model_files_here`、`put_checkpoints_here` 这类以 `put_` 开头、以 `_here` 结尾的文件名在每个空目录里都有一份，会混进模型列表。**实测确认**：`Z-image` 的 `models/` 下 25 个目录全部只有占位文件。
- **`configs` 不要遍历**：里面是 11 个 `*.yaml`（SD1/SD2 推理配置），不是模型文件。
- **`classifiers` 和 `datasets` 在 `folder_names_and_paths` 里但磁盘上没有对应目录**，会返回空。
- 想连大小一起拿，只能自己 stat（`/models/{folder}` 不返回大小）。

### 5.2 枚举"所有可用工作流模板"

**结论：读磁盘还是问服务器？两条路都可行，但用途不同。**

| 来源 | 能拿到 | 拿不到 | 适合 |
|---|---|---|---|
| `GET /templates/index.mcp.json` | 533 个模板的 category/title/task/model/description/io/capabilities/recommend/usage | 模板本体 | **喂给 LLM 做检索**（首选） |
| `GET /templates/index.json` | 572 个模板，多了 `tags`/`openSource`/`minComfyUIVersion`/`thumbnail`/`size`/`requiresCustomNodes`/`status` | 模板本体 | 精细过滤 + schema 校验 |
| `GET /templates/<name>.json` | 模板本体（frontend graph） | 人类可读描述 | 真正要跑的时候 |
| `GET /api/global_subgraphs` | 116 个蓝图的 `{id, source, name}`（**无 category**） | 分类、参数 | 只要 id 列表时最省事 |
| `GET /api/global_subgraphs/{id}` | 蓝图本体 | 同上 | 同上 |
| 直接读磁盘 `comfyui_workflow_templates_json/templates/` | 全部 | — | 离线、需要索引全部元数据时 |

**注意 533 / 572 / 588 三个数字不一样**：`index.mcp.json` 533、`index.json` 572、`manifest.json` 588。manifest 是最全的（包含缩略图 webp 等所有 asset）。做目录展示用 `index.mcp.json`，做完整性检查用 `manifest.json`。

**强烈建议的流水线**：

```
启动时（一次性，缓存到磁盘）：
  GET /templates/index.mcp.json  →  531 KB
  ↓ 本地过滤：category ∈ 用户要的 + status != deprecated
  ↓ 按 model / capabilities.workflow 建倒排索引
  ↓ 只把"精简后的候选列表"给 LLM

用户选定某个模板后：
  GET /templates/<name>.json
  ↓ graph → API 转换（§1.3 的路线 1）
  ↓ 按 subgraph.inputs 生成参数契约
  ↓ 用 properties.models[] 校验模型齐不齐
  POST /prompt
```

### 5.3 让 agent 知道某个模板需要哪些参数

这是整个方案的难点，因为**三种模板形态的参数来源完全不同**。

#### 形态 1：子图蓝图（116 个蓝图，以及 `image_*` / `video_*` / `audio_*` / `3d_*` 大部分模板）

参数契约可以**直接从 JSON 里读出来**，不用猜：

```
definitions.subgraphs[0].inputs[]
  → { name, type, label, linkIds }
```

配合顶层的 `nodes[0].properties.proxyWidgets`（`[["27","text"], ["13","width"], ...]`，第一项是内部 node id，第二项是 widget 名），能得到"外部参数 → 内部节点 widget"的精确映射。

**可直接提取的默认值**：蓝图里 `nodes[].widgets_values` 就是该节点所有 widget 的值。例如 `KSampler` 的 `[0, "randomize", 8, 1, "res_multistep", "simple", 1]` 依次对应 `seed / control_after_generate / steps / cfg / sampler_name / scheduler / denoise`。`UNETLoader` 是 `["z_image_turbo_bf16.safetensors", "default"]` = `unet_name / weight_dtype`。**这些默认值是官方调好的，直接拿来当默认参数比自己拍一套强得多。**

文本类型的默认值要注意：`CLIPTextEncode.widgets_values = [""]`，`LoadImage` 之类是 `["image_x_image_turbo.png", ...]` —— 前者空串要由用户提供，后者是示例文件名。

#### 形态 2：原生节点模板（`api_*` 那批）

没有 `definitions`，参数要从每个节点的 `inputs[]`（带 `widget: {name}`）和 `widgets_values` 里推。可以复用现有的 `requiredParameters()` / `renderWorkflow()`（`lib/workflows.js:110-207`）思路，只是要改成"先扫 graph 建契约、再渲染"，而不是"扫 `{{占位符}}`"。

#### 形态 3：`MarkdownNote` / `SaveImage` 等辅助节点

`image_z_image_turbo.json` 里 3 个节点是 `MarkdownNote` + `SaveImage` + 子图。`SaveImage` 提供 `filename_prefix`（默认 `["image_z_image_turbo"]`）。`MarkdownNote` 只是说明文字，转换时直接丢掉。

#### 补充：`object_info` 的正确用法

转换出 API graph 之后，用 `GET /object_info/{class_type}` **逐节点**校验，比拉全量好得多：

- 拿到该节点的合法 `class_type`（graph→API 转换错类型时立刻能发现）
- 拿到 combo 字段的**合法取值列表**（`input.required.unet_name[0]` 就是模型名数组）—— 这可以做交叉验证：转换后的 `unet_name` 必须在这个数组里
- 拿到 `steps` / `width` 的 min/max（`[name, {min, max, step}]` 形式）
- 拿到 `input_order`，用来把 `widgets_values` 按正确顺序填进 `inputs`

**这个"逐节点查"模式是控制上下文体积的关键**（见 §5.5）。

### 5.4 什么太大、不该进 LLM 上下文

| 数据 | 实测体积 | 处置 |
|---|---|---|
| `GET /object_info`（全量） | **未实测。** 但本机约 347 个节点类（静态统计 `nodes.py` 65 个 class + `comfy_extras` 142 个文件 + `comfy_api_nodes` 94 个文件），每个含完整 input/output schema 和 combo 数组 → 估计**数百 KB 到数 MB**，肯定超预算 | ❌ 绝不入上下文 |
| `GET /templates/index.mcp.json` | **531,723 字节** | ⚠️ 过滤后入 |
| `GET /templates/index.json` | **717,293 字节** | ⚠️ 过滤后入 |
| `comfyui_workflow_templates_core/manifest.json` | **358,720 字节** | ❌ 只在需要 asset 清单时读 |
| `GET /templates/<name>.json` | 本机 `input/` 下三个实测 16.6 KB / 27.2 KB / 37.7 KB | ✅ 单个入，OK |
| `blueprints/*.json` | 116 个共 **5,546,086 字节**（平均 47 KB） | ✅ 单个入 |
| Manager `nodes.json` | **11,363,562 字节** | ❌ 永远别入 |
| Manager `model-list.json` | 330,077 字节 | ❌ 用模板里的 `properties.models[].url` 就够了 |
| 前端 bundle | `vendor-three.js` 5.8 MB、`vendor-other.js` 1.7 MB（+ `.map` 更大） | ❌ |

**具体的过滤/摘要手段**（按优先级）：

1. **不拉全量 `/object_info`。** 改成"先拿到 class_type 列表 → 逐个 `GET /object_info/{class_type}` → 只保留 `input.required` / `input_order` / `output_name` / `category`，丢掉 `python_module` / `name`（是个类对象，序列化后无意义）/ `description`（大量空串）"。而且**只在真正要填某个 widget 值时才查那一个节点**，不要预检全部。

2. **`index.mcp.json` 只入"筛后子集"。** 过滤维度（都现成）：`category`、`task`、`model`、`capabilities.workflow`、`recommend`、`freshness`。而且入上下文时**只留 5 个字段**：`name` / `title` / `task` / `description`（截断到 ~150 字）/ `io.inputs`。`usage` / `mediaSubtype` / `minComfyUIVersion` 这些对 agent 决策无帮助，去掉后体积能砍掉一大半。

3. **蓝图的 `inputs[]` 只留 `{name, type}`，`label` 可选。** 116 个蓝图全量展开后也就 116 × ~10 项，很小。

4. **模板本体进上下文前先做一次"瘦身"**：删 `nodes[].pos` / `size` / `flags` / `order` / `groups` / `extra.*` / `MarkdownNote` 节点。`pos`/`size` 是画布坐标，对执行毫无用处，116 个蓝图里这部分占了相当比例。

5. **让检索发生在代码里，不在上下文里。** 用 `capabilities.workflow` + `category` + `model` 做程序化过滤，只把 top-N（3~5 个）候选的 `description` 塞给 LLM 让它选。这一步能把 531 KB 降到几 KB。

6. **考虑给 skill 一个静态索引。** 533 个模板里绝大多数用户根本不会用到（Video 185 个、Audio 28 个、3D 43 个）。与其每次让 agent 检索，不如在 skill 文档里写死"常用模板速查表"，只在明确超出范围时才走完整索引。

### 5.5 建议的缓存与降级

- **缓存键**：`GET /system_stats` 的 `system.argv`（识别安装）+ `system.comfyui_version`（识别版本）。模板包版本变了（`/system_stats` 的 `installed_templates_version`）就重新拉索引。
- **索引落盘**：拉一次 `index.mcp.json` 存到 `cache/templates-index.json`，之后离线也能用。
- **降级路径**（按顺序尝试）：
  1. `GET /templates/<name>.json`（通用，本机 0.11.69 一定支持）
  2. 读磁盘 `<venv>/Lib/site-packages/comfyui_workflow_templates_json/templates/<name>.json`
  3. 读磁盘 `<ComfyUI>/blueprints/*.json`
  4. 现有的内置 `workflows/*.api.json`（永远保留，作为最后兜底）
- **版本兼容**：`server.py:1249` 明确有 legacy 分支（模板版本 < 0.3.0 走 `web.static('/templates', ...)`，此时 `/templates/index.mcp.json` 也能取到，但路径结构是 `media-image/xxx.json`）。**新插件建议只依赖 `index.mcp.json` 的扁平文件名取法，并在失败时给出可读错误**，不要静默切 legacy。

---

## 6. 两条实现路线

### 路线 1：自己做 graph → API 转换（推荐）

单层子图模板的展开规则是机械的，可以完全在插件侧实现：

```
输入: templates/image_z_image_turbo.json (frontend graph v0.4)
1. 若有 definitions.subgraphs[0]:
     取 subgraph.nodes 作为工作节点集
     取 subgraph.links 作为连线
2. 新 API 图 node_id 分配: 用 (原 node id, 深度) 去重或直接用原 id
3. 对每个节点:
     class_type = node.type  (若是 UUID 则已在第 1 步展开掉了)
     inputs = {}
     - 对每个 node.inputs[i] 且 link !== null:
       从 links 找 (link.id == node.inputs[i].link) 的 origin
       inputs[input.name] = [origin_id, origin_slot]
     - 对 node.inputs[i] 且 widget != null 且 link === null:
       inputs[input.name] = node.widgets_values[对应下标]
4. 若节点被 proxyWidgets 暴露, 用外部参数覆盖对应 widget 值
5. 追加 SaveImage 节点的 filename_prefix
```

风险：`widgets_values` 的下标与 `input_order` 的对应关系在某些节点上不是简单顺序（比如 `KSampler` 的 `control_after_generate` 是自动插入的）；重 reroute 节点、batch 节点（`OUTPUT_IS_LIST`）会让 slot 映射变复杂。

**建议：转换器做一次，然后用 116 个蓝图 + 533 个模板批量回归 —— 转换结果能通过 `POST /prompt` 的 `validate_prompt`（不真跑模型，只看是否 400）就算成功。** `/prompt` 的校验是纯 schema 检查，失败会立刻返回 `missing_node_type` 或参数错误，不会占 GPU。这条验证路径成本极低。

### 路线 2：预导出 API 格式缓存

利用前端"Save (API Format)"，或者直接写一个一次性脚本：把选定的模板导出成 `{node_id: {class_type, inputs}}` 存到插件的 `workflows/`。**优点是零运行时风险，和现有 `lib/workflows.js` 的 `{{占位符}}` 机制完全兼容。缺点是覆盖范围固定**，新模板需要手动加。

**建议两条并行**：路线 2 覆盖已知可靠的（现在的 z-image-turbo / qwen-image-2.1 就该是这个形态），路线 1 兜底覆盖"用户现场指定的任意模板"。

---

## 7. 风险与坑

### 🔴 坑 1：三份安装抢同一个端口，且无法从端口号分辨

**实测**：三份安装的历史日志都打印 `To see the GUI go to: http://127.0.0.1:8188`。当前 `comfy_client.py:18` 把 `http://127.0.0.1:8188` 写死为 `DEFAULT_SERVER`。

后果：
- 用户开的是 Qwen 那份，插件却以为在 Z-image 上；`/models/diffusion_models` 返回的模型列表和实际能跑的模型对不上。
- 三份共享 `ComfyUI-Shared\models`，但 `extra_model_paths.yaml` **只有 Qwen 那份有**（见 §2.2），所以"能不能看到共享模型"本身就不一致。

**缓解**：
- 启动时先 `GET /system_stats`，读 `system.argv` 里的 ComfyUI 路径，和预期的安装目录比对；不匹配就在工具描述里明确告诉用户"当前 8188 上是 X 安装，你的模型在 Y 安装"。
- 允许 `--server` / 配置项覆盖，别写死。
- 端口探测顺序：`8188 → 8189 → 8190`，命中即用，并用 `/system_stats` 二次确认。

### 🔴 坑 2：模板是 frontend 格式，不能直接 POST

已在 §1.3 详述。服务端 `validate_prompt` 对没有 `class_type` 的节点直接 400。**这是本项目最大的技术债**，任何"通用化"方案绕不开。

### 🟠 坑 3：模板索引版本会变，字段是"内部约定"

- `index.mcp.json` 的 `task` / `recommend` / `freshness` / `capabilities` **没有 JSON Schema**（`index.schema.json` 只描述了 `index.json` 的字段）。
- `manifest.json` 里有 `version` 字段但全为 `"0.0.0"`（构建产物没填），**不能用它判断新旧**。
- 可用的版本信号只有 `/system_stats` 的 `system.installed_templates_version`（本机 `0.11.69`）。

**缓解**：字段缺失时容错（`?? []`），不要因为缺字段就崩。

### 🟠 坑 4：`.format` / 组合值与 `models/unet` 这类遗留目录

- `GET /models/unet`、`/models/clip` → **404**（不在 `folder_names_and_paths` 的 27 个 key 里）。硬编码这两个名字会静默失败。
- `models/configs/*.yaml` 是推理配置文件，不是模型。
- `VAELoader` 的 `vae_list()` 有特殊合并逻辑（`vae` + `vae_approx` 的配对判断），**`/models/vae_approx` 单独查出来的东西不等于 `/models/vae` 里的可用值**。

### 🟠 坑 5：`/models/{folder}` 的占位文件噪音

实测每个空目录都躺着 `put_diffusion_model_files_here`、`put_checkpoints_here` 等。**必须过滤**，否则 agent 会把 `put_text_encoder_files_here` 当成一个 text encoder 名字传给 `CLIPLoader`，报错信息还很难懂。

### 🟡 坑 6：Partner Nodes（`api_*` 模板）需要登录

`api_bfl_*` / `api_bytedance_*` / `api_openai_*` / `api_kling_*` / `api_elevenlabs_*` 等约 200 个模板用的是 Comfy Partner Nodes，**需要 Comfy 账号登录且很可能要付费额度**。`/system_stats` 之外没有端点能可靠判断"这些节点现在能不能用"。`api_node: true` 只说明它是 API 节点，不说明有额度。**建议默认把 `api_*` 模板从检索结果里过滤掉，或明确标注。**（具体是否需要 key —— `未确认`。）

### 🟡 坑 7：`/object_info` 全量的体积和稳定性

- 精确体积 `未确认`（服务器没跑）。但静态统计约 347 个节点类，实际注册数可能更多（`comfy_extras` 用 `NODE_CLASS_MAPPINGS.update()` 批量注册，我的 grep 精确度有限）。
- 首次调用会触发 `asset_manager.ensure_scan_started()`，**可能有额外延迟**。
- 有自定义节点后体积会线性增长。

### 🟡 坑 8：`/internal/*` 明确声明不要依赖

`api_server/routes/internal/internal_routes.py:10-12` 的 docstring：*"The endpoints here should NOT be depended upon. It is for ComfyUI frontend use only."* `/internal/folder_paths` 很好用（诊断多安装路径问题），但别写进生产路径。

### 🟡 坑 9：`/templates` 静态路由的版本分支

`server.py:1249-1262` 按 `comfyui-workflow-templates` 版本 `< 0.3.0` 还是 `>= 0.3.0` 走完全不同的实现。本机是 0.11.69，稳；将来若回退到 legacy，路径结构会变成带 bundle 前缀。别假设。

### 🟢 坑 10（已确认无害）：`/prompt` 的 GET 版本

`GET /prompt` 返回的是**队列信息**，不是 prompt 本体。命名容易误解。

---

## 8. 结论：值得做的 / 不值得做的

**值得**：
- 用 `GET /templates/index.mcp.json` 做检索入口 —— 533 个模板带 `task` / `capabilities` / `io` 自然语言描述，是现成的 agent 友好目录，比现在两个写死的 spec 好一个量级。
- 用蓝图的 `definitions.subgraphs[0].inputs[]` + `properties.models[]` + `widgets_values` 做参数契约和模型校验 —— 官方默认值直接可用。
- 用"模型清单反向求交"决定模板可用性 —— 一次查询同时回答"跑得动吗 / 缺什么 / 去哪下"。

**必须先解决的阻塞**：
- **frontend graph → API graph 的转换**。不做这个，所有模板都只是"看得见跑不了"。

**不建议**：
- 拉全量 `/object_info` 进上下文。
- 依赖 `/models/unet`、`/models/clip`、`/internal/*`。
- 把 `api_*` Partner Node 模板作为默认能力暴露。
- 写死 8188 和写死单个安装目录。

**明确未确认的**（需要真的起一次服务器才能补齐）：
1. `/object_info` 全量的实际字节数。
2. `/health` 是否真的存在（openapi 声明了，源码里没有）。
3. `/templates/index.mcp.json` 的实际 HTTP 响应（我是从 `template_asset_map` 的构建逻辑 + manifest 内容推断它可取，没发过请求）。
4. `Z-image` / `MiniMax H3` 这两份安装**没有** `extra_model_paths.yaml`，它们启动时到底能不能看到 `ComfyUI-Shared\models`。
5. `api_*` 模板的鉴权/额度实际要求。