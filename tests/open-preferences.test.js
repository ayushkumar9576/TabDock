import test from "node:test";
import assert from "node:assert/strict";
import { mockChrome, tab } from "./mock-chrome.js";
import { initialState, makeGroup, makeLink } from "../shared/model.js";
import { readState } from "../shared/storage.js";
mockChrome();
const { openSavedLink, openSavedGroup, LAZY_BASE } = await import("../background/open.js");

function library({ remove = false, loose = false, count = 3 } = {}) {
  const state = initialState(); state.settings.removeAfterOpen = remove;
  const group = makeGroup({ name: "Reading", ungrouped: loose });
  group.links = Array.from({ length: count }, (_, index) => makeLink({ url: `https://example.com/${index}`, title: `Page ${index}` }));
  state.groups.push(group); return { state, group };
}

test("opening keeps individual tabs and groups saved by default", async () => {
  mockChrome({ tabs: [tab(1)] });
  const { state, group } = library(); const before = structuredClone(state.groups);
  await openSavedLink(state, group.id, group.links[0].id, { windowId: 1 });
  await openSavedGroup(state, group.id, { windowId: 1 });
  assert.deepEqual(state.groups, before);
});

test("remove-after-open deletes the saved standalone card only after creating its browser tab", async () => {
  const mock = mockChrome({ tabs: [tab(1)] }); const { state, group } = library({ remove: true, loose: true, count: 1 });
  await openSavedLink(state, group.id, group.links[0].id, { windowId: 1 });
  assert.equal(state.groups.length, 0); assert.equal(mock.data.tabHarbor.groups.length, 0);
  assert.ok(mock.log.findIndex(item => item[0] === "create") < mock.log.findIndex(item => item[0] === "store"));
});

test("a failed single-tab opening leaves its saved copy untouched", async () => {
  const mock = mockChrome({ failCreate: true }); const { state, group } = library({ remove: true, count: 1 });
  const before = structuredClone(state);
  await assert.rejects(openSavedLink(state, group.id, group.links[0].id, { windowId: 1 }), /Creation failed/);
  assert.deepEqual(state, before); assert.ok(!mock.log.some(item => item[0] === "store"));
});

test("opening a whole group removes the group while preserving other saved entries", async () => {
  const mock = mockChrome({ tabs: [tab(1)] }); const { state, group } = library({ remove: true });
  const other = makeGroup({ name: "Other" }, 1); state.groups.push(other);
  const opened = await openSavedGroup(state, group.id, { windowId: 1 });
  assert.equal(opened.tabIds.length, 3); assert.deepEqual(state.groups.map(item => item.id), [other.id]);
  assert.deepEqual(mock.data.tabHarbor.groups.map(item => item.id), [other.id]);
  assert.equal(mock.native.get(opened.nativeGroupId).title, "Reading");
});

test("partially opened groups retain only the pages that failed to open", async () => {
  mockChrome({ failCreateUrls: ["https://example.com/1"] }); const { state, group } = library({ remove: true });
  const failedId = group.links[1].id;
  const opened = await openSavedGroup(state, group.id, { windowId: 1, loadAll: true });
  assert.equal(opened.tabIds.length, 2); assert.equal(opened.warnings.length, 1);
  assert.equal(state.groups.length, 1); assert.deepEqual(group.links.map(link => link.id), [failedId]);
});

test("a group stays intact when every browser tab fails to open", async () => {
  mockChrome({ failCreate: true }); const { state, group } = library({ remove: true }); const before = structuredClone(state.groups);
  const opened = await openSavedGroup(state, group.id, { windowId: 1 });
  assert.equal(opened.tabIds.length, 0); assert.deepEqual(state.groups, before);
});

test("explicit keep overrides the global remove setting", async () => {
  mockChrome({ tabs: [tab(1)] }); const { state, group } = library({ remove: true }); const before = structuredClone(state.groups);
  await openSavedLink(state, group.id, group.links[0].id, { windowId: 1, remove: false });
  await openSavedGroup(state, group.id, { windowId: 1, remove: false });
  assert.deepEqual(state.groups, before);
});

test("older saved libraries default to keep and persisted remove preferences survive reads", async () => {
  const mock = mockChrome(); const { state } = library(); delete state.settings;
  mock.data.tabHarbor = structuredClone(state);
  assert.deepEqual((await readState()).settings, { removeAfterOpen: false, includeNewTabs: true });
  mock.data.tabHarbor.settings = { removeAfterOpen: true };
  assert.equal((await readState()).settings.removeAfterOpen, true);
});

test("single-tab opening creates an unloaded background placeholder and preserves focus", async () => {
  const mock = mockChrome({ tabs: [tab(1)] }); const { state, group } = library({ count: 1 });
  const opened = await openSavedLink(state, group.id, group.links[0].id, { windowId: 1 });
  const created = mock.live.find(tab => tab.id === opened.tabIds[0]);
  assert.equal(created.active, false); assert.equal(created.discarded, true); assert.equal(created.status, "unloaded");
  assert.ok(created.url.startsWith(`${LAZY_BASE}#`)); assert.equal(mock.live.find(tab => tab.active).id, 1);
  assert.ok(!mock.log.some(item => item[0] === "update" && item[2]?.active));
});

test("a discard failure reports a warning and still never creates the target website", async () => {
  const mock = mockChrome({ tabs: [tab(1)], failDiscard: true }); const { state, group } = library({ count: 1 });
  const opened = await openSavedLink(state, group.id, group.links[0].id, { windowId: 1 });
  assert.equal(opened.warnings.length, 1); assert.equal(mock.live.find(tab => tab.active).id, 1);
  const created = mock.live.find(tab => tab.id === opened.tabIds[0]);
  assert.ok(created.url.startsWith(`${LAZY_BASE}#`)); assert.notEqual(created.url, group.links[0].url);
});
