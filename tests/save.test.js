import test from "node:test";
import assert from "node:assert/strict";
import { mockChrome, tab } from "./mock-chrome.js";
import { initialState, makeGroup, makeLink, lazyUrl } from "../shared/model.js";
mockChrome();
const { savePage, saveBrowserGroup } = await import("../background/save.js");
const { LAZY_BASE } = await import("../background/open.js");

test("pages can be added as individual tabs or appended to an existing named group", async () => {
  const mock = mockChrome(); const state = initialState(); const group = makeGroup({ name: "Reading" }); state.groups.push(group);
  const individual = await savePage(state, { url: "https://example.com/one", title: "One" });
  assert.equal(state.groups.find(item => item.id === individual.groupId).ungrouped, true);
  const grouped = await savePage(state, { groupId: group.id, url: "https://example.com/two", title: "Two" });
  assert.equal(grouped.groupId, group.id); assert.equal(group.links[0].id, grouped.linkId);
  assert.equal(mock.data.tabHarbor.groups.flatMap(item => item.links).length, 2);
  assert.ok(!mock.log.some(item => ["create", "remove"].includes(item[0])));
});

test("adding a whole native group preserves its metadata and leaves every source tab open", async () => {
  const deferred = makeLink({ url: "https://example.com/original", title: "Original title", favicon: "https://example.com/icon.png" });
  const mock = mockChrome({
    tabs: [tab(1, { groupId: 7 }), tab(2, { groupId: 7, url: lazyUrl(LAZY_BASE, deferred) }), tab(3, { groupId: 7, url: "about:blank" })],
    groups: [{ id: 7, title: "", color: "purple", collapsed: true, windowId: 1 }]
  });
  const before = structuredClone(mock.live); const state = initialState();
  const saved = await saveBrowserGroup(state, { windowId: 1, tabId: 1 });
  const group = state.groups.find(item => item.id === saved.groupId);
  assert.equal(saved.savedCount, 3); assert.equal(saved.warnings.length, 0); assert.equal(group.nativeTitle, "");
  assert.equal(group.color, "purple"); assert.equal(group.collapsed, true);
  assert.deepEqual(group.links.map(link => link.url), ["https://example.com/1", deferred.url, "about:blank"]);
  assert.equal(group.links[1].title, deferred.title); assert.equal(group.links[1].favicon, deferred.favicon);
  assert.deepEqual(mock.live, before); assert.ok(!mock.log.some(item => ["create", "remove"].includes(item[0])));
});

test("adding a same-name native group creates a distinct saved copy", async () => {
  mockChrome({ tabs: [tab(1, { groupId: 7 })], groups: [{ id: 7, title: "Reading", color: "red", collapsed: true, windowId: 1 }] });
  const state = initialState(); const original = makeGroup({ name: "Reading" }); state.groups.push(original);
  const saved = await saveBrowserGroup(state, { windowId: 1, nativeGroupId: 7 });
  assert.equal(state.groups.length, 2); assert.notEqual(saved.groupId, original.id); assert.deepEqual(original.links, []);
});

test("copy failures and unsupported groups never close browser tabs", async () => {
  const mock = mockChrome({ tabs: [tab(1, { groupId: 7 })], groups: [{ id: 7, title: "Reading", color: "red", collapsed: false, windowId: 1 }], failStorage: true });
  await assert.rejects(saveBrowserGroup(initialState(), { windowId: 1, nativeGroupId: 7 }), /quota/);
  assert.equal(mock.live.length, 1); assert.ok(!mock.log.some(item => item[0] === "remove"));
  mock.live[0].url = "chrome://settings";
  await assert.rejects(saveBrowserGroup(initialState(), { windowId: 1, nativeGroupId: 7 }), /cannot be saved/);
  assert.equal(mock.live.length, 1);
});
