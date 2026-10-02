/**
 * A minimal `defineTool` equivalent.
 *
 * The Host registry takes a plain definition object, and the published helper
 * lives in `@deepseek-ai/dsh-tools`. This plugin deliberately has no runtime
 * dependencies — it is installed as a directory junction, and importing a
 * peer would have to resolve from the link's real path rather than from the
 * profile's `node_modules`. Depending on nothing keeps it installable from a
 * plain git clone on any host that exposes `ctx.tools`.
 *
 * What this reproduces is the part a tool author actually relies on: compiling
 * a friendly parameter DSL into raw JSON Schema, validating model-supplied
 * arguments against it before dispatch, and failing with a readable message.
 */

/** Value types this DSL understands, mirroring the Host's subset. */
const VALUE_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);

/** The Host reserves this name for its PTC transport. */
const RESERVED_NAME = "run_code";

/** Human-readable type name used in validation messages. */
function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Compile one parameter property into a raw JSON Schema node.
 *
 * A property node deliberately never carries its own `required` flag. JSON
 * Schema defines `required` as an array of property names owned by the
 * *containing* object, so a scalar `required: true` left on a property node is
 * an invalid schema. Strict model gateways validate the tool list they are
 * handed and reject the whole list when any part of it is malformed, which
 * costs the session every tool, not just this one. Only
 * `parametersToJsonSchema` and the nested-object branch below emit `required`,
 * always as an array.
 */
function compileProperty(name, spec) {
  if (spec === null || typeof spec !== "object") {
    throw new TypeError(`parameter "${name}" must be an object`);
  }
  const node = { type: spec.type };
  if (spec.description !== undefined) node.description = spec.description;
  if (spec.enum !== undefined) node.enum = [...spec.enum];
  if (spec.type === "array") {
    if (spec.items === undefined) throw new TypeError(`parameter "${name}" of type array needs items`);
    node.items = compileProperty(`${name}[]`, spec.items);
  }
  if (spec.type === "object") {
    node.additionalProperties = spec.additionalProperties ?? false;
    node.properties = {};
    const innerRequired = [];
    for (const [key, value] of Object.entries(spec.properties ?? {})) {
      node.properties[key] = compileProperty(key, value);
      if (spec.required?.includes(key) ?? false) innerRequired.push(key);
    }
    if (innerRequired.length > 0) node.required = innerRequired;
  }
  return node;
}

/** Compile the author-facing parameter map into raw JSON Schema. */
export function parametersToJsonSchema(parameters) {
  const properties = {};
  const required = [];
  for (const [name, spec] of Object.entries(parameters)) {
    const isRequired = spec.required === true;
    properties[name] = compileProperty(name, spec);
    if (isRequired) required.push(name);
  }
  const schema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Validate one value against one compiled schema node.
 *
 * `requiredNames` is the `required` array of the object that *owns* the node
 * being validated, i.e. the schema node one level up. Absent-property detection
 * must read that array, because a property node never carries `required`
 * itself — see `compileProperty`.
 */
function validateValue(value, schema, path, violations, requiredNames) {
  // A required property that the model omitted is a violation in its own
  // right: without this check a missing argument would flow into `execute`
  // as `undefined` and fail far from its cause.
  if (value === undefined) {
    if (requiredNames?.includes(leafKey(path)) ?? false) violations.push(`${path || "value"} is required`);
    return;
  }
  const expected = schema.type;
  if (expected === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      violations.push(`${path || "value"} must be an integer`);
      return;
    }
  } else if (expected === "null") {
    if (value !== null) {
      violations.push(`${path || "value"} must be null`);
      return;
    }
  } else if (expected !== undefined && typeName(value) !== expected) {
    violations.push(`${path || "value"} must be ${expected}, got ${typeName(value)}`);
    return;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    violations.push(`${path || "value"} must be one of ${schema.enum.join(" | ")}`);
    return;
  }
  if (expected === "array") {
    if (!Array.isArray(value)) return;
    value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, violations, schema.required));
    return;
  }
  if (expected === "object" && value !== null && typeof value === "object") {
    // Every declared property is visited, including absent ones: a required
    // property that the model failed to supply must be reported, and
    // `validateValue` decides that from the owning `required` array.
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      validateValue(value[key], property, path === "" ? key : `${path}.${key}`, violations, schema.required);
    }
  }
}

/** The property name a path segment refers to, ignoring any array indices. */
function leafKey(path) {
  if (path === "") return "";
  const withoutIndex = path.replace(/\[\d+\]$/, "");
  const dot = withoutIndex.lastIndexOf(".");
  return dot === -1 ? withoutIndex : withoutIndex.slice(dot + 1);
}

/** Validate model-supplied arguments, returning human-readable violations. */
export function validateArguments(schema, args) {
  const violations = [];
  validateValue(args, schema, "", violations, schema.required);
  return violations;
}

/** Raised when model-supplied arguments do not match the declared schema. */
export class ToolArgsError extends Error {
  constructor(violations) {
    super(`invalid arguments: ${violations.join("; ")}`);
    this.name = "ToolArgsError";
    this.code = "INVALID_ARGS";
    this.violations = violations;
  }
}

/**
 * Build a registry-ready tool definition.
 *
 * `output.schema` must itself be valid JSON Schema: the Host asserts it at
 * registration, so a malformed declaration fails loudly at load time rather
 * than at the first call.
 */
export function defineTool(options) {
  const { name, description, parameters, output, execute } = options;
  if (typeof name !== "string" || name === "") throw new TypeError("a tool needs a name");
  if (name === RESERVED_NAME) throw new Error(`tool name "${RESERVED_NAME}" is reserved by the Host`);
  if (output === undefined || typeof output.render !== "function") {
    throw new TypeError(`tool "${name}" must declare output { schema, render }`);
  }
  const schema = parametersToJsonSchema(parameters);

  const definition = {
    name,
    description,
    parameters: schema,
    output,
    async execute(args, exec) {
      const violations = validateArguments(schema, args);
      if (violations.length > 0) throw new ToolArgsError(violations);
      return execute(args, exec);
    },
  };
  if (options.isConcurrencySafe !== undefined) definition.isConcurrencySafe = options.isConcurrencySafe;
  if (options.timeoutMs !== undefined) definition.timeoutMs = options.timeoutMs;
  return definition;
}