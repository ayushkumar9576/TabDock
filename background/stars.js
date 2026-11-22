import { savableTabUrl, tabSnapshot } from "../shared/model.js";
import { readSettings } from "../shared/storage.js";
import { StarPersistence } from "./star-persistence.js";
import { syncTabIndicator, syncGroupIndicator, replaceTitleMarker, removeTitleMarker, restoreGroupIndicators, restoreTabMarkerOwnership, registerIndicators } from "./indicators.js";

// Session IDs serve live events; compact local records rebind them after restart.
export const STARS_KEY = "tabDockStars";
const persistence = new StarPersistence();
let current;
let tail = Promise.resolve();
function exclusiveStars(task) {
  const operation = tail.then(task);
  tail = operation.then(() => { }, () => { });
  return operation;
}
async function readStars() {
  if (!current) {
    const value = (await chrome.storage.session.get(STARS_KEY))[STARS_KEY];
    await persistence.load(value);
    const ids = values => [...new Set((values || []).filter(id => Number.isInteger(id) && id >= 0))];
    current = { tabIds: ids(value?.tabIds), groupIds: ids(value?.groupIds) };
    if (!value && persistence.needsRestore()) await restorePending(current);
  }
  return current;
}
async function writeStars(next, options) {
  await persistence.capture(next, current || next, options);
  await chrome.storage.session.set({ [STARS_KEY]: persistence.session(next) });
  current = next;
}
async function restorePending(stars, suppliedTabs) {
  if (!persistence.needsRestore()) return stars;
  const tabs = suppliedTabs || await chrome.tabs.query({});
  const next = await persistence.restore(stars, tabs);
  await persistence.capture(next, stars, { preserveRemoved: true, tabs });
  await chrome.storage.session.set({ [STARS_KEY]: persistence.session(next) });
  current = next;
  return next;
}
async function allTabsStarred() {
  return (await readSettings()).starAllTabs;
}
export async function initializeStars() {
  if (!(await chrome.storage.session.get("tabDockStarsInitialized")).tabDockStarsInitialized) return restoreStars();
}
export function needsTabUpdates() {
  return exclusiveStars(async () => {
    const stars = await readStars();
    return Boolean(stars.tabIds.length || stars.groupIds.length || persistence.needsRestore() || await allTabsStarred());
  });
}
function applies(stars, tab, starAllTabs = false) {
  return stars.tabIds.includes(tab.id) || stars.groupIds.includes(tab.groupId) ||
    (starAllTabs && Boolean(savableTabUrl(tabSnapshot(tab, chrome.runtime.getURL("pages/lazy.html")).url)));
}
async function selectedTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if ((await chrome.windows.get(tab.windowId)).type !== "normal") throw new Error("Choose a tab in a normal browser window.");
  return tab;
}
async function remap(stars, addedTabId, removedTabId) {
  if (!stars.tabIds.includes(removedTabId)) return stars;
  const next = { ...stars, tabIds: [...new Set(stars.tabIds.map(id => id === removedTabId ? addedTabId : id))] };
  await writeStars(next);
  return next;
}
async function discardInactive(stars, tabs, starAllTabs = false) {
  const warnings = [];
  for (const candidate of tabs) {
    if (!applies(stars, candidate, starAllTabs) || candidate.active || candidate.discarded) continue;
    let tab;
    try { tab = await chrome.tabs.get(candidate.id); } catch { continue; }
    if (!applies(stars, tab, starAllTabs) || tab.active || tab.discarded) continue;
    const oldId = tab.id;
    tab = await syncTabIndicator(tab, true);
    if (tab.id !== oldId) stars = await remap(stars, tab.id, oldId);
    if (tab.active || tab.discarded) continue;
    // Browser/extension internal pages do not support normal page discarding.
    if (!savableTabUrl(tabSnapshot(tab, chrome.runtime.getURL("pages/lazy.html")).url)) continue;
    let discarded;
    try { discarded = await chrome.tabs.discard(tab.id); }
    catch (error) {
      let latest;
      try { latest = await chrome.tabs.get(tab.id); } catch { continue; }
      if (!latest.active && !latest.discarded) warnings.push(`Could not discard starred tab "${tab.title || "Untitled"}": ${error.message}`);
      continue;
    }
    // Brave sometimes replaces IDs during discard.
    if (discarded && discarded.id !== tab.id) {
      stars = await remap(stars, discarded.id, tab.id);
      await replaceTitleMarker(discarded.id, tab.id);
    }
  }
  return { warnings };
}

