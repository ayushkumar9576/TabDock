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
  await create({ id: "tab-actions", title: "This tab", contexts: tabContexts });
  await create({ id: "group-actions", title: "This group", contexts: tabContexts });
  await create({ id: "window-actions", title: "Window", contexts: tabContexts });
  for (const [parentId, suffix] of [["tab-actions", "tab"], ["group-actions", "native"]]) {
    await create({ id: `star-${suffix}`, parentId, title: "★ Star", contexts: tabContexts });
    await create({ id: `unstar-${suffix}`, parentId, title: "☆ Unstar", contexts: tabContexts });
    await create({ id: `${suffix}-separator`, parentId, type: "separator", contexts: tabContexts });
  }
  for (const [prefix, title, contexts, parentId] of [
    ["link", "Save link", ["link"], undefined],
    ["page", "Save a copy", tabContexts, "tab-actions"],
    ["park", "Move to TabDock", tabContexts, "tab-actions"],
  ]) {
    if (!groups.length) {
      await create({ id: `${prefix}:default`, title, contexts, ...(parentId ? { parentId } : {}) });
    } else {
      await create({ id: `${prefix}-root`, title, contexts, ...(parentId ? { parentId } : {}) });
      await create({ id: `${prefix}:default`, parentId: `${prefix}-root`, title: "As an individual tab", contexts });
      for (const group of groups) await create({ id: `${prefix}:${group.id}`, parentId: `${prefix}-root`, title: group.name, contexts });
    }
  }
  await create({ id: "save-native", parentId: "group-actions", title: "Save a copy", contexts: tabContexts });
  await create({ id: "park-native", parentId: "group-actions", title: "Move to TabDock", contexts: tabContexts });
  await create({ id: "park-window", parentId: "window-actions", title: "Move all tabs to TabDock (skip pinned)", contexts: tabContexts });
  signature = next;
}
