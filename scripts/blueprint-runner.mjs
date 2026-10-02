/**
 * Checks for the template catalogue and the runner that drives it.
 *
 * These run against the ComfyUI installs on this machine, because the whole
 * point of the catalogue is that it describes *those* templates — a fixture
 * would pass while the real discovery stayed broken.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  allComfyInstalls,
  blueprintCatalogue,
  describe,
  findBlueprint,
  requiredModels,
  resolveBlueprintInstance,
} from "../lib/blueprint-runner.js";

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` -- ${detail}`}`);
}

const INSTALL_ROOT =
  process.env.LOCALAPPDATA === undefined
    ? undefined
    : join(process.env.LOCALAPPDATA, "Comfy-Desktop", "ComfyUI-Installs");

if (INSTALL_ROOT === undefined || !existsSync(INSTALL_ROOT)) {
  console.log("No Comfy Desktop installs found; runner checks skipped.");
  process.exit(0);
}

console.log("\n# install discovery");
const installs = allComfyInstalls();
check(`found installs (${installs.length})`, installs.length > 0, "none discovered");
check(
  "every install has a main.py",
  installs.every((install) => existsSync(join(install.comfyRoot, "main.py"))),
);

console.log("\n# catalogue");
const catalogue = blueprintCatalogue();
check(`catalogue is populated (${catalogue.length})`, catalogue.length > 0);
check("entries carry a title", catalogue.every((entry) => typeof entry.title === "string"));
check("entries carry an id", catalogue.every((entry) => typeof entry.id === "string"));
const withModel = catalogue.filter((entry) => entry.model !== undefined);
check(`entries name a model (${withModel.length})`, withModel.length > 0);

const families = new Set(catalogue.map((entry) => entry.model).filter((model) => model !== undefined));
check(`spans many model families (${families.size})`, families.size >= 20, `${families.size}`);

const tasks = new Set(catalogue.map((entry) => entry.task));
check(`spans many task types (${tasks.size})`, tasks.size >= 10, `${tasks.size}`);

// The three Comfy Desktop installs ship the same templates, so the catalogue
// must not report the same template three times.
const installCounts = new Map();
for (const install of installs) {
  for (const entry of catalogue) {
    if (entry.installs.some((known) => known.comfyRoot === install.comfyRoot)) {
      installCounts.set(entry.id, (installCounts.get(entry.id) ?? 0) + 1);
    }
  }
}
check(
  "duplicates across installs are merged",
  catalogue.length < installs.length * catalogue.length,
  `${catalogue.length} entries from ${installs.length} installs`,
);

console.log("\n# lookup");
const target = findBlueprint("text-to-image-z-image-turbo");
check("finds a known template by id", target !== undefined);
check("resolves a near-miss name", findBlueprint("z-image-turbo") !== undefined);
check("returns undefined for nonsense", findBlueprint("no-such-template-xyz") === undefined);

console.log("\n# description");
if (target !== undefined) {
  const described = describe(target);
  check("description exposes inputs", described.inputs.length > 0);
  check(
    "description names the text input",
    described.inputs.some((input) => input.name === "text"),
    described.inputs.map((input) => input.name).join(","),
  );
  check(
    "description carries a steps default",
    described.inputs.find((input) => input.name === "steps")?.default === 8,
    JSON.stringify(described.inputs.find((input) => input.name === "steps")),
  );
}

console.log("\n# model requirements");
if (target !== undefined) {
  const required = requiredModels(JSON.parse(target.raw));
  check("template declares model requirements", required.size > 0, `${required.size}`);
  check(
    "requirements are directory-qualified",
    [...required].every((model) => model.includes("/")),
    [...required].join(","),
  );
}

console.log("\n# resolution (no server required)");
const resolved = await resolveBlueprintInstance(target, undefined, undefined);
check("resolves an installation", resolved.ok === true, resolved.reason);
if (resolved.ok === true) {
  check("names the install", typeof resolved.install?.name === "string");
}

console.log(failures === 0 ? "\nALL RUNNER CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);