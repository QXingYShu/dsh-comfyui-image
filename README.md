# dsh-comfyui-image

Generate image assets from **DeepSeek Harness** using a **local ComfyUI** install —
no API keys, no cloud, no per-image cost. The agent picks a model, writes the
prompt, queues the workflow on your own GPU, and gets back a real image file.

Two workflows ship wired up:

| Workflow | Good at | Speed | Negative prompt |
|---|---|---|---|
| **Z-Image-Turbo** | drafts, batches, fast iteration | seconds | no (CFG 1, prompt only) |
| **Qwen-Image-2.1** | final assets, legible in-image text, precise composition | minutes | yes |

## What it registers

- **`comfyui_generate`** — generate one or more images and save them to disk.
- **`comfyui_status`** — report which workflows are ready on this machine and
  what defaults they use. Useful when generation fails.
- **Skill `comfyui-image`** — model selection and prompt craft, so the agent
  chooses deliberately instead of always reaching for the same model.

## Requirements

- **Comfy Desktop** with the model templates installed (it ships a "Z-image" and
  a "Qwen-Image-2.1" template), **or** any ComfyUI checkout that has the model
  weights on disk.
- **DeepSeek Harness** 0.2.0-rc.2 or newer.
- No npm dependencies. The plugin talks to ComfyUI over its own HTTP API.

You do **not** need ComfyUI to be running. The plugin starts it headless on
first use and reuses it afterwards.

## Install

```sh
dsh plugin --profile desktop add https://github.com/<you>/dsh-comfyui-image.git
```

Or from a clone:

```sh
git clone https://github.com/<you>/dsh-comfyui-image.git
dsh plugin --profile desktop add ./dsh-comfyui-image
```

Restart the Harness (or let profile HMR pick the new bundle up) and ask for an
image.

## How it finds your ComfyUI

The plugin prefers an **already-running** server, and otherwise launches one
itself:

1. Probe the configured port, then `8188`–`8192`, for a live `/system_stats`.
2. If nothing answers, find a local ComfyUI checkout that can actually load the
   workflow's weights — checked against the model files, not the folder name, so
   an unrelated install is never picked by accident.
3. Launch it headless with that install's own virtualenv and its
   `extra_model_paths.yaml` (which is what makes Comfy Desktop's shared model
   directory visible).

### Configuration

All optional. Set environment variables, or just rely on the defaults.

| Variable | Effect |
|---|---|
| `DSH_COMFY_PORT` | Force one port for every workflow (default: probe `8188`–`8192`) |
| `DSH_COMFY_PORT_Z_IMAGE_TURBO` | Force a port for Z-Image-Turbo only |
| `DSH_COMFY_PORT_QWEN_IMAGE_2_1` | Force a port for Qwen-Image-2.1 only |
| `DSH_COMFYUI_PATH` | Point at a manual ComfyUI checkout instead of Comfy Desktop |
| `DSH_ZIMAGE_MODELS` | Override Z-Image-Turbo model file names (JSON) |
| `DSH_QWEN_IMAGE_MODELS` | Override Qwen-Image-2.1 model file names (JSON) |

Override the model names when your weights differ from the defaults, e.g. if you
quantised Qwen-Image-2.1 yourself:

```sh
export DSH_QWEN_IMAGE_MODELS='{"unet_name":"qwen_image_2.1_fp8.safetensors","clip_name":"qwen3vl_8b_fp8.safetensors","vae_name":"qwen_image_2.1_vae_bf16.safetensors"}'
```

## Usage from a session

> draw a small green plant in a terracotta pot, soft window light, photograph

The agent loads the `comfyui-image` skill, picks Z-Image-Turbo for a draft, and
saves the result under `./generated-images/`.

Ask for more control when you want it:

> use qwen-image-2.1 to make a 16:9 poster that says "DEEP DIVE" in bold letters
> above a stylised submarine, screen-print texture, negative prompt: blurry text

## Workflows

Both graphs live in `workflows/` as **ComfyUI API-format JSON** with
`{{placeholder}}` strings. They were derived from the official Comfy template
workflows and flattened out of their subgraphs, so they queue over plain HTTP
without the frontend.

To add or tune a workflow:

1. Build it in the ComfyUI UI.
2. Save as API format (Developer → Save (API Format)).
3. Replace the values you want to parameterise with `{{snake_case}}` names.
4. Drop it in `workflows/` and add a spec in `lib/workflows.js`.

A parameter that is missing or misspelled fails loudly before anything reaches
the GPU — you get an error naming it, not a silently wrong image.

## Development

```sh
node scripts/smoke.mjs           # discovery, rendering, validation, one live generation
node scripts/plugin-contract.mjs # apply() against a fake host: schemas, validation, disposal
node scripts/boot-check.mjs      # apply() under the real Cordis loader
```

`smoke.mjs` performs an actual generation, so ComfyUI must be reachable. The
other two are hermetic.

## Design notes

- **No runtime dependencies.** Installing from a git clone makes a directory
  junction, so an import of a peer package would have to resolve from the
  clone's real path rather than from the profile's `node_modules`. Using only
  `ctx.tools` and `ctx.skills` keeps the plugin installable from anywhere.
  `lib/define-tool.js` is a small local `defineTool` that compiles the parameter
  DSL to JSON Schema and validates arguments before dispatch.
- **The plugin only stops processes it started.** A ComfyUI you launched
  yourself is left running when the plugin disposes.
- **Images are copied into the workspace** rather than referenced in Comfy
  Desktop's managed output folder, so a later Comfy Desktop tidy-up cannot
  delete work the agent just did.

## License

MIT — see [LICENSE](LICENSE).