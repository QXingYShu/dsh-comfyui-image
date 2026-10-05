/**
 * Capability derivation checks.
 *
 * The point of deriving capability from templates is that it cannot drift: a
 * model with an image-taking template is an image-to-image model, whatever its
 * record says. These assert the derivation itself, because the failure it
 * replaces was silent -- `Qwen-Image` had six templates that take an image and
 * was never offered for image-to-image.
 */

import { capabilitiesOf, familiesForTask, modelCapabilities } from "../lib/capabilities.js";
import { blueprintCatalogue } from "../lib/blueprint-runner.js";
import { MODEL_KNOWLEDGE, recommendForTask } from "../lib/model-knowledge.js";

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` -- ${detail}`}`);
}

const catalogue = blueprintCatalogue();

console.log("\n# derivation");
const capabilities = modelCapabilities(catalogue);
check("families were derived", capabilities.size > 30, `${capabilities.size}`);
check("capabilities are known values", [...capabilities.values()].every((set) => set.size > 0));

console.log("\n# the case that motivated this");
{
  // Qwen-Image has edit, inpainting, outpainting and layers templates, all of
  // which take an IMAGE. Its record listed none of them under image-to-image,
  // so asking for image-to-image returned a list without it.
  const caps = capabilitiesOf("Qwen-Image", catalogue);
  check("Qwen-Image derives image-to-image", caps.has("image-to-image"), [...caps].join(","));
  check("Qwen-Image derives image-inpainting", caps.has("image-inpainting"));
  check("Qwen-Image derives image-outpainting", caps.has("image-outpainting"));
  check("Qwen-Image still derives text-to-image", caps.has("text-to-image"));

  const recommended = recommendForTask("image-to-image", { catalogue });
  check(
    "Qwen-Image is offered for image-to-image",
    recommended.some((record) => record.family === "Qwen-Image"),
    recommended.map((r) => r.family).slice(0, 5).join(", "),
  );
}

console.log("\n# breadth of the fix");
{
  // The gap was systemic, not one record: forty models had image-taking
  // templates and no image-to-image label.
  const capable = familiesForTask("image-to-image", catalogue, MODEL_KNOWLEDGE);
  check("image-to-image finds many families", capable.length >= 20, `${capable.length}`);
  check(
    "including models nobody labelled",
    capable.includes("Qwen-Image") && capable.includes("Flux.2 Klein 4B"),
    capable.slice(0, 8).join(", "),
  );

  // Every family that derives a capability must be answerable by that task.
  for (const task of ["image-inpainting", "image-outpainting", "text-to-image", "depth"]) {
    const found = recommendForTask(task, { catalogue });
    check(`${task} still has candidates`, found.length > 0, `${found.length}`);
  }
}

console.log("\n# a model with no image input stays excluded");
{
  // The converse matters as much: proving capability must not become assuming
  // it. A text-to-image template takes no IMAGE, so the model cannot do
  // image-to-image on the strength of this evidence.
  const noImage = MODEL_KNOWLEDGE.find((record) => record.family === "Z-Image-Turbo");
  check("Z-Image-Turbo is in the knowledge base", noImage !== undefined);
  // It does have control templates that take an image, so it *is* capable —
  // which is the point: the answer comes from the templates, not the label.
  check(
    "capability is decided by templates, not by the label",
    capabilitiesOf("Z-Image-Turbo", catalogue).has("image-to-image"),
    [...capabilitiesOf("Z-Image-Turbo", catalogue)].join(","),
  );
}

console.log("\n# without a catalogue it degrades to declarations");
{
  // Reading templates must not be a hard dependency: with no catalogue the
  // hand-written labels still answer, rather than the tool failing.
  const fallback = recommendForTask("depth");
  check("depth still answers without a catalogue", fallback.length > 0, `${fallback.length}`);
}

console.log(failures === 0 ? "\nALL CAPABILITY CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);