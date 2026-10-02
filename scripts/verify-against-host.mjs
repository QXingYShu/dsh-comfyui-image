// Extract the Host's own skill-definition validator out of `app.asar` and run
// the plugin's registered skill through it.
//
// The reason this exists: `ctx.skills.register()` validates only name,
// description and invocation, so a skill that omits `source` registers
// cleanly, shows up in the catalog, and only fails later inside
// `SkillService.get()`. Transcribing the rule (as `dsh-skill-contract.mjs`
// does) is good enough for a regression test, but running the Host's real
// code is what actually proves the plugin matches the installed Harness.
//
// usage: node scripts/verify-against-host.mjs [--write]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(PACKAGE_ROOT, ".smoke-out", "host-skill-module");

/** The packed Electron archive shipped alongside the executable. */
function findAsar() {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness", "resources", "app.asar"),
    join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness", "resources", "default_app.asar"),
  ];
  return candidates.find((path) => existsSync(path));
}

/**
 * Read an asar file index.
 *
 * Layout: 4 bytes of pickle framing, then the length of a JSON header, then
 * the header itself, then a 4-byte alignment gap before the file contents.
 */
function readAsarHeader(buffer) {
  const headerSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.toString("utf8", 16, 16 + headerSize));
  const base = 16 + Math.ceil(headerSize / 4) * 4;
  return { header, base };
}

/** Walk the header tree, yielding every packed file with its byte range. */
function* walkFiles(node, prefix = "") {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (entry.files !== undefined) yield* walkFiles(entry, path);
    else if (entry.size !== undefined) yield { path, offset: entry.offset, size: entry.size };
  }
}

const asarPath = findAsar();
if (asarPath === undefined) {
  console.error("could not locate app.asar; run this on an installed Harness");
  process.exit(2);
}
const buffer = readFileSync(asarPath);
const { header, base } = readAsarHeader(buffer);

// The skill service is one bundled chunk; find it by content rather than by
// path, so this keeps working across Harness versions that rename the file.
const MARKER = "loaded skill \"";
let target;
for (const file of walkFiles(header)) {
  if (file.size > 8_000_000) continue;
  const text = buffer.toString("utf8", base + file.offset, base + file.offset + file.size);
  if (!text.includes("source must be a string")) continue;
  if (text.includes("function validateDefinition")) {
    target = { ...file, text };
    break;
  }
}

if (target === undefined) {
  console.error("could not find validateDefinition in app.asar");
  process.exit(2);
}
console.log(`asar:     ${asarPath}`);
console.log(`chunk:    ${target.path} (${target.size} bytes)`);

if (process.argv.includes("--write")) {
  mkdirSync(OUT_DIR, { recursive: true });
  const target_ = join(OUT_DIR, "skill-service.js");
  writeFileSync(target_, target.text);
  console.log(`written:  ${target_}`);
}

/**
 * Slice one named function declaration out of a bundle.
 *
 * Brace matching has to know about template literals: the Host's validators
 * build their messages with `` `${subject} ...` ``, and a naive counter stops
 * at the first `}` inside an interpolated expression.
 */
function extractFunction(text, name) {
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in the chunk`);
  let depth = 0;
  let mode = "code";
  let templateDepth = 0;
  for (let i = text.indexOf("{", start); i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (mode === "code") {
      if (char === "/" && next === "/") { mode = "line"; i += 1; continue; }
      if (char === "/" && next === "*") { mode = "block"; i += 1; continue; }
      if (char === '"' || char === "'") { mode = char; continue; }
      if (char === "`") { mode = "template"; continue; }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
      continue;
    }
    if (mode === "line") { if (char === "\n") mode = "code"; continue; }
    if (mode === "block") { if (char === "*" && next === "/") { mode = "code"; i += 1; } continue; }
    if (mode === "template") {
      // Inside `${...}` brace matching must resume, so track that nesting.
      if (char === "{" ) templateDepth += 1;
      else if (char === "}") templateDepth -= 1;
      else if (char === "`" && templateDepth === 0) { mode = "code"; continue; }
      else if (char === "\\") i += 1;
      continue;
    }
    if (char === "\\") i += 1;
    else if (char === mode) mode = "code";
  }
  throw new Error(`function ${name} is not balanced in the chunk`);
}

// Recreate the Host's validators from their own source and run them here. The
// module-level constants they close over have to come along, or the extracted
// functions fail on an undefined identifier instead of doing their job.
const constants = ["SKILL_NAME"].map((name) => {
  const match = target.text.match(new RegExp(`const ${name} = [^;]+;`));
  if (match === null) throw new Error(`constant ${name} not found in the chunk`);
  return match[0];
});
const validatorSource = [
  ...constants,
  ...["validateInvocation", "validateRuntimeSkill", "validateDefinition"].map((fn) =>
    extractFunction(target.text, fn),
  ),
].join("\n");
const { validateDefinition, validateRuntimeSkill } = new Function(
  `${validatorSource}\nreturn { validateDefinition, validateRuntimeSkill };`,
)();

console.log(`extracted: ${validatorSource.length} chars of the Host's validator source`);

// Register the plugin against a stand-in context, exactly as the Host does.
const { apply } = await import(pathToFileURL(join(PACKAGE_ROOT, "lib", "index.js")).href);
const registered = new Map();
apply({
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: (tool) => registered.set(`tool:${tool.name}`, tool) },
  skills: { register: (skill) => registered.set(`skill:${skill.name}`, skill) },
  on() {},
});

const skill = registered.get("skill:comfyui-image");
let failures = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`  PASS ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  }
};

console.log("# against the Host's own validator");
try {
  validateRuntimeSkill(skill);
  check("passes the Host's registration-time validation", true);
} catch (error) {
  check("passes the Host's registration-time validation", false, String(error.message));
}

// Mirror what SkillService does: apply the registry defaults, then validate.
const stored = {
  ...skill,
  invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
  provider: skill.provider ?? "runtime",
};
try {
  validateDefinition(stored);
  check("passes the Host's load-time validateDefinition", true);
} catch (error) {
  check("passes the Host's load-time validateDefinition", false, String(error.message));
}

// A passing check is only worth something if this validator can still fail. The
// negative control is the exact defect this plugin had: a skill that registers
// cleanly, reaches the catalog, and then cannot be loaded.
console.log("# negative control");
const { source: _omitted, ...withoutSource } = stored;
check("registering without source still succeeds", (() => {
  try {
    validateRuntimeSkill(withoutSource);
    return true;
  } catch {
    return false;
  }
})());
let controlRejected = false;
try {
  validateDefinition(withoutSource);
} catch (error) {
  controlRejected = /source must be a string/.test(String(error.message));
}
check("loading it without source is rejected by the Host", controlRejected);

console.log(failures === 0 ? "\nHOST CONTRACT VERIFIED" : `\n${failures} HOST CONTRACT CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);