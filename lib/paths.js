/**
 * Where a generated file goes, and what it is called.
 *
 * Both the curated workflows and the template runner write into the workspace,
 * and both need the same two decisions: which directory a relative path means,
 * and what to name the file. Keeping them here is what stops the two tools
 * from quietly disagreeing.
 */

import { isAbsolute, join, resolve } from "node:path";

/** Longest slug accepted for a generated file name. */
const MAX_SLUG_LENGTH = 60;

/**
 * The directory the agent is working in.
 *
 * This is not `process.cwd()`. The Host process starts in the profile
 * directory, so resolving a relative path against it drops every generated
 * image outside the workspace the user opened — the tool then reports a path
 * under the profile that no later edit or commit will ever see. The agent
 * carries the real working directory on its session header.
 */
export function workspaceCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}

/** Resolve where a generated image should be written. */
export function resolveOutputDir(requested, exec) {
  const base = workspaceCwd(exec);
  if (typeof requested === "string" && requested !== "") {
    return isAbsolute(requested) ? requested : resolve(base, requested);
  }
  return join(base, "generated-images");
}

/** Turn a prompt into a stable, filesystem-safe file stem. */
export function slugify(text) {
  const ascii = String(text ?? "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = ascii.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
  return trimmed === "" ? "image" : trimmed;
}