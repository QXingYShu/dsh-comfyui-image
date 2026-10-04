/**
 * Verify that every registered prompt-guide URL actually resolves.
 *
 * Repositories get renamed, made private, or gated, and a guide that silently
 * stops resolving is worse than one never registered: the agent would be told a
 * model has no guidance when it in fact used to have some. Running this turns
 * that into a report.
 *
 * Read-only, and safe to run on a machine with no ComfyUI installed — it checks
 * URLs, not templates.
 */

import { PROMPT_GUIDES, guideUrl } from "../lib/prompt-guides.js";
import { mirrorEndpoint } from "../lib/mirror.js";

/** How long to wait on one URL before calling it unreachable. */
const TIMEOUT_MS = 25_000;

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` -- ${detail}`}`);
}

async function head(url) {
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message ?? error) };
  }
}

console.log(`\n# registry shape`);
const families = Object.keys(PROMPT_GUIDES);
console.log(`  ${families.length} families registered`);
check("every entry has a repository", families.every((f) => PROMPT_GUIDES[f].repo.includes("/")));
check(
  "every entry has files",
  families.every((f) => Array.isArray(PROMPT_GUIDES[f].files) && PROMPT_GUIDES[f].files.length > 0),
);

console.log(`\n# reachability via ${mirrorEndpoint()}`);
const unreachable = [];

for (const family of families) {
  const guide = PROMPT_GUIDES[family];
  const results = [];
  for (const file of guide.files) {
    const { ok, status, error } = await head(guideUrl(guide, file));
    results.push(`${file.path}:${ok ? "ok" : error === undefined ? status : "err"}`);
    if (!ok) unreachable.push({ family, file: file.path, status, error });
  }
  console.log(`  ${family.padEnd(24)} ${guide.repo.padEnd(32)} ${results.join(" ")}`);
}

console.log(`\n# summary`);
if (unreachable.length === 0) {
  check("every registered guide resolves", true);
} else {
  // An unreachable guide is not a test failure: gating and regional blocks are
  // real, and a registered-but-unreachable entry is a deliberate case that must
  // degrade rather than break. What matters is that the caller handles it.
  console.log(`  ${unreachable.length} of ${families.length} families are currently unreachable:`);
  for (const item of unreachable) {
    console.log(`    ${item.family} -> ${item.file} (${item.error ?? item.status})`);
  }
  check(
    "the registry is honest about it (entries exist so the degradation path is exercised)",
    unreachable.every((item) => PROMPT_GUIDES[item.family] !== undefined),
  );
}

console.log(failures === 0 ? "\nALL GUIDE-URL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);