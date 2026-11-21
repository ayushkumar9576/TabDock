import { parseLazyUrl } from "../shared/model.js";
import { faviconUrl, request } from "../shared/client.js";
import { icon } from "../shared/icons.js";
document.querySelector(".mark").append(icon("archive"));
const link = parseLazyUrl(location.href, chrome.runtime.getURL("pages/lazy.html"));
if (link) {
  document.title = link.title;
  document.querySelector("#title").textContent = link.title;
  const icon = document.createElement("link");
  icon.rel = "icon"; icon.href = faviconUrl(link.url); document.head.append(icon);
  const load = async () => {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.active) await request("ACTIVATE_LAZY", { tabId: tab.id });
    } catch {
      document.querySelector("#message").textContent = "Click Load page to try again. Keep TabDock enabled while these deferred tabs are open.";
    }
  };
  document.querySelector("#open").addEventListener("click", load);
  load();
} else {
  document.querySelector("#message").textContent = "This placeholder has no valid saved URL.";
  document.querySelector("#open").disabled = true;
}
