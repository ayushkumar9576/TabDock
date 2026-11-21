import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const css = readFileSync(new URL("../popup/popup.css", import.meta.url), "utf8");
const color = name => css.match(new RegExp(`--${name}:\\s*(#[\\da-f]{6})`, "i"))[1];
const rgb = value => value.match(/[\da-f]{2}/gi).map(channel => parseInt(channel, 16));
const luminance = value => rgb(value).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, i) => sum + channel * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => { const [high, low] = [luminance(a), luminance(b)].sort((a, b) => b - a); return (high + .05) / (low + .05); };
const checks = [];
for (const foreground of [color("text"), color("muted"), color("accent")]) for (const background of [color("bg"), color("surface"), "#edf1ee", "#eef3ef"]) {
  const ratio = contrast(foreground, background); assert.ok(ratio >= 4.5, `${foreground}/${background}: ${ratio}`); checks.push(ratio);
}
assert.ok(contrast(color("accent"), "#ffffff") >= 4.5);
assert.ok(contrast(color("accent"), color("surface")) >= 3);
assert.ok(!css.includes("prefers-color-scheme"));
console.log(`${checks.length} text contrast pairs pass WCAG AA; minimum ${Math.min(...checks).toFixed(2)}:1. Light-only styles and focus contrast pass.`);
