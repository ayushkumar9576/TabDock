import { makeGroup, makeLink, findGroup, matchingGroups, id, savableTabUrl, isNewTabUrl, tabSnapshot, UNDO_MS, PLAN_MS, reindex, sortGroups } from "../shared/model.js";
import { writeState } from "../shared/storage.js";
import { LAZY_BASE, createSavedTab, resolveWindow } from "./open.js";
import { captureBrowserGroup } from "./groups.js";
import { cleanBrowserTabs, cleanBrowserGroup } from "./indicators.js";

async function windowTabs(windowId) {
  const window = await chrome.windows.get(windowId);
  if (window.type !== "normal") throw new Error("Choose tabs from a normal browser window.");
  return (await cleanBrowserTabs(await chrome.tabs.query({ windowId }))).sort((a, b) => a.index - b.index);
}

export async function prepareMove(state, input) {
  const windowId = input.windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
  const all = await windowTabs(windowId);
  const active = input.tabId ? all.find(tab => tab.id === input.tabId) : all.find(tab => tab.active);
  let candidates;
  let nativeGroupId = input.nativeGroupId;
  if (input.scope === "tab") {
    if (!active) throw new Error("The current tab is no longer available.");
    candidates = [active];
  } else if (input.scope === "group") {
    const captured = await captureBrowserGroup({ windowId, tabId: input.tabId ?? active?.id, nativeGroupId });
    nativeGroupId = captured.group.id;
    candidates = captured.tabs;
  } else if (input.scope === "window") candidates = all.filter(tab => input.includePinned || !tab.pinned);
  else throw new Error("Unknown move scope.");

  const snapshots = candidates.map(tab => tabSnapshot(tab, LAZY_BASE));
  const supported = snapshots.filter(tab => savableTabUrl(tab.url));
  const excludedTabs = state.settings?.includeNewTabs === false && input.scope !== "tab"
    ? supported.filter(tab => tab.groupId >= 0 && isNewTabUrl(tab.url)) : [];
  const savable = supported.filter(tab => !excludedTabs.includes(tab));
  const warnings = [];
  const skipped = snapshots.length - supported.length;
  if (skipped) warnings.push(`${skipped} internal or unsupported ${skipped === 1 ? "page was" : "pages were"} left open.`);
  if (input.scope === "window" && !input.includePinned) {
    const pinned = all.filter(tab => tab.pinned).length;
    if (pinned) warnings.push(`${pinned} pinned ${pinned === 1 ? "tab was" : "tabs were"} left open.`);
  }
  if (savable.some(tab => candidates.find(item => item.id === tab.id)?.audible)) warnings.push("Audio-playing tabs will also be closed.");
  const destination = input.targetId ? findGroup(state, input.targetId) : null;
  if (destination?.ungrouped) throw new Error("Choose a named group as the destination.");
  const incoming = [];
  const byNative = new Map();
  for (const tab of savable) {
    // A single-tab move goes into the explicitly selected saved group.
    const native = input.scope !== "tab" && tab.groupId >= 0;
    const key = native ? `native:${tab.groupId}` : destination ? "loose" : `loose:${tab.id}`;
    if (!byNative.has(key)) {
      let group;
      if (native) {
        const original = await cleanBrowserGroup(await chrome.tabGroups.get(tab.groupId));
        group = {
          key: id(), name: original.title || "Untitled group", color: original.color,
          collapsed: original.collapsed, fromNativeGroup: true,
          sourceNativeGroupId: original.id, sourceWindowId: windowId,
          originalTitle: original.title, tabs: [],
          conflicts: matchingGroups(state.groups, original.title || "Untitled group").map(item => item.id),
        };
      } else {
        group = {
          key: id(), name: destination?.name || "Common", color: destination?.color || "blue",
          collapsed: destination?.collapsed || false, fromNativeGroup: false,
          targetId: destination?.id || null, sourceWindowId: windowId, tabs: [], conflicts: [],
          ungrouped: !destination,
        };
      }
      byNative.set(key, group); incoming.push(group);
    }
    byNative.get(key).tabs.push(tab);
  }
  // Keep the source metadata for single grouped tabs, too, so Undo puts them back in their native group.
  const nativeMetadata = {};
  for (const tab of supported.filter(tab => tab.groupId >= 0)) {
    if (!nativeMetadata[tab.groupId]) {
      const group = await cleanBrowserGroup(await chrome.tabGroups.get(tab.groupId));
      nativeMetadata[tab.groupId] = { id: group.id, title: group.title, color: group.color, collapsed: group.collapsed, windowId: group.windowId };
    }
  }
  const plan = {
    id: id(), createdAt: Date.now(), windowId, scope: input.scope, groups: incoming, nativeMetadata, warnings,
    excludedTabs, sourceNativeGroupId: input.scope === "group" ? nativeGroupId : null
  };
  if (incoming.length || excludedTabs.length) { state.pendingMoves.push(plan); await writeState(state); }
  return plan;
}

