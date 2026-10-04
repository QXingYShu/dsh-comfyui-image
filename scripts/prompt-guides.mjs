/**
 * Prompt-guide checks.
 *
 * The guides are fetched rather than bundled, so these assert the parts that
 * would otherwise only fail on a user's machine: the URLs resolve through the
 * mirror, the cache keeps a second call off the network, and a model without a
 * guide degrades to the local hints instead of erroring.
 */

import { PROMPT_GUIDES, guideUrl, loadPromptGuide } from "../lib/prompt-guides.js";
import { mirrorEndpoint } from "../lib/mirror.js";

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` -- ${detail}`}`);
}

/** Somewhere writable that is not the workspace under test. */
const exec = { agent: { session: { header: { cwd: process.env.TEMP ?? process.cwd() } } } };

console.log("\n# registry");
check("some guides are registered", Object.keys(PROMPT_GUIDES).length > 0);
check(
  "every entry names a repository",
  Object.values(PROMPT_GUIDES).every((guide) => typeof guide.repo === "string" && guide.repo.includes("/")),
);
check(
  "every entry names at least one file",
  Object.values(PROMPT_GUIDES).every((guide) => Array.isArray(guide.files) && guide.files.length > 0),
);
check(
  "MiniMax H3 registers both of its official guides",
  PROMPT_GUIDES["MiniMax H3"].files.length === 2,
  `${PROMPT_GUIDES["MiniMax H3"].files.length}`,
);

console.log("\n# URL building goes through the mirror");
const url = guideUrl(PROMPT_GUIDES["MiniMax H3"], { path: "docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md" });
check("uses the configured endpoint", url.startsWith(mirrorEndpoint()), url);
check("does not reach huggingface.co", !url.includes("huggingface.co"), url);
check("uses resolve/main", url.includes("/resolve/main/"), url);

console.log("\n# an unregistered model degrades");
const unknown = await loadPromptGuide("Definitely Not A Real Model", { exec });
check("reports unavailable rather than throwing", unknown.available === false);
check("says why", typeof unknown.reason === "string" && unknown.reason.length > 0, unknown.reason);
check("returns no documents", unknown.documents.length === 0);

console.log("\n# a registered model fetches");
const h3 = await loadPromptGuide("MiniMax H3", { exec });
if (h3.available) {
  check("both guides arrived", h3.documents.length === 2, `${h3.documents.length}`);
  check(
    "they carry real content",
    h3.documents.every((doc) => typeof doc.text === "string" && doc.text.length > 1000),
    h3.documents.map((doc) => doc.text?.length ?? "none").join(","),
  );
  check(
    "the base guide is structured, not prose",
    h3.documents.some((doc) => /^#{1,3} /m.test(doc.text)),
    "no headings found",
  );
  check(
    "each document cites where it came from",
    h3.documents.every((doc) => typeof doc.url === "string" && doc.url.includes(mirrorEndpoint())),
  );

  console.log("\n# the second call is served from cache");
  const started = Date.now();
  const again = await loadPromptGuide("MiniMax H3", { exec });
  const elapsed = Date.now() - started;
  check("still available", again.available === true);
  check("served from cache", again.documents.every((doc) => doc.cached === true));
  check("and it was fast", elapsed < 2000, `${elapsed}ms`);
} else {
  console.log(`    (guide unreachable from here: ${h3.reason} — URL construction still checked above)`);
}

console.log(failures === 0 ? "\nALL PROMPT-GUIDE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);