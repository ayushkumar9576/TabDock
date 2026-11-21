import { makeGroup, makeLink, findGroup, isNewTabUrl, tabSnapshot } from "../shared/model.js";
import { writeState } from "../shared/storage.js";
import { captureBrowserGroup } from "./groups.js";

export async function savePage(state, input) {
  const link = makeLink(input);
  let target = input.groupId && input.groupId !== "default" ? findGroup(state, input.groupId) : null;
  if (target?.ungrouped) throw new Error("Choose a named group as the destination.");
  if (!target) { target = makeGroup({ name: link.title, ungrouped: true }, state.groups.length); state.groups.push(target); }
  target.links.push(link);
  await writeState(state);
  return { groupId: target.id, linkId: link.id };
}

export async function saveBrowserGroup(state, input = {}) {
  const { group: native, snapshots } = await captureBrowserGroup(input);
  const excluded = state.settings?.includeNewTabs === false ? snapshots.filter(tab => isNewTabUrl(tab.url)) : [];
  const included = snapshots.filter(tab => !excluded.includes(tab));
  let group;
  if (included.length) {
    group = makeGroup({
      name: native.title || "Untitled group", originalTitle: native.title,
      color: native.color, collapsed: native.collapsed, fromNativeGroup: true
    }, state.groups.length);
    group.links = included.map(makeLink);
    state.groups.push(group);
  }
  // Persist website copies before closing excluded empty tabs. Storage failures leave all sources open.
  await writeState(state);
  let discardedCount = 0;
  const warnings = [];
  for (const snapshot of excluded) {
    try {
      const current = tabSnapshot(await chrome.tabs.get(snapshot.id), chrome.runtime.getURL("pages/lazy.html"));
      if (!isNewTabUrl(current.url) || current.windowId !== snapshot.windowId || current.groupId !== snapshot.groupId) {
        warnings.push("A New Tab changed during capture and was left open."); continue;
      }
      await chrome.tabs.remove(snapshot.id); discardedCount++;
    } catch (error) { warnings.push(`A New Tab could not be closed: ${error.message}`); }
  }
  const message = `${included.length} ${included.length === 1 ? "tab added" : "tabs added"} to TabDock.` +
    (discardedCount ? ` ${discardedCount} empty ${discardedCount === 1 ? "tab closed" : "tabs closed"}.` : "");
  return { groupId: group?.id || null, savedCount: included.length, discardedCount, message, warnings };
}
