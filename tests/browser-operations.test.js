import test from "node:test";
import assert from "node:assert/strict";
import { mockChrome, tab } from "./mock-chrome.js";
import { initialState, makeGroup, makeLink, parseLazyUrl } from "../shared/model.js";
mockChrome();
const { prepareMove, commitMove, undoMove } = await import("../background/moves.js");
const { openGroup, LAZY_BASE, activateLazy } = await import("../background/open.js");

test("window parking skips pinned and internal pages and copies native metadata/order", async () => {
  mockChrome({ tabs: [tab(1, { pinned: true }), tab(2, { url: "chrome://settings" }), tab(3, { groupId: 7 }), tab(4, { groupId: 7 })], groups: [{ id: 7, title: "Watch later", color: "red", collapsed: true, windowId: 1 }] });
  const plan = await prepareMove(initialState(), { scope: "window", windowId: 1 });
  assert.equal(plan.groups.length, 1); const group = plan.groups[0];
  assert.deepEqual(group.tabs.map(tab => tab.id), [3, 4]); assert.equal(group.color, "red"); assert.equal(group.collapsed, true);
  assert.equal(group.tabs[0].favicon, "https://example.com/icon3.png"); assert.equal(plan.warnings.length, 2);
});
test("last-tab parking persists first, creates a blank tab, and survives popup closing", async () => {
  const mock = mockChrome({ tabs: [tab(1), tab(2)] }); const state = initialState();
  const plan = await prepareMove(state, { scope: "window", windowId: 1 }); mock.log.length = 0;
  const result = await commitMove(state, plan.id);
  assert.equal(mock.log[0][0], "store");
  assert.ok(mock.log.findIndex(item => item[0] === "create") < mock.log.findIndex(item => item[0] === "remove"));
  assert.equal(mock.live.length, 1); assert.equal(mock.live[0].url, "about:blank");
  assert.equal(mock.data.tabHarbor.groups.length, 2); assert.ok(mock.data.tabHarbor.groups.every(group => group.ungrouped && group.links.length === 1)); assert.equal(mock.data.tabHarbor.undo[0].entries.filter(entry => entry.closed).length, 2);
  assert.match(result.message, /2 tabs parked/);
});
test("failed storage never closes a source tab", async () => {
  mockChrome({ tabs: [tab(1)] }); const state = initialState(); const plan = await prepareMove(state, { scope: "tab", windowId: 1 });
  const mock = mockChrome({ tabs: [tab(1)], failStorage: true });
  await assert.rejects(commitMove(state, plan.id), /quota/);
  assert.equal(mock.live.length, 1); assert.ok(!mock.log.some(item => item[0] === "remove"));
});

