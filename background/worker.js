import { COLORS, makeGroup, findGroup, findLink, moveLink, moveEntry, ungroupLink, groupLink, cleanLooseTabs, reindex, sortGroups, tabSnapshot, savableUrl, savableTabUrl } from "../shared/model.js";
import { readState, writeState, exclusive } from "../shared/storage.js";
import { rebuildMenus } from "./menus.js";
import { fetchPageTitle, linkText } from "./titles.js";
import { openSavedGroup, openSavedLink, activateLazy, LAZY_BASE } from "./open.js";
import { prepareMove, commitMove, undoMove } from "./moves.js";
import { savePage, saveBrowserGroup } from "./save.js";
import { getStars, setTabStar, setGroupStar, getTabStar, refreshGroupIndicator, enforceStars, enforceStarredTab, removeTabStar, removeGroupStar, replaceTabStar, restoreStars } from "./stars.js";
import { requestIndicatorAccess, rememberTabTitle, cleanBrowserTabs, registerIndicators } from "./indicators.js";

async function notice(message) {
  await chrome.storage.local.set({ tabHarborNotice: message });
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setBadgeBackgroundColor({ color: "#A63619" });
}
function report(error) { console.error("TabDock:", error); return notice(error.message || String(error)).catch(console.error); }

async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error("Unauthorized message.");
  if (message.type === "GET_TAB_STAR") {
    if (!sender.tab) throw new Error("This action requires a browser tab.");
    return getTabStar(sender.tab.id);
  }
  if (message.type === "STAR_TITLE") {
    if (!sender.tab || typeof message.title !== "string") throw new Error("Invalid tab title.");
    return rememberTabTitle(sender.tab.id, message.title.slice(0, 1000));
  }
  if (message.type === "GET_STARS") return getStars();
  if (["STAR_TAB", "STAR_BROWSER_GROUP"].includes(message.type)) {
    if (typeof message.starred !== "boolean") throw new Error("Choose whether to star or unstar.");
    return message.type === "STAR_TAB" ? setTabStar(message.tabId, message.starred) : setGroupStar(message.tabId, message.starred);
  }
  if (message.type === "ACTIVATE_LAZY") {
    if (sender.tab && sender.tab.id !== message.tabId) throw new Error("A placeholder can only activate its own tab.");
    return activateLazy(message.tabId);
  }
  const state = await readState();
  switch (message.type) {
    case "GET_STATE": return { version: state.version, groups: sortGroups(state.groups), undo: state.undo, settings: state.settings };
    case "UPDATE_SETTINGS": {
      const preferences = ["removeAfterOpen", "includeNewTabs"].filter(key => message[key] !== undefined);
      if (!preferences.length || preferences.some(key => typeof message[key] !== "boolean")) throw new Error("Choose a valid setting.");
      for (const key of preferences) state.settings[key] = message[key];
      break;
    }
    case "GET_NOTICE": {
      const { tabHarborNotice } = await chrome.storage.local.get("tabHarborNotice");
      await chrome.storage.local.remove("tabHarborNotice");
      await chrome.action.setBadgeText({ text: "" });
      return tabHarborNotice || null;
    }
    case "GET_BROWSER": {
      let targetWindowId = message.windowId;
      try {
        const target = await chrome.windows.get(targetWindowId);
        if (target.type !== "normal") throw new Error("Not a normal browser window");
      } catch {
        targetWindowId = (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
      }
      const tabs = await chrome.tabs.query({ windowId: targetWindowId });
      const groups = await chrome.tabGroups.query({ windowId: targetWindowId });
      return {
        windowId: targetWindowId, tabCount: tabs.length, groups: groups.map(group => ({ ...group, tabCount: tabs.filter(tab => tab.groupId === group.id).length })).sort((a, b) => {
          return (tabs.find(tab => tab.groupId === a.id)?.index ?? 0) - (tabs.find(tab => tab.groupId === b.id)?.index ?? 0);
        })
      };
    }
    case "CREATE_GROUP": state.groups.push(makeGroup(message, state.groups.length)); break;
    case "UPDATE_GROUP": {
      const group = findGroup(state, message.groupId);
      if (message.name !== undefined) {
        const name = String(message.name).trim().slice(0, 120);
        if (!name) throw new Error("Give the group a name.");
        group.name = name;
        if (group.fromNativeGroup) group.nativeTitle = name;
      }
      if (message.color !== undefined) {
        if (!Object.hasOwn(COLORS, message.color)) throw new Error("Unknown group color.");
        group.color = message.color;
      }
      for (const property of ["collapsed", "lazyOpen"]) if (message[property] !== undefined) group[property] = Boolean(message[property]);
      break;
    }
    case "DELETE_GROUP": findGroup(state, message.groupId); state.groups = reindex(sortGroups(state.groups).filter(group => group.id !== message.groupId)); break;
    case "REORDER_GROUP": {
      const groups = sortGroups(state.groups);
      const index = groups.findIndex(group => group.id === message.groupId);
      if (index < 0) throw new Error("This group no longer exists.");
      if (message.beforeId === message.groupId) return null;
      let target = message.beforeId ? groups.findIndex(group => group.id === message.beforeId) : Math.max(0, Math.min(groups.length - 1, index + (message.direction < 0 ? -1 : 1)));
      if (target < 0) throw new Error("The reorder destination no longer exists.");
      const [group] = groups.splice(index, 1);
      if (message.beforeId && target > index) target--;
      groups.splice(target, 0, group); state.groups = reindex(groups); break;
    }
    case "MOVE_LINK": moveLink(state, message.sourceId, message.linkId, message.targetId, message.beforeId); break;
    case "MOVE_ENTRY": moveEntry(state, message.groupId, message.beforeId); break;
    case "UNGROUP_LINK": ungroupLink(state, message.sourceId, message.linkId, message.beforeId); break;
    case "GROUP_LINK": groupLink(state, message.sourceId, message.linkId, message.name); break;
    case "DELETE_LINK": {
      const { group } = findLink(state, message.groupId, message.linkId);
      group.links = group.links.filter(link => link.id !== message.linkId); break;
    }
    case "OPEN_LINK": {
      const result = await openSavedLink(state, message.groupId, message.linkId, message);
      await rebuildMenus(state); return result;
    }
    case "OPEN_GROUP": {
      const result = await openSavedGroup(state, message.groupId, message);
      await rebuildMenus(state); return result;
    }
    case "SAVE_PAGE": {
      const result = await savePage(state, message); await rebuildMenus(state); return result;
    }
    case "SAVE_BROWSER_GROUP": {
      const result = await saveBrowserGroup(state, message); await rebuildMenus(state); return result;
    }
    case "PREPARE_MOVE": return prepareMove(state, message);
    case "GET_PLAN": {
      const plan = state.pendingMoves.find(item => item.id === message.planId);
      if (!plan) throw new Error("This move expired. Start a new move from the popup.");
      return { plan, groups: state.groups };
    }
    case "CANCEL_MOVE": state.pendingMoves = state.pendingMoves.filter(plan => plan.id !== message.planId); break;
    case "COMMIT_MOVE": {
      const result = await commitMove(state, message.planId, message.choices);
      await rebuildMenus(state); return result;
    }
    case "UNDO_MOVE": { const result = await undoMove(state, message.undoId); await rebuildMenus(state); return result; }
    default: throw new Error("Unknown extension action.");
  }
  cleanLooseTabs(state);
  await writeState(state);
  await rebuildMenus(state);
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Star management has its own queue so a long saved-group restore cannot delay discarding.
  const operation = ["GET_STARS", "GET_TAB_STAR", "STAR_TITLE", "STAR_TAB", "STAR_BROWSER_GROUP"].includes(message.type)
    ? handle(message, sender) : exclusive(() => handle(message, sender));
  operation.then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function backgroundMove(input) {
  const result = await exclusive(async () => {
    const state = await readState();
    const plan = await prepareMove(state, input);
    if (!plan.groups.length && !plan.excludedTabs?.length) return { notice: plan.warnings.join(" ") || "No savable tabs found." };
    if (plan.groups.some(group => group.conflicts.length)) return { plan };
    const moved = await commitMove(state, plan.id);
    await rebuildMenus(state);
    return { notice: moved.message + (moved.warnings.length ? ` ${moved.warnings.join(" ")}` : "") };
  });
  if (result.plan) {
    // A dedicated extension window lets keyboard/context-menu moves ask before any source tabs close.
    await chrome.windows.create({ url: chrome.runtime.getURL(`pages/review.html?plan=${result.plan.id}`), type: "popup", width: 600, height: 650 });
  } else await notice(result.notice);
}

export async function handleContextMenu(info, tab) {
    if (!tab?.id) tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id) throw new Error("No browser tab is available.");
    const menu = String(info.menuItemId);
    if (["star-tab", "unstar-tab", "star-native", "unstar-native"].includes(menu)) {
      const starred = menu.startsWith("star-");
      if (menu.endsWith("native") && (!Number.isInteger(tab.groupId) || tab.groupId < 0)) throw new Error("Choose a tab inside a browser group.");
      const access = starred ? await requestIndicatorAccess() : true;
      const result = menu.endsWith("native") ? await setGroupStar(tab.id, starred) : await setTabStar(tab.id, starred);
      if (!access) result.warnings.push("Allow optional website access to show ★ on loaded webpage tabs.");
      await notice(result.message + (result.warnings.length ? ` ${result.warnings.join(" ")}` : "")); return;
    }
    if (menu === "save-native") {
      const result = await exclusive(async () => {
        const state = await readState();
        const saved = await saveBrowserGroup(state, { windowId: tab.windowId, tabId: tab.id });
        await rebuildMenus(state); return saved;
      });
      await notice(result.message + (result.warnings.length ? ` ${result.warnings.join(" ")}` : "")); return;
    }
    if (menu === "park-native" || menu === "park-window") {
      await backgroundMove({ scope: menu === "park-native" ? "group" : "window", windowId: tab.windowId, tabId: tab.id });
      return;
    }
    const [kind, groupId] = menu.split(":");
    if (kind === "park") {
      await backgroundMove({ scope: "tab", windowId: tab.windowId, tabId: tab.id, targetId: groupId === "default" ? undefined : groupId });
      return;
    }
    if (!["link", "page"].includes(kind)) return;
    const data = kind === "link"
      ? { url: info.linkUrl, title: await linkText(info, tab) || info.selectionText || "", pinned: false }
      : tabSnapshot((await cleanBrowserTabs([tab]))[0], LAZY_BASE);
    if (!(kind === "link" ? savableUrl(data.url) : savableTabUrl(data.url))) throw new Error("This page cannot be saved. Web pages, New Tab, and blank tabs are supported.");
    const saved = await exclusive(async () => {
      const state = await readState(); const result = await savePage(state, { ...data, groupId });
      await rebuildMenus(state); return result;
    });
    await chrome.action.setBadgeText({ text: "✓" });
    await chrome.action.setBadgeBackgroundColor({ color: "#1F7A6D" });
    if (kind === "link") {
      const title = await fetchPageTitle(data.url);
      if (title) await exclusive(async () => {
        const state = await readState();
        // The saved link might have been moved or deleted while fetching.
        const link = state.groups.flatMap(group => group.links).find(item => item.id === saved.linkId);
        if (link) { link.title = title; await writeState(state); }
      });
    }
}
chrome.contextMenus.onClicked.addListener((info, tab) => handleContextMenu(info, tab).catch(report));

