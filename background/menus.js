import { sortGroups } from "../shared/model.js";
let signature;
let supportsTabContext;

function create(properties) {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.create(properties, () => {
      const error = chrome.runtime.lastError;
      error ? reject(new Error(error.message)) : resolve();
    });
  });
}

async function captureContexts() {
  if (supportsTabContext === undefined) {
    try {
      await create({ id: "tabdock-tab-context-probe", title: "TabDock", contexts: ["tab"] });
      await chrome.contextMenus.remove("tabdock-tab-context-probe");
      supportsTabContext = true;
    } catch { supportsTabContext = false; }
  }
  return supportsTabContext ? ["page", "action", "tab"] : ["page", "action"];
}

export async function rebuildMenus(state, force = false) {
  const groups = sortGroups(state.groups).filter(group => !group.ungrouped);
  const next = JSON.stringify(groups.map(group => [group.id, group.name]));
  if (!force && next === signature) return;
  await chrome.contextMenus.removeAll();
  const tabContexts = await captureContexts();
  for (const [prefix, title, contexts] of [
    ["link", "Add link to TabDock", ["link"]],
    ["page", "Add tab to TabDock", tabContexts],
    ["park", "Move tab to TabDock", tabContexts],
  ]) {
    if (!groups.length) {
      await create({ id: `${prefix}:default`, title, contexts });
    } else {
      await create({ id: `${prefix}-root`, title, contexts });
      await create({ id: `${prefix}:default`, parentId: `${prefix}-root`, title: "As an individual tab", contexts });
      for (const group of groups) await create({ id: `${prefix}:${group.id}`, parentId: `${prefix}-root`, title: group.name, contexts });
    }
  }
  await create({ id: "separator", type: "separator", contexts: tabContexts });
  await create({ id: "save-native", title: "Add this browser group to TabDock", contexts: tabContexts });
  await create({ id: "park-native", title: "Move this browser group to TabDock", contexts: tabContexts });
  await create({ id: "park-window", title: "Move window to TabDock (skip pinned tabs)", contexts: tabContexts });
  signature = next;
}
