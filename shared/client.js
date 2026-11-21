export async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ ...payload, type });
  if (!response?.ok) throw new Error(response?.error || "The extension did not respond. Try reopening it.");
  return response.data;
}

export function faviconUrl(url, size = 32) {
  const result = new URL(chrome.runtime.getURL("_favicon/"));
  result.searchParams.set("pageUrl", url);
  result.searchParams.set("size", String(size));
  return result.href;
}