export function getStars() {
  return exclusiveStars(async () => structuredClone(await readStars()));
}
export function setTabStar(tabId, starred) {
  return exclusiveStars(async () => {
    const tab = await selectedTab(tabId);
    if (starred && !savableTabUrl(tabSnapshot(tab, chrome.runtime.getURL("pages/lazy.html")).url)) throw new Error("Only web pages, New Tab, and blank tabs can be starred.");
    const stars = await readStars();
    const starAllTabs = await allTabsStarred();
    const tabIds = stars.tabIds.filter(id => id !== tab.id);
    if (starred) tabIds.push(tab.id);
    const next = { ...stars, tabIds };
    await writeStars(next);
    const markedTab = await syncTabIndicator(tab, applies(next, tab, starAllTabs));
    const updated = markedTab.id !== tab.id ? await remap(next, markedTab.id, tab.id) : next;
    const message = starred ? "Tab starred. It will discard when you switch away."
      : starAllTabs ? "Individual star removed. This tab still follows Star all browser tabs."
      : next.groupIds.includes(tab.groupId) ? "Individual star removed. This tab still follows its starred browser group." : "Tab unstarred.";
    return { message, ...(await discardInactive(updated, [markedTab], starAllTabs)) };
  });
}
export function setGroupStar(tabId, starred) {
  return exclusiveStars(async () => {
    const tab = await selectedTab(tabId);
    if (!Number.isInteger(tab.groupId) || tab.groupId < 0) throw new Error("This tab is not in a browser group.");
    const group = await chrome.tabGroups.get(tab.groupId);
    const stars = await readStars();
    const starAllTabs = await allTabsStarred();
    const groupIds = stars.groupIds.filter(id => id !== group.id);
    if (starred) groupIds.push(group.id);
    const next = { ...stars, groupIds };
    await writeStars(next);
    await syncGroupIndicator(group.id, starred);
    const tabs = await chrome.tabs.query({ groupId: group.id, windowId: group.windowId });
    let updated = next;
    const markedTabs = [];
    for (const member of tabs) {
      const markedTab = await syncTabIndicator(member, applies(updated, member, starAllTabs));
      if (markedTab.id !== member.id) updated = await remap(updated, markedTab.id, member.id);
      markedTabs.push(markedTab);
    }
    const message = starred ? "Browser group starred. Its inactive tabs will discard, including tabs added later."
      : starAllTabs ? "Browser group unstarred. Its tabs still follow Star all browser tabs."
      : "Browser group unstarred. Individually starred tabs keep their stars.";
    return { message, ...(await discardInactive(updated, markedTabs, starAllTabs)) };
  });
}
export function enforceStars(windowId) {
  return exclusiveStars(async () => {
    const stars = await readStars();
    const starAllTabs = await allTabsStarred();
    if (!starAllTabs && !stars.tabIds.length && !stars.groupIds.length) return { warnings: [] };
    return discardInactive(stars, await chrome.tabs.query(Number.isInteger(windowId) ? { windowId } : {}), starAllTabs);
  });
}
export function enforceStarredTab(tabId, { persist = false } = {}) {
  return exclusiveStars(async () => {
    let stars = await readStars();
    const starAllTabs = await allTabsStarred();
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return { warnings: [] }; }
    if (persistence.needsRestore(tab)) stars = await restorePending(stars);
    const marked = await syncTabIndicator(tab, applies(stars, tab, starAllTabs));
    const updated = marked.id !== tab.id ? await remap(stars, marked.id, tab.id) : stars;
    if (persist && persistence.affectsTab(tabId, marked, updated)) await persistence.capture(updated);
    return discardInactive(updated, [marked], starAllTabs);
  });
}
export function removeTabStar(tabId, { isWindowClosing = false, windowId } = {}) {
  return exclusiveStars(async () => {
    const stars = await readStars();
    if (isWindowClosing) persistence.windowClosing(windowId);
    if (stars.tabIds.includes(tabId)) await writeStars({ ...stars, tabIds: stars.tabIds.filter(id => id !== tabId) }, { preserveRemoved: isWindowClosing });
    else if (!isWindowClosing && persistence.affectsTab(tabId, null, stars)) await persistence.capture(stars);
    if (!isWindowClosing) await removeTitleMarker(tabId);
  });
}
export function removeGroupStar(groupId, windowId) {
  return exclusiveStars(async () => {
    const stars = await readStars();
    if (!stars.groupIds.includes(groupId)) return;
    let closing = persistence.closingWindows.has(windowId);
    if (Number.isInteger(windowId) && !closing) {
      try { await chrome.windows.get(windowId); } catch { closing = true; }
    }
    await writeStars({ ...stars, groupIds: stars.groupIds.filter(id => id !== groupId) }, { preserveRemoved: closing });
  });
}
export function replaceTabStar(addedTabId, removedTabId) {
  return exclusiveStars(async () => {
    await remap(await readStars(), addedTabId, removedTabId);
    await replaceTitleMarker(addedTabId, removedTabId);
    const stars = await readStars();
    if (persistence.affectsTab(removedTabId, null, stars)) await persistence.capture(stars);
  });
}
export function getTabStar(tabId) {
  return exclusiveStars(async () => {
    const tab = await chrome.tabs.get(tabId);
    let stars = await readStars();
    if (persistence.needsRestore(tab)) stars = await restorePending(stars);
    return { starred: applies(stars, tab, await allTabsStarred()) };
  });
}
export function refreshGroupIndicator(groupId) {
  return exclusiveStars(async () => {
    let stars = await readStars();
    const before = stars.groupIds.includes(groupId);
    if (persistence.pendingGroups.size) stars = await restorePending(stars);
    const starred = stars.groupIds.includes(groupId);
    if (!before && starred) await restoreGroupIndicators(stars);
    await syncGroupIndicator(groupId, starred);
    if (starred) await persistence.capture(stars);
    if (!before && starred) return discardInactive(stars, await chrome.tabs.query({ groupId }), await allTabsStarred());
  });
}
export function refreshStarPersistence(tabId) {
  return exclusiveStars(async () => {
    const stars = await readStars();
    if (!stars.tabIds.length && !stars.groupIds.length) return;
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    if (persistence.affectsTab(tabId, tab, stars)) await persistence.capture(stars);
  });
}
export function restoreStars() {
  return exclusiveStars(async () => {
    let stars = await readStars();
    const starAllTabs = await allTabsStarred();
    await registerIndicators();
    const tabs = await chrome.tabs.query({});
    stars = await restorePending(stars, tabs);
    await restoreGroupIndicators(stars);
    for (const groupId of stars.groupIds) await syncGroupIndicator(groupId, true);
    await restoreTabMarkerOwnership(tabs, tabs.filter(tab => applies(stars, tab, starAllTabs)).map(tab => tab.id));
    const next = { tabIds: stars.tabIds.filter(id => tabs.some(tab => tab.id === id)), groupIds: stars.groupIds.filter(id => tabs.some(tab => tab.groupId === id)) };
    await writeStars(next);
    let updated = next;
    const markedTabs = [];
    for (const tab of tabs) {
      const marked = await syncTabIndicator(tab, applies(updated, tab, starAllTabs));
      if (marked.id !== tab.id) updated = await remap(updated, marked.id, tab.id);
      markedTabs.push(marked);
    }
    const result = await discardInactive(updated, markedTabs, starAllTabs);
    await chrome.storage.session.set({ tabDockStarsInitialized: true });
    return result;
  });
}
