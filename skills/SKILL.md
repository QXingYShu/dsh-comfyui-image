---
name: comfyui-image
description: >-
  Generate images, video, audio and 3D assets on this machine's local ComfyUI server.
  Covers model selection across 60+ open-weight model families, prompt craft, sampler tuning,
  negative-prompt support, and when to reach for a workflow template instead of plain text-to-image.
---

# ComfyUI generation

You drive the user's own GPU through their local ComfyUI install. Nothing here
costs money per image and nothing leaves the machine.

There are two levels, and confusing them wastes the best capability on the box.

- **Plain text-to-image** → `comfyui_generate`. Fast, tuned, one prompt in.
- **Everything else** → `comfyui_templates` + `comfyui_run_template`. ComfyUI
  ships **116 workflow templates across 67 model families**: image editing,
  video generation, ControlNet and pose control, depth estimation, background
  removal, upscaling, 3D, and music and audio synthesis.

## Start here

**Want an image?** Use `comfyui_generate`. It is the shortest path and the
settings are already right for its two models.

**Want something else?** — a video, an edit, a control-guided render, an
upscale, a 3D asset — call `comfyui_templates` first. It lists what this
machine can actually run, and it is not only images.

**Not sure which model fits?** Call `comfyui_templates(task="<what you need>",
recommend=true)`. It returns the models suited to that task with reasons, the
templates that drive them, and their sampler settings.

The task vocabulary is: `text-to-image`, `image-to-image`, `image-edit`,
`text-rendering`, `control`, `pose`, `depth`, `segmentation`, `video`,
`upscale`, `3d`, `audio`, `music`, `caption`.

## The two text-to-image models

### `z-image-turbo` — the fast one

- **Use for:** drafts, exploring a direction, batches, anything iterative.
- **Speed:** seconds. 1024px is usually under twenty.
- **Prompting:** the prompt is the **only** control. **There is no negative
  prompt** — the template wires the sampler's negative slot to a node that
  zeroes it, so a negative prompt produces a *byte-identical* image. To avoid
  something, describe its replacement positively: say "clean background with no
  text", never "no text".
- **Steps:** 6-9. It is distilled; more steps make it **worse**, not better.
- **CFG:** fixed at 1.0. Do not try to raise it.
- **Text rendering:** unreliable. Never use it when words must be legible.

### `qwen-image-2.1` — the capable one

- **Use for:** final assets, images that must contain **legible text** (posters,
  logos, UI mockups, labelled diagrams), precise multi-element composition, or
  anything needing a real negative prompt.
- **Speed:** substantially slower; budget tens of seconds to minutes.
- **Prompting:** supports a true negative prompt. Long descriptive paragraphs
  work well, and text renders far more reliably than the turbo model.
- **Resolution:** natively handles larger canvases (its own template defaults to
  1328px). Slow, so keep the count low.

### Choosing in one line

Draft, batch, or fast iteration → `z-image-turbo`.
Final quality, legible in-image text, or a negative prompt → `qwen-image-2.1`.

## Running a template

1. Find it: `comfyui_templates(task="video")` or `comfyui_templates(search="portrait")`.
2. Read it: `comfyui_templates(template="<id>")`. This returns its inputs, their
   defaults, **and the model's tuning notes** — sampler range, whether it takes a
   negative prompt, and prompt-specific advice.
3. Run it: `comfyui_run_template(template="<id>", inputs={text: "..."})`.
   Anything you omit keeps the template's own tuned value.

Do not invent input names. The template decides what it accepts, and only its
declared inputs are forwarded.

## Writing a prompt

Four parts. Fill in what matters, drop the rest:

1. **Subject** — what is in frame, concretely.
2. **Composition** — framing, angle, crop, where the subject sits.
3. **Lighting** — the single highest-leverage detail. "soft window light",
   "golden hour backlight", "studio softbox".
4. **Style and medium** — "photograph", "oil painting", "flat vector
   illustration", "35mm film".

One flowing paragraph, not a keyword list. Describe what you want to *see*.

Useful patterns:

- `a weathered brass compass on a nautical chart, top-down close-up, warm afternoon window light, detailed photograph`
- `flat vector illustration of a friendly robot mascot, centered, bright two-colour palette, clean white background, no text`
- `a poster reading "DEEP DIVE" in bold sans-serif letters above a stylised submarine, screen-print texture, navy and cream`
  — use `qwen-image-2.1`; the text must be legible

## Resolution, seed, batches

- **1024x1024** is the right default. Ask about the real target ratio when the
  user has one (16:9 banner, 1:1 avatar).
- Values round to a multiple of 32 automatically.
- **Seeds matter.** When a result is close but wrong, re-run the *same seed* with
  a tweaked prompt: that isolates the prompt's effect. Change the seed to explore
  a different reading of the same idea.
- `count` produces several images in one call. On a laptop GPU keep it at 2-4,
  and only with `z-image-turbo`.

## Always look at the output

The tool returns saved file paths. **Read the image back** before reporting
success. A run that completes without error can still be the wrong picture.

If it is close, iterate: same seed, one changed part of the prompt. If it is far
off, the prompt was probably too vague, or the wrong model was used.

## When generation fails

Call `comfyui_status` first — it reports whether the matching installation was
found and which defaults will be used.

- **"no matching local installation"** — the model is not installed, or its
  weights are missing. Report it plainly; do not retry. For templates this means
  the running server cannot see the files that template needs.
- **A timeout** — the GPU is probably still working. Say so and wait; a second
  call would queue behind the first. Video and 3D templates legitimately take
  many minutes.
- **"needs model files that this machine does not have"** — the weights are not
  installed. The message names the exact files and folder; report that plainly
  rather than retrying, and suggest a template whose models are present.
- **"this template needs an input you must supply"** — templates like video
  stitching or upscaling take source media. Pass it under the template's own
  input names; `comfyui_templates(template=...)` lists them.
- **The template drives no sampler** — it is a utility (colour grading, crop,
  caption), not a generator. Use it as a step alongside a generating template.

The first call after the server stops may take a minute or two while ComfyUI
starts headless. Later calls reuse it and are much faster.
