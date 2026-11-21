// Lucide 0.468.0, bundled as a local SVG sprite. See assets/icons/LICENSE.txt.
export function icon(name, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  if (className) svg.classList.add(className);
  for (const [key, value] of Object.entries({ width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(key, value);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `${chrome.runtime.getURL("assets/icons/lucide.svg")}#${name}`);
  svg.append(use);
  return svg;
}
