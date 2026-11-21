import { lazyUrl, parseLazyUrl, savableUrl } from "../shared/model.js";
import { placeholderReady } from "./open.js";

const TAB_KEY = "tabDockTitleMarkers";
const GROUP_KEY = "tabDockGroupMarkers";
const TAB_BACKUP_KEY = "tabDockTitleMarkerOwnership";
const SCRIPT_ID = "tabdock-star-indicator";
export const INDICATOR_ORIGINS = ["http://*/*", "https://*/*"];
let tail = Promise.resolve();
function exclusive(task) {
  const operation = tail.then(task); tail = operation.catch(() => { }); return operation;
}
const tabMarkers = async () => (await chrome.storage.session.get(TAB_KEY))[TAB_KEY] || {};
const groupMarkers = async () => (await chrome.storage.local.get(GROUP_KEY))[GROUP_KEY] || {};
async function writeTabMarkers(markers) {
  await chrome.storage.session.set({ [TAB_KEY]: markers });
  // Ownership is durable so stale symbols can be removed when session stars reset.
  await chrome.storage.local.set({ [TAB_BACKUP_KEY]: markers });
}
async function pageAccess(url) {
  if (!savableUrl(url) || !chrome.permissions?.contains) return false;
  const page = new URL(url);
  return chrome.permissions.contains({ origins: [`${page.protocol}//${page.hostname}/*`] });
}
export function registerIndicators() {
  return exclusive(async () => {
    if (!chrome.scripting?.registerContentScripts) return;
    if (!await chrome.permissions.contains({ origins: INDICATOR_ORIGINS })) return;
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    if (!registered.length) await chrome.scripting.registerContentScripts([{ id: SCRIPT_ID, matches: INDICATOR_ORIGINS, js: ["content/star-indicator.js"], runAt: "document_idle" }]);
  });
}
export async function requestIndicatorAccess() {
  if (!chrome.permissions?.request) return false;
  // Call from the context-menu gesture. Granted access is not requested again.
  const granted = await chrome.permissions.request({ origins: INDICATOR_ORIGINS });
  if (granted) await registerIndicators();
  return granted;
}
export function rememberTabTitle(tabId, title) {
  return exclusive(async () => {
    const markers = await tabMarkers();
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    markers[tabId] = { title, displayed: `★ ${title}`, url: tab.pendingUrl || tab.url };
    await writeTabMarkers(markers);
  });
}
export function replaceTitleMarker(addedId, removedId) {
  return exclusive(async () => {
    const markers = await tabMarkers();
    if (markers[removedId]) {
      markers[addedId] = markers[removedId]; delete markers[removedId];
      await writeTabMarkers(markers);
    }
  });
}
export function removeTitleMarker(tabId) {
  return exclusive(async () => {
    const markers = await tabMarkers();
    if (markers[tabId]) { delete markers[tabId]; await writeTabMarkers(markers); }
  });
}
export async function cleanBrowserTabs(tabs) {
  const markers = await tabMarkers();
  return tabs.map(tab => {
    const marker = markers[tab.id];
    return marker && tab.title === marker.displayed ? { ...tab, title: marker.title } : tab;
  });
}
export async function cleanBrowserGroup(group) {
  const marker = (await groupMarkers())[group.id];
  return marker && group.title === marker.displayed ? { ...group, title: marker.title } : group;
}
export function restoreTabMarkerOwnership(tabs) {
  return exclusive(async () => {
    const markers = Object.fromEntries(Object.entries(await tabMarkers()).filter(([id]) => tabs.some(tab => tab.id === Number(id))));
    const backup = (await chrome.storage.local.get(TAB_BACKUP_KEY))[TAB_BACKUP_KEY] || {};
    for (const tab of tabs) {
      const owned = backup[tab.id] || Object.values(backup).find(marker => marker.url === tab.url && marker.displayed === tab.title);
      if (owned && tab.title === owned.displayed && owned.url === tab.url) markers[tab.id] = owned;
    }
    await writeTabMarkers(markers);
  });
}
export function syncGroupIndicator(groupId, starred) {
  return exclusive(async () => {
    let group;
    try { group = await chrome.tabGroups.get(groupId); } catch { return; }
    const markers = await groupMarkers(), previous = markers[groupId];
    const title = previous && group.title.startsWith("★ ") ? group.title.slice(2) : group.title;
    const displayed = starred ? `★ ${title}` : title;
    if (group.title !== displayed) await chrome.tabGroups.update(groupId, { title: displayed });
    if (starred) markers[groupId] = { title, displayed };
    else delete markers[groupId];
    if (starred || previous) await chrome.storage.local.set({ [GROUP_KEY]: markers });
  });
}
export function restoreGroupIndicators(stars) {
  return exclusive(async () => {
    if (!chrome.tabGroups.query) return;
    const markers = await groupMarkers();
    const groups = await chrome.tabGroups.query({});
    for (const group of groups) {
      if (stars.groupIds.includes(group.id)) continue;
      // Local ownership records also remove stale symbols after a browser restart.
      const owned = markers[group.id] || Object.values(markers).find(marker => marker.displayed === group.title);
      if (owned && group.title === owned.displayed) await chrome.tabGroups.update(group.id, { title: owned.title });
    }
    const live = Object.fromEntries(Object.entries(markers).filter(([id]) => stars.groupIds.includes(Number(id))));
    await chrome.storage.local.set({ [GROUP_KEY]: live });
  });
}
export function syncTabIndicator(candidate, starred, { force = false } = {}) {
  return exclusive(async () => {
    let tab;
    try { tab = await chrome.tabs.get(candidate.id); } catch { return candidate; }
    const markers = await tabMarkers(), previous = markers[tab.id];
    const base = chrome.runtime.getURL("pages/lazy.html"), lazy = parseLazyUrl(tab.pendingUrl || tab.url, base);
    if (tab.discarded) {
      const marked = Boolean(previous);
      const lazyStar = lazy && new URLSearchParams(new URL(tab.url).hash.slice(1)).get("star") === "1";
      if (Boolean(lazy ? lazyStar : marked) === starred) return tab;
      if (!starred && !previous && !lazyStar) return tab;
      const link = lazy || { url: tab.url, title: previous?.title || tab.title, favicon: tab.favIconUrl };
      if (!link.url || !parseLazyUrl(lazyUrl(base, link), base)) return tab;
      const url = `${lazyUrl(base, link)}${starred ? "&star=1" : ""}`;
      tab = await chrome.tabs.update(tab.id, { url });
      await placeholderReady(tab.id);
      const oldId = tab.id;
      try { tab = await chrome.tabs.discard(tab.id) || tab; } catch { /* A local placeholder remains lightweight. */ }
      delete markers[candidate.id]; delete markers[oldId];
      if (starred) markers[tab.id] = { title: link.title, displayed: `★ ${link.title}`, url: tab.url };
      await writeTabMarkers(markers);
      return tab;
    }
    if (!starred && !previous && !force) return tab;
    try {
      let result;
      try { result = await chrome.tabs.sendMessage(tab.id, { type: "SET_TAB_STAR_INDICATOR", starred }); }
      catch {
        if (!await pageAccess(tab.pendingUrl || tab.url)) return tab;
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/star-indicator.js"] });
        result = await chrome.tabs.sendMessage(tab.id, { type: "SET_TAB_STAR_INDICATOR", starred });
      }
      if (starred) markers[tab.id] = { ...result, url: tab.pendingUrl || tab.url };
      else delete markers[tab.id];
      await writeTabMarkers(markers);
      return await chrome.tabs.get(tab.id);
    } catch { return tab; } // Navigation can remove the frame while its title is updated.
  });
}