test("parking a mixed browser window keeps standalone cards and native groups in browser order", async () => {
  mockChrome({ tabs: [tab(1), tab(2, { groupId: 7 }), tab(3, { groupId: 7 }), tab(4)], groups: [{ id: 7, title: "Reading", color: "green", collapsed: false, windowId: 1 }] });
  const state = initialState(); const plan = await prepareMove(state, { scope: "window", windowId: 1 });
  await commitMove(state, plan.id);
  assert.deepEqual(state.groups.map(group => group.links.map(link => link.title)), [["Tab 1"], ["Tab 2", "Tab 3"], ["Tab 4"]]);
  assert.deepEqual(state.groups.map(group => Boolean(group.ungrouped)), [true, false, true]);
});
test("navigation or reordering between prepare and commit aborts without data loss", async () => {
  const mock = mockChrome({ tabs: [tab(1), tab(2)] }); const state = initialState();
  const plan = await prepareMove(state, { scope: "window", windowId: 1 }); mock.live[0].url = "https://example.com/changed";
  await assert.rejects(commitMove(state, plan.id), /changed/); assert.equal(state.groups.length, 0); assert.ok(!mock.log.some(item => item[0] === "remove"));
});
test("same-name native groups require an explicit merge or new-copy choice", async () => {
  const mock = mockChrome({ tabs: [tab(1, { groupId: 7 }), tab(2, { url: "chrome://settings" })], groups: [{ id: 7, title: "Common", color: "red", collapsed: true, windowId: 1 }] });
  const state = initialState(); state.groups.push(makeGroup({ name: "Common" })); const plan = await prepareMove(state, { scope: "group", windowId: 1, nativeGroupId: 7 });
  await assert.rejects(commitMove(state, plan.id), /Choose whether/); assert.equal(mock.live.length, 2);
  const result = await commitMove(state, plan.id, { [plan.groups[0].key]: { mode: "merge", groupId: state.groups[0].id } });
  assert.equal(state.groups.length, 1); assert.equal(state.groups[0].color, "blue"); assert.equal(state.groups[0].collapsed, false); assert.equal(result.undo.entries.length, 1);
});
test("native group round trip preserves title, color, collapsed state, URLs and order", async () => {
  const mock = mockChrome({ tabs: [tab(1, { url: "chrome://settings" }), tab(2, { groupId: 7, active: false }), tab(3, { groupId: 7, active: false })], groups: [{ id: 7, title: "", color: "purple", collapsed: true, windowId: 1 }] });
  const state = initialState(); const plan = await prepareMove(state, { scope: "group", windowId: 1, nativeGroupId: 7 });
  await commitMove(state, plan.id); const saved = state.groups.find(group => group.fromNativeGroup);
  assert.equal(saved.nativeTitle, ""); assert.deepEqual(saved.links.map(link => link.url), ["https://example.com/2", "https://example.com/3"]);
  const opened = await openGroup(saved, { windowId: 1 }); const native = mock.native.get(opened.nativeGroupId);
  assert.equal(native.title, ""); assert.equal(native.color, "purple"); assert.equal(native.collapsed, true);
  const restored = mock.live.filter(tab => opened.tabIds.includes(tab.id));
  for (const [index, tab] of restored.entries()) { assert.equal(parseLazyUrl(tab.url, LAZY_BASE).url, saved.links[index].url); assert.equal(tab.discarded, true); assert.equal(tab.status, "unloaded"); }
});
test("undo restores native groups and pinned tabs and only removes moved saved copies", async () => {
  const mock = mockChrome({ tabs: [tab(1, { pinned: true }), tab(2, { groupId: 7 }), tab(3, { groupId: 7 })], groups: [{ id: 7, title: "Reading", color: "green", collapsed: false, windowId: 1 }] });
  const state = initialState(); const plan = await prepareMove(state, { scope: "window", windowId: 1, includePinned: true });
  const result = await commitMove(state, plan.id);
  const extra = makeLink({ url: "https://example.com/extra" }); const extraGroup = makeGroup({ name: "Unrelated" }, state.groups.length); extraGroup.links.push(extra); state.groups.push(extraGroup);
  const undone = await undoMove(state, result.undo.id);
  assert.match(undone.message, /3 tabs restored/); assert.equal(mock.live[0].pinned, true); assert.equal(mock.live[0].url, "https://example.com/1");
  const group = [...mock.native.values()].find(group => group.title === "Reading");
  assert.equal(group.color, "green"); assert.deepEqual(mock.live.filter(tab => tab.groupId === group.id).map(tab => tab.url), ["https://example.com/2", "https://example.com/3"]);
  assert.equal(state.groups.length, 1); assert.deepEqual(state.groups[0].links, [extra]); assert.equal(state.undo.length, 0);
  assert.equal(mock.live.length, 3);
});
test("partial close failures retain saved copies and Undo restores only closed tabs", async () => {
  const mock = mockChrome({ tabs: [tab(1), tab(2)], failRemove: [2] }); const state = initialState();
  const plan = await prepareMove(state, { scope: "window", windowId: 1 }); const moved = await commitMove(state, plan.id);
  assert.equal(state.groups.flatMap(group => group.links).length, 2); assert.equal(moved.warnings.length, 1);
  const result = await undoMove(state, moved.undo.id); assert.match(result.message, /1 tab restored/);
  assert.equal(mock.live.filter(tab => tab.url === "https://example.com/2").length, 1); assert.equal(state.groups.length, 0);
});
test("failed undo creation keeps the saved link available", async () => {
  mockChrome({ tabs: [tab(1)] }); const state = initialState(); const plan = await prepareMove(state, { scope: "tab", windowId: 1 }); const moved = await commitMove(state, plan.id);
  mockChrome({ tabs: [tab(10, { url: "about:blank" })], failCreate: true });
  const result = await undoMove(state, moved.undo.id); assert.match(result.message, /0 tabs restored/); assert.equal(state.groups[0].links.length, 1); assert.equal(state.undo.length, 1);
});
test("group restore keeps every target unloaded and preserves the current active tab until selection", async () => {
  const mock = mockChrome({ tabs: [tab(1)] }); const group = makeGroup({ name: "Later" });
  group.links = [1, 2, 3].map(n => makeLink({ url: `https://example.com/watch/${n}`, title: `Video ${n}` }));
  const result = await openGroup(group, { windowId: 1 });
  const created = mock.live.filter(tab => result.tabIds.includes(tab.id));
  assert.equal(mock.live.find(tab => tab.active).id, 1);
  for (const [index, deferred] of created.entries()) { assert.equal(deferred.discarded, true); assert.equal(deferred.status, "unloaded"); assert.equal(deferred.active, false); assert.equal(parseLazyUrl(deferred.url, LAZY_BASE).url, group.links[index].url); }
  await mock.chrome.tabs.update(created[1].id, { active: true }); await activateLazy(created[1].id);
  assert.equal(mock.live.find(tab => tab.id === created[1].id).url, group.links[1].url);
});
test("legacy opening options still keep every page unloaded and pinned tabs outside the group", async () => {
  const mock = mockChrome({ tabs: [tab(1)] }); const group = makeGroup({ name: "All", lazyOpen: false });
  group.links = [makeLink({ url: "https://example.com/pinned", pinned: true }), makeLink({ url: "https://example.com/regular" })];
  const result = await openGroup(group, { windowId: 1, loadAll: true });
  const created = mock.live.filter(tab => result.tabIds.includes(tab.id));
  assert.ok(created.every(tab => parseLazyUrl(tab.url, LAZY_BASE) && tab.discarded && !tab.active)); assert.equal(mock.log.filter(item => item[0] === "discard").length, 2);
  assert.equal(mock.live.find(tab => tab.active).id, 1);
  assert.equal(created.find(tab => tab.pinned).groupId, -1); assert.equal(created.find(tab => !tab.pinned).groupId, result.nativeGroupId);
});

test("Brave tab-ID replacement during discard uses the replacement IDs for native grouping", async () => {
  const mock = mockChrome({ tabs: [tab(1)], discardRemaps: true }); const group = makeGroup({ name: "Brave" });
  group.links = [1, 2, 3].map(n => makeLink({ url: `https://example.com/${n}` }));
  const opened = await openGroup(group, { windowId: 1 });
  assert.deepEqual(opened.warnings, []);
  for (const tabId of opened.tabIds) assert.equal(mock.live.find(tab => tab.id === tabId).groupId, opened.nativeGroupId);
  assert.ok(mock.live.filter(tab => opened.tabIds.includes(tab.id)).slice(1).every(tab => tab.discarded));
});
