import { savableTabUrl, tabSnapshot } from "../shared/model.js";
import { syncTabIndicator, syncGroupIndicator, replaceTitleMarker, removeTitleMarker, restoreGroupIndicators, restoreTabMarkerOwnership, registerIndicators } from "./indicators.js";

// Native tab/group IDs are valid for one browser session. Session storage survives
// service-worker suspension without applying old IDs to unrelated tabs on restart.
export const STARS_KEY = "tabDockStars";
let current;
let tail = Promise.resolve();
function exclusiveStars(task) {
  const operation = tail.then(task);
  tail = operation.catch(() => { });
  return operation;
}
async function readStars() {
  if (!current) {
    const value = (await chrome.storage.session.get(STARS_KEY))[STARS_KEY];
    const ids = values => [...new Set((values || []).filter(id => Number.isInteger(id) && id >= 0))];
    current = { tabIds: ids(value?.tabIds), groupIds: ids(value?.groupIds) };
  }
  return current;
}
async function writeStars(next) {
  await chrome.storage.session.set({ [STARS_KEY]: next });
  current = next;
}
function applies(stars, tab) {
  return stars.tabIds.includes(tab.id) || stars.groupIds.includes(tab.groupId);
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
async function discardInactive(stars, tabs) {
  const warnings = [];
  for (const candidate of tabs) {
    if (!applies(stars, candidate) || candidate.active || candidate.discarded) continue;
    let tab;
    try { tab = await chrome.tabs.get(candidate.id); } catch { continue; }
    if (!applies(stars, tab) || tab.active || tab.discarded) continue;
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
    const tabIds = stars.tabIds.filter(id => id !== tab.id);
    if (starred) tabIds.push(tab.id);
    const next = { ...stars, tabIds };
    await writeStars(next);
    const markedTab = await syncTabIndicator(tab, applies(next, tab));
    const updated = markedTab.id !== tab.id ? await remap(next, markedTab.id, tab.id) : next;
    const message = starred ? "Tab starred. It will discard when you switch away."
      : next.groupIds.includes(tab.groupId) ? "Individual star removed. This tab still follows its starred browser group." : "Tab unstarred.";
    return { message, ...(await discardInactive(updated, [markedTab])) };
  });
}
export function setGroupStar(tabId, starred) {
  return exclusiveStars(async () => {
    const tab = await selectedTab(tabId);
    if (!Number.isInteger(tab.groupId) || tab.groupId < 0) throw new Error("This tab is not in a browser group.");
    const group = await chrome.tabGroups.get(tab.groupId);
    const stars = await readStars();
    const groupIds = stars.groupIds.filter(id => id !== group.id);
    if (starred) groupIds.push(group.id);
    const next = { ...stars, groupIds };
    await writeStars(next);
    await syncGroupIndicator(group.id, starred);
    const tabs = await chrome.tabs.query({ groupId: group.id, windowId: group.windowId });
    let updated = next;
    const markedTabs = [];
    for (const member of tabs) {
      const markedTab = await syncTabIndicator(member, applies(updated, member));
      if (markedTab.id !== member.id) updated = await remap(updated, markedTab.id, member.id);
      markedTabs.push(markedTab);
    }
    return { message: starred ? "Browser group starred. Its inactive tabs will discard, including tabs added later." : "Browser group unstarred. Individually starred tabs keep their stars.", ...(await discardInactive(updated, markedTabs)) };
  });
}
export function enforceStars(windowId) {
  return exclusiveStars(async () => {
    const stars = await readStars();
    if (!stars.tabIds.length && !stars.groupIds.length) return { warnings: [] };
    return discardInactive(stars, await chrome.tabs.query(Number.isInteger(windowId) ? { windowId } : {}));
  });
}
export function enforceStarredTab(tabId) {
  return exclusiveStars(async () => {
    const stars = await readStars();
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return { warnings: [] }; }
    const marked = await syncTabIndicator(tab, applies(stars, tab));
    const updated = marked.id !== tab.id ? await remap(stars, marked.id, tab.id) : stars;
    return discardInactive(updated, [marked]);
  });
}
export function removeTabStar(tabId) {
  return exclusiveStars(async () => {
    const stars = await readStars();
    if (stars.tabIds.includes(tabId)) await writeStars({ ...stars, tabIds: stars.tabIds.filter(id => id !== tabId) });
    await removeTitleMarker(tabId);
  });
}
export function removeGroupStar(groupId) {
  return exclusiveStars(async () => {
    const stars = await readStars();
    if (stars.groupIds.includes(groupId)) await writeStars({ ...stars, groupIds: stars.groupIds.filter(id => id !== groupId) });
  });
}
export function replaceTabStar(addedTabId, removedTabId) {
  return exclusiveStars(async () => {
    await remap(await readStars(), addedTabId, removedTabId);
    await replaceTitleMarker(addedTabId, removedTabId);
  });
}
export function getTabStar(tabId) {
  return exclusiveStars(async () => {
    const tab = await chrome.tabs.get(tabId);
    return { starred: applies(await readStars(), tab) };
  });
}
export function refreshGroupIndicator(groupId) {
  return exclusiveStars(async () => syncGroupIndicator(groupId, (await readStars()).groupIds.includes(groupId)));
}
export function restoreStars() {
  return exclusiveStars(async () => {
    const stars = await readStars();
    await registerIndicators();
    await restoreGroupIndicators(stars);
    const tabs = await chrome.tabs.query({});
    await restoreTabMarkerOwnership(tabs);
    const next = { tabIds: stars.tabIds.filter(id => tabs.some(tab => tab.id === id)), groupIds: stars.groupIds.filter(id => tabs.some(tab => tab.groupId === id)) };
    await writeStars(next);
    let updated = next;
    const markedTabs = [];
    for (const tab of tabs) {
      const marked = await syncTabIndicator(tab, applies(updated, tab), { force: !tab.discarded });
      if (marked.id !== tab.id) updated = await remap(updated, marked.id, tab.id);
      markedTabs.push(marked);
    }
    return discardInactive(updated, markedTabs);
  });
}