export async function commitMove(state, planId, choices = {}) {
  const plan = state.pendingMoves.find(item => item.id === planId);
  if (!plan || Date.now() - plan.createdAt >= PLAN_MS) throw new Error("This move expired. Refresh the browser list and try again.");
  const tabs = [...plan.groups.flatMap(group => group.tabs), ...(plan.excludedTabs || [])];
  const excludedIds = new Set((plan.excludedTabs || []).map(tab => tab.id));
  if (plan.scope === "group") {
    const groupId = plan.sourceNativeGroupId ?? plan.groups[0]?.sourceNativeGroupId;
    const members = await chrome.tabs.query({ windowId: plan.windowId, groupId });
    const expected = new Set(tabs.map(tab => tab.id));
    if (members.length !== expected.size || members.some(tab => !expected.has(tab.id))) {
      throw new Error("The browser group's membership changed. Start the whole-group move again. No tabs were moved.");
    }
  }
  // Revalidate every tab before storing anything or closing any source tab.
  for (const snapshot of tabs) {
    let current;
    try { current = tabSnapshot(await chrome.tabs.get(snapshot.id), LAZY_BASE); }
    catch { throw new Error("A source tab was closed. Refresh and start this move again."); }
    const changedUrl = excludedIds.has(snapshot.id) ? !isNewTabUrl(current.url) : current.url !== snapshot.url;
    if (changedUrl || current.windowId !== snapshot.windowId || current.groupId !== snapshot.groupId || current.pinned !== snapshot.pinned || current.index !== snapshot.index) {
      throw new Error("A source tab changed or moved while you were choosing. Refresh and start this move again.");
    }
  }
  // Validate every decision before mutating state.
  for (const incoming of plan.groups) {
    if (incoming.targetId) findGroup(state, incoming.targetId);
    else if (!incoming.ungrouped) {
      const choice = choices[incoming.key];
      const matches = matchingGroups(state.groups, incoming.name);
      if (matches.length && !["merge", "new"].includes(choice?.mode)) throw new Error(`Choose whether to merge “${incoming.name}” or create a new group.`);
      if (choice?.mode === "merge") {
        const target = findGroup(state, choice.groupId);
        if (!matches.some(group => group.id === target.id)) throw new Error("The merge destination changed. Start the move again.");
      }
    }
  }
  const record = {
    id: id(), expiresAt: Date.now() + UNDO_MS, windowId: plan.windowId,
    entries: [], createdGroupIds: [], nativeMetadata: plan.nativeMetadata,
    message: "Tabs parked. Their saved links are ready.",
  };
  for (const incoming of plan.groups) {
    if (incoming.ungrouped) {
      for (const tab of incoming.tabs) {
        const link = makeLink(tab);
        const target = makeGroup({ name: link.title, ungrouped: true }, state.groups.length);
        target.links.push(link);
        state.groups.push(target);
        record.createdGroupIds.push(target.id);
        record.entries.push({ groupId: target.id, linkId: link.id, tab, closed: false });
      }
      continue;
    }
    const choice = choices[incoming.key];
    let target;
    if (incoming.targetId) target = findGroup(state, incoming.targetId);
    else if (choice?.mode === "merge") target = findGroup(state, choice.groupId);
    else {
      target = makeGroup(incoming, state.groups.length);
      state.groups.push(target); record.createdGroupIds.push(target.id);
    }
    for (const tab of incoming.tabs) {
      const link = makeLink(tab);
      target.links.push(link);
      record.entries.push({ groupId: target.id, linkId: link.id, tab, closed: false });
    }
  }
  state.pendingMoves = state.pendingMoves.filter(item => item.id !== planId);
  for (const tab of plan.excludedTabs || []) record.entries.push({ groupId: null, linkId: null, tab, closed: false, excluded: true });
  state.undo.push(record);
  // This write MUST finish successfully before any close operation.
  await writeState(state);
  const warnings = [...plan.warnings];
  const currentTabs = await chrome.tabs.query({ windowId: plan.windowId });
  const ids = new Set(tabs.map(tab => tab.id));
  if (currentTabs.length && currentTabs.every(tab => ids.has(tab.id))) {
    // If this fails, the move stops with all saved copies intact and source tabs still open.
    const blank = await chrome.tabs.create({ windowId: plan.windowId, url: "about:blank", active: true });
    record.safetyTabId = blank.id;
    await writeState(state);
  }
  for (const entry of record.entries) {
    try {
      // Navigations can occur after the initial validation. Leave a changed tab open.
      const current = tabSnapshot(await chrome.tabs.get(entry.tab.id), LAZY_BASE);
      const changedUrl = entry.excluded ? !isNewTabUrl(current.url) : current.url !== entry.tab.url;
      if (changedUrl || current.windowId !== entry.tab.windowId || (entry.excluded && current.groupId !== entry.tab.groupId)) {
        warnings.push(entry.excluded ? "An empty tab changed into another page and was left open." : "A tab changed during parking and was left open; its saved copy was retained.");
        continue;
      }
      await chrome.tabs.remove(entry.tab.id);
      entry.closed = true;
    } catch (error) { warnings.push(`A saved tab could not be closed: ${error.message}`); }
    // Checkpoint each successful close; Undo remains available if the worker is interrupted.
    await writeState(state);
  }
  const closed = record.entries.filter(entry => entry.closed).length;
  const savedCount = record.entries.filter(entry => !entry.excluded).length;
  const discardedCount = record.entries.filter(entry => entry.excluded && entry.closed).length;
  record.message = `${closed} ${closed === 1 ? "tab parked" : "tabs parked"}. ${savedCount} ${savedCount === 1 ? "link saved" : "links saved"}.` +
    (discardedCount ? ` ${discardedCount} empty ${discardedCount === 1 ? "tab discarded" : "tabs discarded"}.` : "");
  record.expiresAt = Date.now() + UNDO_MS;
  await writeState(state);
  return { message: record.message, undo: record, discardedCount, warnings: [...new Set(warnings)] };
}

