// Boot the plugin through the real Cordis Context + Loader from the DSH
// installation, with stub `tools` and `skills` services, and report what it
// registers.
//
// This proves the plugin applies under a real loader and resolves its declared
// `inject` dependencies the way the Host would — not just against a
// hand-written fake context.
//
// The plugin is resolved by installing a node_modules symlink named
// `dsh-comfyui-image`, which is exactly how the Host's module resolver finds
// a profile plugin.
//
// usage: <electron-as-node> <this-file> <dsh-node-modules-dir> <plugin-dir>

import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dshModules, pluginDir] = process.argv.slice(2);
if (!dshModules || !pluginDir) {
  console.error("usage: boot-check.mjs <dsh-node-modules-dir> <plugin-dir>");
  process.exit(2);
}

const url = (pkg, file) => pathToFileURL(join(dshModules, "@deepseek-ai", pkg, "lib", file)).href;
const { Context, Service } = await import(url("cordis", "index.js"));
const { Loader } = await import(url("cordis-plugin-loader", "index.js"));

const registered = { tools: [], skills: [] };

/**
 * Stand-ins for the Host services. A Cordis service publishes itself under its
 * `static provide` name, which is the key a plugin's `inject` resolves — so
 * declaring these as `tools` and `skills` is what makes the plugin's
 * `inject: ["tools", "skills"]` resolve for real.
 */
class Tools extends Service {
  static provide = "tools";
  register(definition) {
    registered.tools.push(definition);
    return () => {};
  }
}
class Skills extends Service {
  static provide = "skills";
  register(skill) {
    registered.skills.push(skill);
    return () => {};
  }
}

// Give the module resolver somewhere to find the plugin by its package name.
const sandbox = join(process.cwd(), ".boot-check");
const link = join(sandbox, "node_modules", "dsh-comfyui-image");
mkdirSync(join(sandbox, "node_modules"), { recursive: true });
try {
  symlinkSync(pluginDir, link, "junction");
} catch (error) {
  console.error("could not create the sandbox link:", error.message);
  process.exit(2);
}

const errors = [];
process.on("unhandledRejection", (error) => errors.push(error));

const ctx = new Context({ baseUrl: pathToFileURL(join(sandbox, "/")).href });
// Surface loader diagnostics: a silent pending fiber here means the module
// import failed, and the reason is the whole point of this check.
ctx.logger = console;
const loader = new Loader(ctx);
ctx.plugin(Tools);
ctx.plugin(Skills);
await loader.await();

// Entries are created from inside a plugin fiber; the loader attaches the new
// entry's fiber to that parent, which is what actually starts the plugin.
await ctx.plugin(async () => {
  await loader.root.create({ id: "comfyui-image", name: "dsh-comfyui-image" });
});
await loader.await();

const entry = loader.resolve("comfyui-image");
if (entry?.fiber?.uid === undefined) await entry.init();
await loader.await();
await new Promise((resolve) => setTimeout(resolve, 1500));
console.log("entry fiber state:", entry?.fiber?.state ?? "none");
console.log("tools registered:", registered.tools.map((t) => t.name).join(", ") || "(none)");
console.log("skills registered:", registered.skills.map((s) => s.name).join(", ") || "(none)");
for (const tool of registered.tools) {
  console.log(
    `  ${tool.name}: ${Object.keys(tool.parameters.properties).length} parameters, required=[${(tool.parameters.required ?? []).join(",")}]`,
  );
}
for (const skill of registered.skills) {
  console.log(`  skill ${skill.name}: ${skill.content.length} chars of instructions`);
}

if (errors.length > 0) console.log("async errors:", errors.map((e) => e.message).join(" | "));

try {
  rmSync(join(sandbox, "node_modules"), { recursive: true, force: true });
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  // A sandbox junction can survive rmSync on Windows; the temp dir is harmless.
}
const ok = registered.tools.length === 2 && registered.skills.length === 1 && entry?.fiber?.state === 2;
console.log(ok ? "BOOT CHECK PASSED" : "BOOT CHECK FAILED");
process.exit(ok ? 0 : 1);