chrome.commands.onCommand.addListener(command => {
  (async () => {
    const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    await backgroundMove({ scope: command === "park-current-group" ? "group" : "tab", windowId: window.id });
  })().catch(report);
});

function starTask(operation) {
  operation.then(result => { if (result?.warnings?.length) return notice(result.warnings.join(" ")); }).catch(report);
}
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  starTask(enforceStars(windowId));
  exclusive(() => activateLazy(tabId)).catch(report);
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  replaceTabStar(addedTabId, removedTabId).then(() => starTask(enforceStarredTab(addedTabId))).catch(report);
  exclusive(() => activateLazy(addedTabId)).catch(report);
});
chrome.tabs.onCreated.addListener(tab => { starTask(enforceStarredTab(tab.id)); });
chrome.tabs.onAttached.addListener(tabId => { starTask(enforceStarredTab(tabId)); });
chrome.tabs.onRemoved.addListener(tabId => { removeTabStar(tabId).catch(report); });
chrome.tabGroups.onRemoved.addListener(group => { removeGroupStar(group.id).catch(report); });
chrome.tabGroups.onUpdated.addListener(group => { refreshGroupIndicator(group.id).catch(report); });
chrome.permissions.onAdded.addListener(() => { registerIndicators().catch(report); });
chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (changes.groupId !== undefined || changes.url || changes.status || changes.discarded === false) starTask(enforceStarredTab(tabId));
  if (tab.active && (changes.status === "complete" || changes.url)) exclusive(() => activateLazy(tabId)).catch(report);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tabHarbor) exclusive(async () => rebuildMenus(await readState())).catch(report);
});
chrome.runtime.onInstalled.addListener(() => { exclusive(async () => rebuildMenus(await readState(), true)).catch(report); });
chrome.runtime.onStartup.addListener(() => {
  exclusive(async () => {
    await rebuildMenus(await readState(), true);
    for (const tab of await chrome.tabs.query({ active: true })) await activateLazy(tab.id);
  }).catch(report);
});
exclusive(async () => rebuildMenus(await readState())).catch(report);
starTask(restoreStars());
