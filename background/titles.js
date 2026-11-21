import { titleFromHtml } from "../shared/titles.js";
import { savableUrl } from "../shared/model.js";

export async function fetchPageTitle(url) {
  if (!savableUrl(url)) return null;
  const pageUrl = new URL(url);
  // Chromium match patterns do not include ports; permission covers the hostname.
  try {
    if (!await chrome.permissions.contains({ origins: [`${pageUrl.protocol}//${pageUrl.hostname}/*`] })) return null;
  } catch { return null; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let reader;
  try {
    const response = await fetch(url, { credentials: "omit", signal: controller.signal, cache: "no-store" });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return null;
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let bytes = 0;
    while (bytes < 128 * 1024) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, 128 * 1024 - bytes);
      bytes += chunk.byteLength;
      html += decoder.decode(chunk, { stream: true });
      const title = titleFromHtml(html);
      if (title) return title;
      if (/<\/head\s*>/i.test(html)) break;
    }
    return titleFromHtml(html);
  } catch { return null; }
  finally { clearTimeout(timer); if (reader) await reader.cancel().catch(() => { }); }
}

export async function linkText(info, tab) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId || 0] },
      func: url => {
        const links = Array.from(document.querySelectorAll("a[href]"));
        const link = links.find(anchor => anchor.matches(":hover") && anchor.href === url) || links.find(anchor => anchor.href === url);
        return (link?.innerText || link?.getAttribute("aria-label") || link?.title || "").trim().slice(0, 1000);
      },
      args: [info.linkUrl],
    });
    return results[0]?.result || "";
  } catch { return ""; }
}
