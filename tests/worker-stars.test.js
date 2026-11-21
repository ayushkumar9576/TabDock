import test from "node:test";
import assert from "node:assert/strict";
import { mockChrome, tab } from "./mock-chrome.js";
import { initialState } from "../shared/model.js";

function event() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    dispatch: (...args) => Promise.all([...listeners].map(listener => listener(...args))),
  };
}

test("right-click actions and browser events route star behavior through the worker", async () => {
  const mock = mockChrome({ tabs: [tab(1, { groupId: 7 }), tab(2, { groupId: 7 }), tab(3)], groups: [{ id: 7, title: "Work", windowId: 1 }] });
  mock.data.tabHarbor = initialState();
  const { chrome } = mock;
  chrome.runtime.onMessage = event(); chrome.runtime.onInstalled = event(); chrome.runtime.onStartup = event();
  chrome.storage.onChanged = event();
  chrome.commands = { onCommand: event() };
  chrome.action = { setBadgeText: async () => { }, setBadgeBackgroundColor: async () => { } };
  chrome.contextMenus = { onClicked: event(), create: (properties, callback) => callback(), removeAll: async () => { }, remove: async () => { } };
  for (const name of ["onActivated", "onReplaced", "onCreated", "onAttached", "onRemoved"]) chrome.tabs[name] = event();
  chrome.tabGroups.onRemoved = event();
  chrome.tabGroups.onUpdated = event();
  chrome.permissions = { onAdded: event() };
  await import("../background/worker.js");
  const { getStars } = await import("../background/stars.js");

  await chrome.contextMenus.onClicked.dispatch({ menuItemId: "star-tab" }, mock.live[0]);
  assert.deepEqual((await getStars()).tabIds, [1]); assert.equal(mock.live[0].discarded, false);
  await chrome.tabs.update(3, { active: true });
  await chrome.tabs.onActivated.dispatch({ tabId: 3, windowId: 1 }); await getStars();
  assert.equal(mock.live[0].discarded, true); assert.equal(mock.live[1].discarded, false);

  await chrome.contextMenus.onClicked.dispatch({ menuItemId: "star-native" }, mock.live[1]);
  assert.deepEqual((await getStars()).groupIds, [7]); assert.equal(mock.live[1].discarded, true);
  await chrome.contextMenus.onClicked.dispatch({ menuItemId: "unstar-native" }, mock.live[1]);
  assert.deepEqual((await getStars()).groupIds, []); assert.deepEqual((await getStars()).tabIds, [1]);
  await chrome.contextMenus.onClicked.dispatch({ menuItemId: "unstar-tab" }, mock.live[0]);
  assert.deepEqual((await getStars()).tabIds, []);
  assert.deepEqual(mock.data.tabHarbor.groups, []);
});
