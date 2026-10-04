/**
 * Mirror configuration checks.
 *
 * The point of this module is one thing: everything that fetches weights must
 * agree on where from. A URL printed to the user, a URL the plugin downloads,
 * and the endpoint a ComfyUI process resolves for itself are three code paths,
 * and if only one of them was redirected the user would still wait on
 * huggingface.co and conclude the mirror setting did nothing.
 */

import { spawnSync } from "node:child_process";
import { comfyEnv, DEFAULT_MIRROR, downloadUrl, mirrorEndpoint } from "../lib/mirror.js";

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` -- ${detail}`}`);
}

console.log("\n# endpoint resolution");
const savedHf = process.env.HF_ENDPOINT;
const savedDsh = process.env.DSH_HF_ENDPOINT;

delete process.env.HF_ENDPOINT;
delete process.env.DSH_HF_ENDPOINT;
check("defaults to the mirror", mirrorEndpoint() === DEFAULT_MIRROR, mirrorEndpoint());

process.env.HF_ENDPOINT = "https://huggingface.co";
check("respects a user-chosen origin", mirrorEndpoint() === "https://huggingface.co", mirrorEndpoint());

process.env.DSH_HF_ENDPOINT = "https://mirror.example.com/";
check("the plugin's own setting wins", mirrorEndpoint() === "https://mirror.example.com", mirrorEndpoint());
check("a trailing slash is trimmed", !mirrorEndpoint().endsWith("/"), mirrorEndpoint());

delete process.env.HF_ENDPOINT;
delete process.env.DSH_HF_ENDPOINT;

console.log("\n# URL building");
const url = downloadUrl("owner/repo", "split_files/vae/model.safetensors");
check("builds a resolve URL on the mirror", url === `${DEFAULT_MIRROR}/owner/repo/resolve/main/split_files/vae/model.safetensors`, url);
check("returns undefined without a repo", downloadUrl(undefined, "x") === undefined);
check("returns undefined without a path", downloadUrl("owner/repo", "") === undefined);
check("does not reach huggingface.co", url === undefined || !url.includes("huggingface.co"));

console.log("\n# child process environment");
const env = comfyEnv();
check("sets HF_ENDPOINT", env.HF_ENDPOINT === mirrorEndpoint(), env.HF_ENDPOINT);
check("keeps the interpreter's Path", env.Path !== undefined || env.PATH !== undefined);
check("keeps SystemRoot", env.SystemRoot !== undefined);
check("keeps the profile directory", env.DSH_PROFILE_DIR !== undefined);
check(
  "does not enable the Rust downloader the mirror cannot serve",
  env.HF_HUB_ENABLE_HF_TRANSFER === undefined,
  "hf_transfer targets the origin, not the mirror",
);
check("extra variables win", comfyEnv({ HF_ENDPOINT: "https://x.example" }).HF_ENDPOINT === "https://x.example");

console.log("\n# a real interpreter sees it");
// The point of the module is a Python process inheriting the variable; asserting
// it here catches a rename or a scope mistake that a JS-level check cannot.
const python = [
  process.env.LOCALAPPDATA === undefined
    ? undefined
    : `${process.env.LOCALAPPDATA}\\Comfy-Desktop\\ComfyUI-Installs\\Z-image\\ComfyUI\\.venv\\Scripts\\python.exe`,
  `${process.env.LOCALAPPDATA}\\Comfy-Desktop\\ComfyUI-Installs\\MiniMax H3\\ComfyUI\\.venv\\Scripts\\python.exe`,
].find((candidate) => {
  if (candidate === undefined) return false;
  try {
    return spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
});

if (python === undefined) {
  console.log("    (no ComfyUI interpreter found; skipped the process-level check)");
} else {
  const result = spawnSync(python, ["-c", "import os;print(os.environ.get('HF_ENDPOINT','<unset>'))"], {
    env: comfyEnv(),
    encoding: "utf8",
  });
  check(
    "a Python process launched with this env sees the mirror",
    result.stdout.trim() === mirrorEndpoint(),
    result.stdout.trim() || `exit ${result.status}`,
  );
}

if (savedHf !== undefined) process.env.HF_ENDPOINT = savedHf;
if (savedDsh !== undefined) process.env.DSH_HF_ENDPOINT = savedDsh;

console.log(failures === 0 ? "\nALL MIRROR CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);