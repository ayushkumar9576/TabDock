import { lazyUrl, parseLazyUrl, savableTabUrl, findGroup, findLink, cleanLooseTabs } from "../shared/model.js";
import { writeState } from "../shared/storage.js";
export const LAZY_BASE = chrome.runtime.getURL("pages/lazy.html");

export async function activateLazy(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return false; }
  const link = parseLazyUrl(tab.pendingUrl || tab.url, LAZY_BASE);
  if (!link || !tab.active) return false;
  await chrome.tabs.update(tabId, { url: link.url });
  return true;
}

export async function resolveWindow(windowId) {
  if (Number.isInteger(windowId)) {
    try {
      const window = await chrome.windows.get(windowId);
      if (window.type === "normal") return windowId;
    } catch { /* The original window may have closed since parking. */ }
  }
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const target = windows.find(window => window.focused) || windows[0];
  if (target) return target.id;
  return (await chrome.windows.create({ url: "about:blank" })).id;
}

export async function createSavedTab(link, { windowId, deferred = false, active = false, index } = {}) {
  if (!savableTabUrl(link.url)) throw new Error("This saved URL cannot be opened.");
  let tab = await chrome.tabs.create({
    windowId, url: deferred ? lazyUrl(LAZY_BASE, link) : link.url,
    active, pinned: Boolean(link.pinned), ...(Number.isInteger(index) ? { index } : {}),
  });
  let warning;
  if (deferred) {
    // Let the local document set its original title and cached favicon before discarding it.
    // This never requests the target website.
    await placeholderReady(tab.id);
    // Brave can replace the tab ID on discard. Always use the returned Tab object.
    try { tab = await chrome.tabs.discard(tab.id) || tab; }
    catch { warning = "Some deferred placeholders could not be discarded; their target pages will still wait until selected."; }
  }
  return { tab, warning };
}

export function placeholderReady(tabId) {
  return new Promise(resolve => {
    let timer;
    const finish = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (updatedId, changes) => { if (updatedId === tabId && changes.status === "complete") finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(finish, 1500);
    chrome.tabs.get(tabId).then(tab => { if (tab.status === "complete") finish(); }).catch(finish);
  });
}

export async function openGroup(group, options = {}) {
  if (!group.links.length) throw new Error("This group has no saved links.");
  const windowId = await resolveWindow(options.windowId);
  const created = [];
  const openedLinkIds = [];
  const warnings = [];
  // Every restored tab starts at a local placeholder and stays in the background.
  for (let i = 0; i < group.links.length; i++) {
    try {
      const result = await createSavedTab(group.links[i], { windowId, deferred: true, active: false });
      created.push(result.tab);
      openedLinkIds.push(group.links[i].id);
      if (result.warning) warnings.push(result.warning);
    } catch (error) { warnings.push(`Could not open “${group.links[i].title}”: ${error.message}`); }
  }
  const unpinned = created.filter(tab => !tab.pinned);
  let nativeGroupId;
  if (unpinned.length) {
    try {
      nativeGroupId = await chrome.tabs.group({ tabIds: unpinned.map(tab => tab.id), createProperties: { windowId } });
      await chrome.tabGroups.update(nativeGroupId, { title: group.nativeTitle ?? group.name, color: group.color, collapsed: group.collapsed });
    } catch (error) { warnings.push(`Tabs opened, but native grouping failed: ${error.message}`); }
  }
  if (created.some(tab => tab.pinned)) warnings.push("Pinned tabs were restored in the pinned area, as required by Chromium.");
  return { tabIds: created.map(tab => tab.id), openedLinkIds, nativeGroupId, warnings: [...new Set(warnings)] };
}

export async function openSavedLink(state, groupId, linkId, options = {}) {
  const { group, link } = findLink(state, groupId, linkId);
  const windowId = await resolveWindow(options.windowId);
  // Capture the active tab's group before creating or discarding the placeholder.
  const [activeTab] = await chrome.tabs.query({ windowId, active: true });
  const result = await createSavedTab(link, { windowId, deferred: true, active: false });
  const warnings = result.warning ? [result.warning] : [];
  if (Number.isInteger(activeTab?.groupId) && activeTab.groupId >= 0) {
    if (result.tab.pinned) warnings.push("Pinned tabs were restored in the pinned area, as required by Chromium.");
    else {
      try {
        await chrome.tabs.group({ tabIds: [result.tab.id], groupId: activeTab.groupId });
      } catch (error) { warnings.push(`Tab opened, but adding it to the current browser group failed: ${error.message}`); }
    }
  }
  if (options.remove ?? state.settings?.removeAfterOpen) {
    group.links = group.links.filter(item => item.id !== link.id);
    cleanLooseTabs(state);
    await writeState(state);
  }
  return { tabIds: [result.tab.id], openedLinkIds: [link.id], warnings };
}

export async function openSavedGroup(state, groupId, options = {}) {
  const group = findGroup(state, groupId);
  const result = await openGroup(group, options);
  if ((options.remove ?? state.settings?.removeAfterOpen) && result.openedLinkIds.length) {
    // Keep saved copies of pages the browser could not create.
    const opened = new Set(result.openedLinkIds);
    group.links = group.links.filter(link => !opened.has(link.id));
    if (!group.links.length) state.groups = state.groups.filter(item => item.id !== group.id);
    cleanLooseTabs(state);
    await writeState(state);
  }
  return result;
}
