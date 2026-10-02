/**
 * The Host's skill-definition contract, transcribed from `@deepseek-ai/dsh-skill`
 * so this plugin can be checked against it without a running Harness.
 *
 * `ctx.skills.register()` deliberately validates only `name`, `description` and
 * `invocation` — the cheap checks that catch an obviously broken registration.
 * The expensive checks live in `validateDefinition`, which runs later, inside
 * `SkillService.get()`. That asymmetry is the trap: a skill can register
 * without complaint, appear in the catalog, and then fail every time the model
 * tries to load it, with an error that names a field the author never thought
 * about. Mirroring both halves here means `npm test` catches that at commit
 * time instead of at first use.
 *
 * The transcribed shapes below match the Host's `validateDefinition` and
 * `validateInvocation` (see the `skills` service in `app.asar`).
 */

/** Mirrors the Host's `SKILL_NAME`. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Mirrors the Host's `validateInvocation`. */
export function validateInvocation(invocation, subject) {
  if (invocation === undefined) return;
  if (typeof invocation !== "object" || invocation === null || Array.isArray(invocation)) {
    throw new TypeError(`${subject} with a non-object invocation policy`);
  }
  if (typeof invocation.modelInvocable !== "boolean") {
    throw new TypeError(`${subject} with a non-boolean invocation.modelInvocable`);
  }
  if (typeof invocation.userInvocable !== "boolean") {
    throw new TypeError(`${subject} with a non-boolean invocation.userInvocable`);
  }
}

/** Mirrors the Host's `validateRuntimeSkill`, run at registration time. */
export function validateRuntimeSkill(skill) {
  if (!SKILL_NAME.test(skill.name)) throw new Error(`invalid skill name "${skill.name}"`);
  if (skill.description.length === 0) throw new Error(`skill "${skill.name}" requires a description`);
  validateInvocation(skill.invocation, `runtime skill "${skill.name}"`);
}

/** Mirrors the Host's `validateDefinition`, run when the skill is loaded. */
export function validateDefinition(skill) {
  const name = skill.name;
  const description = skill.description;
  const whenToUse = skill.whenToUse;
  const invocation = skill.invocation;
  const source = skill.source;
  const provider = skill.provider;
  const content = skill.content;
  const path = skill.path;
  if (typeof name !== "string") throw new TypeError("loaded skill name must be a string");
  if (!SKILL_NAME.test(name)) throw new Error(`loaded skill has invalid name "${name}"`);
  if (typeof description !== "string") throw new TypeError(`loaded skill "${name}" description must be a string`);
  if (description.length === 0) throw new Error(`loaded skill "${name}" requires a description`);
  validateInvocation(invocation, `loaded skill "${name}"`);
  if (whenToUse !== void 0 && typeof whenToUse !== "string") {
    throw new TypeError(`loaded skill "${name}" whenToUse must be a string`);
  }
  if (typeof source !== "string") throw new TypeError(`loaded skill "${name}" source must be a string`);
  if (typeof provider !== "string") throw new TypeError(`loaded skill "${name}" provider must be a string`);
  if (typeof content !== "string") throw new TypeError(`loaded skill "${name}" content must be a string`);
  if (path !== void 0 && typeof path !== "string") {
    throw new TypeError(`loaded skill "${name}" path must be a string`);
  }
}

/**
 * Reproduce the Host's load path for a registered runtime skill: the registry
 * applies its own defaults, then `SkillService.get()` validates the definition.
 *
 * `RUNTIME_PROVIDER` is the Host's default for a runtime registration; a plugin
 * that sets `provider` explicitly keeps it.
 */
const RUNTIME_PROVIDER = "runtime";

export function validateAsLoadedRuntimeSkill(skill) {
  validateRuntimeSkill(skill);
  const stored = {
    ...skill,
    invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
    provider: skill.provider ?? RUNTIME_PROVIDER,
  };
  validateDefinition(stored);
  return stored;
}