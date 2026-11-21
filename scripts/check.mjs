import { readdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
function walk(path) { return readdirSync(path, { withFileTypes: true }).flatMap(item => item.isDirectory() && ![".git", "node_modules", ".browser-test"].includes(item.name) ? walk(join(path, item.name)) : item.isFile() ? [join(path, item.name)] : []); }
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
let failures = 0;
for (const file of walk(root.pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  if (!/\.(m?js)$/.test(file)) continue;
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) { console.error(result.stderr); failures++; }
}
for (const path of [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons), "assets/fonts/dm-sans-latin-variable.woff2", "assets/fonts/OFL.txt", "assets/icons/lucide.svg", "assets/icons/LICENSE.txt"].filter(Boolean)) {
  if (!existsSync(new URL(path, root))) { console.error(`Missing manifest resource: ${path}`); failures++; }
}
if (manifest.manifest_version !== 3) failures++;
console.log(failures ? `${failures} check(s) failed.` : "JavaScript syntax and manifest resources passed.");
process.exitCode = failures ? 1 : 0;
