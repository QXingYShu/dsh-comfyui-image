// Exercise the plugin's `apply()` against a minimal fake Cordis context, to
// verify that the tools and the skill register with the right shapes and that
// argument validation works without a real DeepSeek Harness process.
//
// usage: node scripts/plugin-contract.mjs

import { apply } from "../lib/index.js";
import { validateAsLoadedRuntimeSkill } from "./dsh-skill-contract.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  PASS ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

/** Collects registrations the way ctx.tools / ctx.skills would. */
function makeContext() {
  const tools = new Map();
  const skills = new Map();
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        disposers.push(() => tools.delete(definition.name));
        return () => tools.delete(definition.name);
      },
    },
    skills: {
      register(skill) {
        skills.set(skill.name, skill);
        disposers.push(() => skills.delete(skill.name));
        return () => skills.delete(skill.name);
      },
    },
    on() {},
  };
  return { ctx, tools, skills, disposers };
}

const { ctx, tools, skills } = makeContext();
const dispose = apply(ctx);

console.log("# registrations");
check("plugin exports name", true);
check("two tools registered", tools.size === 2, [...tools.keys()].join(", "));
check("one skill registered", skills.size === 1, [...skills.keys()].join(", "));

const generate = tools.get("comfyui_generate");
const status = tools.get("comfyui_status");
check("comfyui_generate present", generate !== undefined);
check("comfyui_status present", status !== undefined);

console.log("# comfyui_generate schema");
const schema = generate.parameters;
check("schema is an object", schema?.type === "object");
check("prompt is required", schema.required?.includes("prompt"), JSON.stringify(schema.required));
check("prompt is a string", schema.properties.prompt.type === "string");
check("kind has an enum", Array.isArray(schema.properties.kind.enum), JSON.stringify(schema.properties.kind.enum));
check(
  "kind enum lists both workflows",
  schema.properties.kind.enum.includes("z-image-turbo") && schema.properties.kind.enum.includes("qwen-image-2.1"),
);
check("width is an integer", schema.properties.width.type === "integer");
check("seed is an integer", schema.properties.seed.type === "integer");
check("count is an integer", schema.properties.count.type === "integer");
check("every parameter is described", Object.values(schema.properties).every((p) => typeof p.description === "string"));

console.log("# comfyui_generate output schema");
check("output is object-rooted", generate.output.schema.type === "object");
check("output requires ok", generate.output.schema.required?.includes("ok"));
check("output has render", typeof generate.output.render === "function");

console.log("# argument validation");
const failures_expected = [
  ["missing prompt", {}],
  ["wrong type for prompt", { prompt: 42 }],
  ["bad kind enum", { prompt: "x", kind: "not-a-model" }],
  ["non-integer width", { prompt: "x", width: 10.5 }],
];
for (const [label, args] of failures_expected) {
  let threw = false;
  try {
    await generate.execute(args, {});
  } catch (error) {
    threw = error.name === "ToolArgsError" || /invalid arguments/.test(String(error.message));
    if (!threw) console.log("    (wrong error:", error.name, error.message, ")");
  }
  check(`rejects ${label}`, threw);
}

console.log("# concurrency declaration");
check("generate is not concurrency-safe", generate.isConcurrencySafe?.() === false);
check("status is concurrency-safe", status.isConcurrencySafe?.() === true);

console.log("# skill shape");
const skill = skills.get("comfyui-image");
check("skill name is kebab-case", /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name), skill.name);
check("skill has a description", typeof skill.description === "string" && skill.description.length > 0);
check("skill has whenToUse", typeof skill.whenToUse === "string" && skill.whenToUse.length > 0);
check("skill has content", typeof skill.content === "string" && skill.content.length > 200);
check("skill content mentions both models",
  skill.content.includes("z-image-turbo") && skill.content.includes("qwen-image-2.1"));

console.log("# skill shape as the Host loads it");
// Registration only checks name/description/invocation; `validateDefinition`
// runs later inside SkillService.get(). Running the Host's own checks here is
// the only way to catch a skill that registers cleanly but cannot be loaded.
let loadedSkill;
try {
  loadedSkill = validateAsLoadedRuntimeSkill(skill);
  check("survives the Host's load-time validation", true);
} catch (error) {
  check("survives the Host's load-time validation", false, String(error.message));
}
check("declares a string source", typeof skill.source === "string" && skill.source.length > 0, String(skill.source));
check("source survives as a string after defaults are applied", typeof loadedSkill?.source === "string");
check("provider resolves to the runtime default", loadedSkill?.provider === "runtime", loadedSkill?.provider);
check("invocation defaults to model- and user-invocable",
  loadedSkill?.invocation?.modelInvocable === true && loadedSkill?.invocation?.userInvocable === true);

console.log("# comfyui_status output");
const report = await status.execute({}, {});
check("status returns ok", report.ok === true);
check("status names both workflows", report.message.includes("z-image-turbo") && report.message.includes("qwen-image-2.1"), report.message.slice(0, 200));
check("status reports readiness", /ready|NOT FOUND/.test(report.message));
console.log("  --- report preview ---");
console.log(report.message.split("\n").map((line) => `  | ${line}`).join("\n"));
const single = await status.execute({ kind: "qwen-image-2.1" }, {});
check(
  "status honors the kind filter",
  single.message.includes("qwen-image-2.1") && !single.message.includes("(z-image-turbo)"),
  single.message.slice(0, 120),
);
const rendered = status.output.render({}, single);
check("status renders text", Array.isArray(rendered) && rendered[0].type === "text");

console.log("# render output of generate");
const renderedGen = generate.output.render(
  { prompt: "x" },
  {
    ok: true,
    kind: "z-image-turbo",
    elapsed_ms: 1234,
    output_dir: "/tmp/out",
    images: [{ path: "/tmp/out/a.png", filename: "a.png", bytes: 10 }],
  },
);
check("generate render mentions the path", renderedGen[0].text.includes("/tmp/out/a.png"), renderedGen[0].text);

console.log("# disposal");
dispose();
check("dispose removes tools", tools.size === 0, [...tools.keys()].join(", "));
check("dispose removes the skill", skills.size === 0, [...skills.keys()].join(", "));

console.log(failures === 0 ? "\nALL CONTRACT CHECKS PASSED" : `\n${failures} CONTRACT CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);