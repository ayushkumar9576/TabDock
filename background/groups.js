import { savableTabUrl, tabSnapshot } from "../shared/model.js";

export async function captureBrowserGroup(input = {}) {
  let groupId = input.nativeGroupId;
  if (groupId === undefined || groupId === null) {
    let selected;
    if (input.tabId !== undefined && input.tabId !== null) selected = await chrome.tabs.get(input.tabId);
    else {
      const windowId = input.windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
      selected = (await chrome.tabs.query({ windowId, active: true }))[0];
    }
    groupId = selected?.groupId;
  }
  if (!Number.isInteger(groupId) || groupId < 0) throw new Error("The selected tab is not in a browser group.");
  const group = await chrome.tabGroups.get(groupId);
  if (input.windowId !== undefined && group.windowId !== input.windowId) throw new Error("This group belongs to another browser window.");
  if ((await chrome.windows.get(group.windowId)).type !== "normal") throw new Error("Choose a group from a normal browser window.");
  // Query membership by group ID, including members before the clicked tab.
  const tabs = (await chrome.tabs.query({ windowId: group.windowId, groupId }))
    .filter(tab => tab.groupId === groupId).sort((a, b) => a.index - b.index);
  if (!tabs.length) throw new Error("This browser group no longer has any tabs.");
  const snapshots = tabs.map(tab => tabSnapshot(tab, chrome.runtime.getURL("pages/lazy.html")));
  const unsupported = snapshots.find(tab => !savableTabUrl(tab.url));
  if (unsupported) throw new Error(`This group contains a page that cannot be saved: ${unsupported.title || unsupported.url}. No tabs were added or moved.`);
  return { group, tabs, snapshots };
}