export async function undoMove(state, undoId) {
  const record = state.undo.find(item => item.id === undoId);
  if (!record || record.expiresAt <= Date.now()) throw new Error("The undo period has ended. Open the saved links to restore them.");
  const windowId = await resolveWindow(record.windowId);
  const warnings = [];
  const restored = [];
  const pending = record.entries.filter(entry => entry.closed);
  for (const entry of pending.sort((a, b) => a.tab.index - b.tab.index)) {
    try {
      const result = await createSavedTab({ ...entry.tab }, { windowId, active: false, deferred: entry.tab.discarded, index: entry.tab.index });
      restored.push({ entry, tab: result.tab });
      if (result.warning) warnings.push(result.warning);
    } catch (error) { warnings.push(`Could not restore “${entry.tab.title}”: ${error.message}`); }
  }
  for (const [originalId, meta] of Object.entries(record.nativeMetadata)) {
    const members = restored.filter(item => item.entry.tab.groupId === Number(originalId) && !item.tab.pinned);
    if (!members.length) continue;
    try {
      let groupId;
      try {
        const original = await chrome.tabGroups.get(Number(originalId));
        if (original.windowId === windowId) groupId = original.id;
      } catch { /* The original group was fully parked. */ }
      const restoredGroup = await chrome.tabs.group(groupId !== undefined
        ? { tabIds: members.map(item => item.tab.id), groupId }
        : { tabIds: members.map(item => item.tab.id), createProperties: { windowId } });
      await chrome.tabGroups.update(restoredGroup, { title: meta.title, color: meta.color, collapsed: meta.collapsed });
    } catch (error) { warnings.push(`Tabs restored, but browser grouping failed: ${error.message}`); }
  }
  const active = restored.find(item => item.entry.tab.active);
  if (active) {
    try { await chrome.tabs.update(active.tab.id, { active: true }); }
    catch { warnings.push("The previously active tab could not be selected."); }
  }
  if (restored.length && record.safetyTabId) {
    try {
      const safety = await chrome.tabs.get(record.safetyTabId);
      const remaining = await chrome.tabs.query({ windowId: safety.windowId });
      if ((safety.pendingUrl || safety.url) === "about:blank" && remaining.length > 1) await chrome.tabs.remove(safety.id);
    } catch { /* Keep a safety tab that was changed or is no longer available. */ }
  }
  // Delete only the copies actually restored. Other edits to saved groups are preserved.
  const restoredEntries = new Set(restored.map(item => item.entry));
  const restoredLinks = new Set(restored.map(item => item.entry.linkId).filter(Boolean));
  const unclosedLinks = new Set();
  for (const entry of record.entries.filter(entry => !entry.closed)) {
    try {
      const current = tabSnapshot(await chrome.tabs.get(entry.tab.id), LAZY_BASE);
      // A copy of a page that navigated away is still valuable; keep it.
      if (current.url === entry.tab.url) unclosedLinks.add(entry.linkId);
    } catch { /* The original disappeared: preserve its saved link. */ }
  }
  const removeLinks = new Set([...restoredLinks, ...unclosedLinks]);
  for (const group of state.groups) group.links = group.links.filter(link => !removeLinks.has(link.id));
  state.groups = reindex(sortGroups(state.groups).filter(group => group.links.length || (!group.ungrouped && !record.createdGroupIds.includes(group.id))));
  record.entries = record.entries.filter(entry => entry.closed && !restoredEntries.has(entry));
  if (!record.entries.length) state.undo = state.undo.filter(item => item.id !== undoId);
  await writeState(state);
  return { message: `${restored.length} ${restored.length === 1 ? "tab restored" : "tabs restored"}.`, warnings: [...new Set(warnings)] };
}
