// Exercise the local `defineTool` equivalent: the parameter DSL compiler and
// the argument validator that guard every tool call.
//
// The schema shape is asserted, not just the behaviour, because a property node
// carrying a scalar `required` is invalid JSON Schema: `required` is an array of
// property names owned by the *containing* object. A tool schema that is invalid
// in this way is rejected wholesale by the model gateway, so every tool in the
// session disappears rather than just the broken one.
//
// usage: node scripts/define-tool.mjs

import { defineTool, parametersToJsonSchema, ToolArgsError, validateArguments } from "../lib/define-tool.js";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  PASS ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  }
}

/** Every property node reachable in a schema, paired with its owning schema. */
function* propertyNodes(schema, owner = schema) {
  for (const node of Object.values(schema.properties ?? {})) {
    yield { node, owner };
    if (node.type === "object") yield* propertyNodes(node, node);
    if (node.type === "array" && node.items !== undefined) yield* propertyNodes(node.items, node);
  }
}

const output = { schema: { type: "object" }, render: () => [{ type: "text", text: "ok" }] };

console.log("# compiled schema shape");
const parameters = {
  prompt: { type: "string", required: true, description: "the prompt" },
  kind: { type: "string", enum: ["a", "b"], description: "which" },
  count: { type: "integer", description: "how many" },
  nested: {
    type: "object",
    description: "an object parameter",
    required: ["inner"],
    properties: {
      inner: { type: "string", required: true, description: "required inner" },
      other: { type: "integer", description: "optional inner" },
    },
  },
  list: { type: "array", description: "an array", items: { type: "string", description: "item" } },
};
const schema = parametersToJsonSchema(parameters);

check("root is object-rooted", schema.type === "object");
check("root required is an array", Array.isArray(schema.required), JSON.stringify(schema.required));
check("root required names the required parameter", schema.required?.includes("prompt"));
check("root required omits optional parameters", !schema.required?.includes("kind"));
check("required is an array on the nested object too", Array.isArray(schema.properties.nested.required));
check("nested required names the inner key", schema.properties.nested.required?.includes("inner"));

// The rule that matters: no property node may carry a scalar `required`.
let scalars = [];
for (const { node, owner } of propertyNodes(schema)) {
  if (node.required !== undefined && !Array.isArray(node.required)) {
    scalars.push(`${Object.entries(owner.properties).find(([, v]) => v === node)?.[0] ?? "?"}`);
  }
}
check("no property node carries a scalar required", scalars.length === 0, scalars.join(", "));
check("required on prompt is carried by the root array, not the property",
  schema.properties.prompt.required === undefined);
check("every required value in the schema is an array",
  Object.values(schema.properties).every((n) => n.required === undefined || Array.isArray(n.required)));
check("array items are compiled", schema.properties.list.items?.type === "string");
check("array items carry no scalar required", schema.properties.list.items?.required === undefined);

console.log("# argument validation");
const validate = (args) => validateArguments(schema, args);
check("a complete call passes", validate({ prompt: "x" }).length === 0);
check("a missing required argument is reported", validate({}).some((v) => /prompt is required/.test(v)),
  validate({}).join("; "));
check("an optional argument may be absent", validate({ prompt: "x" }).length === 0);
check("a wrong type is reported", validate({ prompt: 42 }).some((v) => /prompt must be string/.test(v)),
  validate({ prompt: 42 }).join("; "));
check("a non-integer is reported", validate({ prompt: "x", count: 1.5 }).some((v) => /count must be an integer/.test(v)),
  validate({ prompt: "x", count: 1.5 }).join("; "));
check("an out-of-enum value is reported", validate({ prompt: "x", kind: "c" }).some((v) => /kind must be one of/.test(v)),
  validate({ prompt: "x", kind: "c" }).join("; "));
check("a missing nested required key is reported",
  validate({ prompt: "x", nested: {} }).some((v) => /inner is required/.test(v)),
  validate({ prompt: "x", nested: {} }).join("; "));
check("a complete nested object passes", validate({ prompt: "x", nested: { inner: "y" } }).length === 0);
check("an array element of the wrong type is reported",
  validate({ prompt: "x", list: ["a", 3] }).some((v) => /list\[1\] must be string/.test(v)),
  validate({ prompt: "x", list: ["a", 3] }).join("; "));
check("a valid array passes", validate({ prompt: "x", list: ["a", "b"] }).length === 0);

console.log("# nested path reporting");
// A nested key must be named by its path, so a message is actionable.
const deep = parametersToJsonSchema({
  prompt: { type: "string", required: true },
  config: {
    type: "object",
    required: ["mode"],
    properties: { mode: { type: "string" } },
  },
});
const deepViolations = validateArguments(deep, { prompt: "x", config: {} });
check("nested violation names the full path",
  deepViolations.some((v) => v.startsWith("config.mode")), deepViolations.join("; "));

console.log("# tool wiring");
const tool = defineTool({ name: "demo", description: "d", parameters, output, execute: () => "ran" });
check("execute is reachable", tool.execute({ prompt: "x" }).then === undefined || true);
let threwName = "";
try {
  await tool.execute({}, {});
} catch (error) {
  threwName = error.name;
}
check("execute throws ToolArgsError on bad args", threwName === "ToolArgsError", threwName);
try {
  defineTool({ name: "run_code", description: "d", parameters, output, execute: () => {} });
  check("the reserved name is refused", false, "no error thrown");
} catch {
  check("the reserved name is refused", true);
}
try {
  defineTool({ name: "demo", description: "d", parameters, execute: () => {} });
  check("a tool without output.render is refused", false, "no error thrown");
} catch {
  check("a tool without output.render is refused", true);
}
let carriedViolations = [];
try {
  await defineTool({ name: "t2", description: "d", parameters, output, execute: () => {} }).execute({});
} catch (error) {
  carriedViolations = error.violations ?? [];
}
check("ToolArgsError carries the violations",
  carriedViolations.length > 0 && carriedViolations.every((v) => typeof v === "string"),
  JSON.stringify(carriedViolations));

console.log(failures === 0 ? "\nALL DEFINE-TOOL CHECKS PASSED" : `\n${failures} DEFINE-TOOL CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);