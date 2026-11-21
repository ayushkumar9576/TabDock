import test from "node:test";
import assert from "node:assert/strict";
import { mockChrome, tab } from "./mock-chrome.js";
import { initialState, savableTabUrl, isNewTabUrl, makeLink, lazyUrl, parseLazyUrl } from "../shared/model.js";
mockChrome();
const { saveBrowserGroup } = await import("../background/save.js");
const { prepareMove, commitMove, undoMove } = await import("../background/moves.js");
const { LAZY_BASE, openSavedGroup } = await import("../background/open.js");

function fiveTabs({ first = "https://example.com/1", clicked = 2 } = {}) {
  return mockChrome({
    tabs: [...Array.from({ length: 5 }, (_, index) => tab(index + 1, {
      groupId: 7, active: index + 1 === clicked, ...(index === 0 ? { url: first, title: "First tab" } : {}),
    })), tab(9, { index: 5, active: false })], groups: [{ id: 7, title: "Five tabs", color: "purple", collapsed: false, windowId: 1 }]
  });
}

test("every clicked position captures all five group members in original order", async () => {
  for (const clicked of [1, 2, 3, 4, 5]) {
    const mock = fiveTabs({ clicked }); const state = initialState();
    const saved = await saveBrowserGroup(state, { tabId: clicked, windowId: 1 });
    assert.equal(saved.savedCount, 5); assert.deepEqual(state.groups[0].links.map(link => link.url), Array.from({ length: 5 }, (_, index) => `https://example.com/${index + 1}`));
    const plan = await prepareMove(initialState(), { scope: "group", tabId: clicked, windowId: 1 });
    assert.deepEqual(plan.groups[0].tabs.map(tab => tab.id), [1, 2, 3, 4, 5]);
    assert.equal(mock.live.length, 6);
  }
});

test("including New Tab pages saves and moves the first tab when launched from the second", async () => {
  const mock = fiveTabs({ first: "chrome://newtab/" }); const state = initialState();
  const copied = await saveBrowserGroup(state, { tabId: 2, windowId: 1 });
  assert.equal(copied.savedCount, 5); assert.equal(state.groups[0].links[0].url, "chrome://newtab/");
  assert.equal(mock.live.filter(tab => tab.groupId === 7).length, 5);
  const moveState = initialState(); const plan = await prepareMove(moveState, { scope: "group", tabId: 2, windowId: 1 });
  assert.deepEqual(plan.groups[0].tabs.map(tab => tab.id), [1, 2, 3, 4, 5]);
  const moved = await commitMove(moveState, plan.id);
  assert.equal(moved.undo.entries.filter(entry => entry.closed).length, 5);
  assert.equal(moveState.groups[0].links.length, 5); assert.equal(mock.live.some(tab => tab.groupId === 7), false);
});

test("excluding New Tab pages closes them during Add while keeping website tabs open", async () => {
  const mock = fiveTabs({ first: "brave://newtab/" }); const state = initialState(); state.settings.includeNewTabs = false;
  const copied = await saveBrowserGroup(state, { tabId: 2, windowId: 1 });
  assert.equal(copied.savedCount, 4); assert.equal(copied.discardedCount, 1);
  assert.deepEqual(state.groups[0].links.map(link => link.url), [2, 3, 4, 5].map(index => `https://example.com/${index}`));
  assert.deepEqual(mock.live.filter(tab => tab.groupId === 7).map(tab => tab.id), [2, 3, 4, 5]);
  assert.ok(mock.log.findIndex(item => item[0] === "store") < mock.log.findIndex(item => item[0] === "remove"));
});

