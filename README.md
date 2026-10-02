# dsh-comfyui-image

Generate images, video, audio and 3D assets from **DeepSeek Harness** using a
**local ComfyUI** install — no API keys, no cloud, no per-image cost. The agent
picks a model, writes the prompt, queues the workflow on your own GPU, and gets
back a real file.

Two things ship wired up. The first is two hand-tuned text-to-image workflows:

| Workflow | Good at | Speed | Negative prompt |
|---|---|---|---|
| **Z-Image-Turbo** | drafts, batches, fast iteration | seconds | no (CFG 1, prompt only) |
| **Qwen-Image-2.1** | final assets, legible in-image text, precise composition | tens of seconds | yes |

The second is everything else: ComfyUI already ships **116 workflow templates
across 67 open-weight model families** — image editing, video generation,
ControlNet and pose control, depth estimation, background removal, upscaling,
3D, music and audio. This plugin makes all of them drivable from the agent.

## What it registers

- **`comfyui_generate`** — text-to-image, one prompt in, tuned parameters out.
- **`comfyui_templates`** — browse the machine's template catalogue, inspect one
  template's inputs, or ask which model fits a task (`recommend=true`).
- **`comfyui_run_template`** — run a template and save its output.
- **`comfyui_status`** — report what is installed and ready. Useful when a
  generation fails.
- **Skill `comfyui-image`** — model selection, prompt craft, sampler tuning and
  negative-prompt support, so the agent chooses deliberately.

## The template catalogue

ComfyUI stores its templates as **browser graphs**: canvas coordinates, link
objects, and the real graph wrapped in a subgraph. `/prompt` accepts none of
that — it wants the API form. The server has no conversion path; it exists only
in the frontend's JavaScript.

`lib/blueprint.js` is that conversion. Each part of it was a real bug:

- subgraph unwrapping, because a template's top-level node type is a UUID
- widget alignment, because `widgets_values` is positional over *widget* inputs
  only and a seeded widget is followed by its control-after-generate setting —
  get it wrong and every later value lands on the wrong input
- dependency order, because the canvas stores nodes in creation order, so
  converting in file order drops required inputs and ComfyUI blames a node
  several steps away
- `Reroute` is a splint, not a decoration: dropping it severs every link behind it
- a *bypassed* node is not in the submitted graph at all, so its consumers are
  rewired to an upstream output — and that rewire is type-checked, because a
  bypassed `PreviewAny` can be carrying a STRING from two wildcard hops away
  and connecting to the first wildcard would hand a non-string to
  `CLIPTextEncode.text`
- template defaults live on the node an exposed input feeds, not at the top level
- templates ship no `SaveImage`, and the executor persists only `OUTPUT_NODE`
  results, so one is appended on a collision-free id

345 of 348 template files convert cleanly across 67 model families. The
remainder are refused with a reason rather than converted into something that
would quietly render the wrong thing.

Whether a template can actually *run* is a separate question, and it is answered
from the converted graph rather than the template's model manifest — a manifest
lists every model a template could use, and rejecting a run for an optional
ControlNet is as wrong as missing a required one. A template whose weights are
not on this machine is refused before it reaches the executor, with the missing
files named, instead of coming back as an opaque HTTP 400.

## The knowledge layer

Capability is not the hard part — knowing how to *drive* a model is. The
catalogue supplies each template's default values, but not the reasoning, so
`lib/model-knowledge.js` records what each family needs: sampler ranges,
negative-prompt support, text-rendering reliability, and prompt hints.

Every value is read back out of the local blueprints rather than written from
memory, and anything unverified is marked as such.

The reasoning catches things that fail silently. Z-Image-Turbo wires its
sampler's negative slot to a node that zeroes it, so **a negative prompt
produces a byte-identical image instead of an error**. An agent that does not
know this will "refine" a prompt and change nothing at all.

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

Restart the Harness and ask for an image.

A restart is required, not optional: the profile applies its plugins once when
it boots, so a change to `lib/` — or to this plugin after a `git pull` — is not
picked up by the running process. Only the Web GUI's *client* plugins hot
reload, and only while `pnpm run dev:web` is rebuilding them; this plugin's
tools and skill are server-side.

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
npm test                          # schema shape, parameter resolution, apply(), blueprint conversion, catalogue, knowledge
npm run test:host                 # the installed Harness's own skill validator, extracted from app.asar
npm run test:smoke                # discovery + a real generation of both workflows through the tool
node scripts/boot-check.mjs <node_modules> <plugin-dir>   # apply() under the real Cordis loader
```

`npm test` runs six suites. The first three are hermetic; the blueprint,
catalogue and knowledge suites read the ComfyUI templates installed on this
machine, because their whole subject is those real files — a synthetic fixture
would pass while the actual conversion stayed broken. Each skips cleanly when no
ComfyUI install is present.

`npm test` is hermetic and needs neither ComfyUI nor the Harness. The other
three need one of the two, and `boot-check` additionally needs a checkout that
supplies `@deepseek-ai/cordis`.

`define-tool.mjs` asserts the *shape* of the compiled tool schema, not just the
behaviour: JSON Schema defines `required` as an array of property names owned by
the containing object, so a `required: true` left on a property node makes the
schema invalid, and a gateway that validates the tool list it is handed rejects
the whole list — every tool, not just the broken one.

`test:host` is the interesting one. `ctx.skills.register()` only validates
`name`, `description` and `invocation`, so a skill missing its `source` field
registers cleanly, shows up in the catalog, and then fails every time the model
tries to load it. That second validation lives in `@deepseek-ai/dsh-skill`; this
script lifts the real function out of the installed `app.asar` and runs the
plugin's skill through it, with a negative control proving the check can still
fail. `npm test` carries a transcription of the same rules so a regression is
caught without an installed Harness.

`test:smoke` generates with both workflows using the *minimal* argument shape a
model actually produces — prompt only, every optional argument omitted — because
that is where a default-erasing bug shows up.

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