---
name: comfyui-image
description: >-
  Generate image assets on this machine's local ComfyUI server with Z-Image-Turbo or
  Qwen-Image-2.1. Covers model selection, prompt structure, resolution and seed strategy,
  and how to inspect the result.
---

# ComfyUI image generation

You can generate real images on the user's own GPU through their local ComfyUI
install. Two workflows are configured, and they are genuinely different tools —
choose deliberately rather than defaulting to the same one every time.

## The two workflows

### `z-image-turbo` — the fast one

- **Use for:** drafts, exploring a direction, batches of many variants, anything
  where you will iterate.
- **Speed:** seconds to a few minutes even on a laptop GPU.
- **Prompting:** the prompt is the *only* control. There is **no negative
  prompt** — if you must avoid something, say what you want instead
  ("a clean background with no text" rather than "no text").
- **Steps:** keep it at 6-9. It is a distilled model; more steps make it worse,
  not better.
- **CFG:** fixed at 1.0. Do not try to raise it.

### `qwen-image-2.1` — the capable one

- **Use for:** final assets, images that must contain **legible text** (posters,
  logos, UI mockups, diagrams with labels), precise multi-element composition,
  or anything where you need a real negative prompt.
- **Speed:** substantially slower; budget minutes, not seconds.
- **Prompting:** supports a true negative prompt. Long, descriptive paragraphs
  work well. It renders text far more reliably than the turbo model.
- **Steps:** 20-30 is the sweet spot. CFG around 4.
- **Resolution:** natively supports 2K (2048x2048). Use it for final assets;
  it is slow, so keep the count low.

## How to choose, in one line

Fast iteration, many variants, or a draft → `z-image-turbo`.
Final quality, text in the image, or a negative prompt → `qwen-image-2.1`.

When the user asks for "an image" with no other constraint, start with
`z-image-turbo`, look at it, and switch to `qwen-image-2.1` only if the result
needs more than the turbo model can give.

## Writing the prompt

Both models respond to the same four-part structure. Fill in what matters and
drop the rest:

1. **Subject** — what is in the frame, concretely and specifically.
2. **Composition** — framing, angle, crop, where the subject sits.
3. **Lighting** — the single highest-leverage detail. "soft window light",
   "golden hour backlight", "studio softbox".
4. **Style and medium** — "photograph", "oil painting", "flat vector
   illustration", "35mm film".

Write it as one flowing paragraph, not a keyword list. Describe what you want
to *see*, not what the camera is avoiding.

Useful patterns:

- `a weathered brass compass on a nautical chart, top-down close-up, warm
  afternoon window light, detailed photograph`
- `flat vector illustration of a friendly robot mascot, centered, bright
  two-colour palette, clean white background, no text`
- `a poster reading "DEEP DIVE" in bold sans-serif letters above a stylised
  submarine, screen-print texture, limited palette of navy and cream`
  (use `qwen-image-2.1` — the text must be legible)

## Resolution, seed, and batches

- **Default 1024x1024** square is right for most work. Ask about the real target
  aspect ratio when the user has one (16:9 for a banner, 1:1 for an avatar).
- Values are rounded to a multiple of 32 automatically.
- **Seeds matter for iteration.** When a result is close but not right, re-run
  with the *same* seed and a tweaked prompt; you isolate the prompt's effect.
  Change the seed to explore a different composition of the same idea.
- `count` produces several images in one call. On a laptop GPU keep it at 2-4,
  and only with `z-image-turbo`.

## After generating

The tool saves each image into the workspace and returns the path. **Read the
file back** to actually look at it before reporting success — a generation that
ran without error can still be the wrong image.

If the result is close, iterate: same seed, one changed part of the prompt.
If it is far off, the prompt is probably too vague or the wrong model was used.

## When generation fails

Call `comfyui_status` first. It reports whether the matching ComfyUI install was
detected and what defaults will be used.

- **"no matching local installation"** — the user does not have that workflow's
  ComfyUI install, or its models are missing. Report this plainly rather than
  retrying; it is a setup problem, not a prompt problem.
- **A timeout** — the GPU is probably still working. Say so, and wait before
  retrying; a second call would queue behind the first.

The first call after the server is stopped may take a minute or two because
ComfyUI starts headless. Later calls reuse it and are much faster.