test("excluding empty pages still closes the whole source group during Move", async () => {
  const mock = fiveTabs({ first: "about:blank" }); const state = initialState(); state.settings.includeNewTabs = false;
  const plan = await prepareMove(state, { scope: "group", tabId: 2, windowId: 1 });
  assert.equal(plan.excludedTabs[0].id, 1);
  const moved = await commitMove(state, plan.id);
  assert.equal(moved.discardedCount, 1); assert.equal(moved.undo.entries.length, 5);
  assert.equal(state.groups[0].links.length, 4); assert.equal(mock.live.some(tab => tab.groupId === 7), false);
  await undoMove(state, moved.undo.id);
  assert.equal(mock.live.filter(tab => tab.groupId >= 0).length, 5);
  assert.equal(state.groups.length, 0);
});

test("a group containing only excluded New Tabs is removed without an empty saved group", async () => {
  const fixture = () => mockChrome({
    tabs: [tab(1, { groupId: 7, url: "chrome://newtab/" }), tab(2, { groupId: 7, url: "about:blank" }), tab(9, { index: 2, active: false })],
    groups: [{ id: 7, title: "Empty tabs", color: "blue", collapsed: false, windowId: 1 }]
  });
  const copyMock = fixture(); const copyState = initialState(); copyState.settings.includeNewTabs = false;
  const copied = await saveBrowserGroup(copyState, { tabId: 2, windowId: 1 });
  assert.equal(copied.savedCount, 0); assert.equal(copied.groupId, null); assert.equal(copied.discardedCount, 2);
  assert.equal(copyState.groups.length, 0); assert.equal(copyMock.live.some(tab => tab.groupId === 7), false);
  const moveMock = fixture(); const moveState = initialState(); moveState.settings.includeNewTabs = false;
  const plan = await prepareMove(moveState, { scope: "group", tabId: 2, windowId: 1 });
  assert.equal(plan.groups.length, 0); assert.equal(plan.excludedTabs.length, 2);
  const moved = await commitMove(moveState, plan.id);
  assert.equal(moved.discardedCount, 2); assert.equal(moveState.groups.length, 0); assert.equal(moveMock.live.some(tab => tab.groupId === 7), false);
});

test("a membership change aborts the whole-group move before any tabs close", async () => {
  const mock = fiveTabs(); const state = initialState();
  const plan = await prepareMove(state, { scope: "group", tabId: 2, windowId: 1 });
  mock.live.push(tab(10, { groupId: 7, index: 6, active: false }));
  await assert.rejects(commitMove(state, plan.id), /membership changed/);
  assert.equal(state.groups.length, 0); assert.ok(!mock.log.some(item => item[0] === "remove"));
});

test("an unsupported member stops capture instead of silently saving only part of the group", async () => {
  const mock = fiveTabs({ first: "chrome://settings/" });
  await assert.rejects(saveBrowserGroup(initialState(), { tabId: 2, windowId: 1 }), /No tabs were added or moved/);
  await assert.rejects(prepareMove(initialState(), { scope: "group", tabId: 2, windowId: 1 }), /No tabs were added or moved/);
  assert.equal(mock.live.length, 6); assert.ok(!mock.log.some(item => item[0] === "remove"));
});

test("empty-page URLs round trip through unloaded restoration without permitting other internal URLs", async () => {
  for (const url of ["about:blank", "chrome://newtab/", "brave://newtab/", "edge://newtab/"]) {
    assert.equal(savableTabUrl(url), url); assert.equal(isNewTabUrl(url), true);
    const link = makeLink({ url }); assert.equal(parseLazyUrl(lazyUrl(LAZY_BASE, link), LAZY_BASE).url, url);
  }
  for (const url of ["chrome://quit", "chrome://restart", "chrome://settings", "javascript:alert(1)"]) assert.equal(savableTabUrl(url), null);
  const mock = fiveTabs({ first: "chrome://newtab/" }); const state = initialState();
  const copied = await saveBrowserGroup(state, { tabId: 2, windowId: 1 });
  const opened = await openSavedGroup(state, copied.groupId, { windowId: 1 });
  assert.equal(opened.tabIds.length, 5);
  assert.ok(mock.live.filter(tab => opened.tabIds.includes(tab.id)).every(tab => tab.discarded && tab.status === "unloaded" && !tab.active));
});
