// Bundle the font and an audited Lucide icon subset. Nothing is fetched at runtime.
import { mkdirSync, writeFileSync } from "node:fs";
const fontVersion = "5.2.8";
const iconVersion = "0.468.0";
const names = ["archive", "folder", "folder-open", "folder-down", "plus", "search", "chevron-right", "ellipsis", "external-link", "arrow-right-left", "x", "arrow-up", "arrow-down", "pencil", "trash-2", "pin", "check", "undo-2", "sun-moon", "refresh-cw", "panel-top", "rows-3", "inbox", "globe"];
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Asset download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
const assets = await Promise.all([
  download(`https://cdn.jsdelivr.net/npm/@fontsource-variable/dm-sans@${fontVersion}/files/dm-sans-latin-wght-normal.woff2`),
  download(`https://cdn.jsdelivr.net/npm/@fontsource-variable/dm-sans@${fontVersion}/LICENSE`),
  download(`https://cdn.jsdelivr.net/npm/lucide-static@${iconVersion}/LICENSE`),
  ...names.map(name => download(`https://cdn.jsdelivr.net/npm/lucide-static@${iconVersion}/icons/${name}.svg`)),
]);
if (assets[0].subarray(0, 4).toString() !== "wOF2") throw new Error("Invalid WOFF2 font.");
const symbols = names.map((name, index) => {
  const svg = assets[index + 3].toString();
  const body = svg.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/)?.[1];
  if (!body || /<script\b|onload=/i.test(body)) throw new Error(`Invalid icon: ${name}`);
  return `<symbol id="${name}" viewBox="0 0 24 24">${body}</symbol>`;
});
mkdirSync(new URL("../assets/fonts/", import.meta.url), { recursive: true });
mkdirSync(new URL("../assets/icons/", import.meta.url), { recursive: true });
writeFileSync(new URL("../assets/fonts/dm-sans-latin-variable.woff2", import.meta.url), assets[0]);
writeFileSync(new URL("../assets/fonts/OFL.txt", import.meta.url), assets[1]);
writeFileSync(new URL("../assets/icons/LICENSE.txt", import.meta.url), assets[2]);
writeFileSync(new URL("../assets/icons/lucide.svg", import.meta.url), `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join("\n")}</svg>\n`);
console.log(`Bundled DM Sans ${fontVersion} and ${names.length} Lucide ${iconVersion} icons with licenses.`);
