import test from "node:test";
import assert from "node:assert/strict";
import { mockChrome, tab } from "./mock-chrome.js";
import { initialState, lazyUrl } from "../shared/model.js";
import { writeState } from "../shared/storage.js";

let moduleId = 0;
async function setup(options = {}) {
  const mock = mockChrome(options);
  const stars = await import(`../background/stars.js?test=${moduleId++}`);
  return { ...mock, ...stars };
}
const group = { id: 7, title: "Work", color: "blue", collapsed: false, windowId: 1 };

test("star-all mode applies immediately across windows without changing manual stars or the saved library", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2, { pinned: true }), tab(3, { windowId: 2, active: true }), tab(4, { windowId: 2 })] });
  const state = initialState(); state.settings.starAllTabs = true;
  mock.data.tabHarbor = structuredClone(state);
  assert.deepEqual((await mock.restoreStars()).warnings, []);
  assert.deepEqual(mock.live.map(tab => tab.discarded), [false, true, false, true]);
  assert.deepEqual(await mock.getTabStar(1), { starred: true });
  assert.deepEqual(await mock.getTabStar(2), { starred: true });
  assert.deepEqual(await mock.getStars(), { tabIds: [], groupIds: [] });
  assert.deepEqual(mock.data.tabHarbor, state);
  assert.ok(mock.live[1].pinned);
  assert.ok(!mock.log.some(item => item[0] === "create" || item[0] === "remove"));
});

test("star-all mode covers new and restored tabs and keeps each window's selected tab loaded", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2, { windowId: 2, active: true })] });
  mock.data.tabHarbor = initialState(); mock.data.tabHarbor.settings.starAllTabs = true;
  await writeState(mock.data.tabHarbor);
  const inactive = await mock.chrome.tabs.create({ url: "https://example.com/new", active: false });
  await mock.enforceStarredTab(inactive.id);
  assert.equal(mock.live.find(tab => tab.id === inactive.id).discarded, true);
  const active = await mock.chrome.tabs.create({ url: "https://example.com/active", active: true });
  mock.live.find(tab => tab.id === 2).active = true;
  await mock.enforceStarredTab(active.id);
  assert.equal(mock.live.find(tab => tab.id === active.id).discarded, false);
  await mock.enforceStars(1);
  assert.equal(mock.live.find(tab => tab.id === 1).discarded, true);
  assert.equal(mock.live.find(tab => tab.id === 2).discarded, false);
  const url = lazyUrl(mock.chrome.runtime.getURL("pages/lazy.html"), { url: "https://example.com/restored", title: "Restored" });
  const restored = await mock.chrome.tabs.create({ url, active: false });
  assert.deepEqual(await mock.getTabStar(restored.id), { starred: true });
  await mock.enforceStarredTab(restored.id);
  assert.equal(mock.live.find(tab => tab.id === restored.id).discarded, true);
});

test("star-all mode survives a new browser session and Brave replacement tab IDs", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2)], discardRemaps: true });
  mock.data.tabHarbor = initialState(); mock.data.tabHarbor.settings.starAllTabs = true;
  await writeState(mock.data.tabHarbor);
  await mock.enforceStars(1);
  const replacementId = mock.live[1].id;
  assert.notEqual(replacementId, 2);
  mock.live[1].discarded = false;
  for (const key of Object.keys(mock.sessionData)) delete mock.sessionData[key];
  const restarted = await import(`../background/stars.js?test=${moduleId++}`);
  await restarted.restoreStars();
  assert.equal(mock.live[1].discarded, true);
  assert.deepEqual(await restarted.getTabStar(mock.live[1].id), { starred: true });
  assert.deepEqual(await restarted.getStars(), { tabIds: [], groupIds: [] });
});

test("turning star-all off stops automatic discarding and preserves manual tab and group stars", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2), tab(3, { groupId: 7 }), tab(4)], groups: [group] });
  await mock.setTabStar(2, true); await mock.setGroupStar(3, true);
  const manual = await mock.getStars();
  mock.data.tabHarbor = initialState(); mock.data.tabHarbor.settings.starAllTabs = true;
  await writeState(mock.data.tabHarbor);
  await mock.restoreStars();
  mock.data.tabHarbor.settings.starAllTabs = false;
  await writeState(mock.data.tabHarbor);
  await mock.restoreStars();
  assert.ok(mock.live.slice(1).every(tab => tab.discarded), "Disabling must not reload websites");
  assert.deepEqual(await mock.getStars(), manual);
  assert.deepEqual(await mock.getTabStar(1), { starred: false });
  assert.deepEqual(await mock.getTabStar(2), { starred: true });
  assert.deepEqual(await mock.getTabStar(3), { starred: true });
  assert.deepEqual(await mock.getTabStar(4), { starred: false });
  for (const tab of mock.live) tab.discarded = false;
  await mock.enforceStars(1);
  assert.deepEqual(mock.live.map(tab => tab.discarded), [false, true, true, false]);
});

test("removing manual stars while star-all is on keeps the global behavior until disabled", async () => {
  const mock = await setup({ tabs: [tab(1, { groupId: 7 }), tab(2, { groupId: 7 })], groups: [group] });
  mock.data.tabHarbor = initialState(); mock.data.tabHarbor.settings.starAllTabs = true;
  await writeState(mock.data.tabHarbor);
  await mock.setTabStar(1, true); await mock.setGroupStar(1, true);
  assert.match((await mock.setTabStar(1, false)).message, /still follows Star all/);
  assert.match((await mock.setGroupStar(1, false)).message, /still follow Star all/);
  assert.deepEqual(await mock.getStars(), { tabIds: [], groupIds: [] });
  assert.deepEqual(await mock.getTabStar(1), { starred: true });
  mock.data.tabHarbor.settings.starAllTabs = false;
  await writeState(mock.data.tabHarbor);
  assert.deepEqual(await mock.getTabStar(1), { starred: false });
});

test("star-all skips protected pages, includes New Tab and blank pages, and reports discard failures", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2, { url: "chrome://settings" }), tab(3, { url: "brave://newtab/" }), tab(4, { url: "about:blank" })], failDiscard: true });
  mock.data.tabHarbor = initialState(); mock.data.tabHarbor.settings.starAllTabs = true;
  const result = await mock.enforceStars();
  assert.equal(result.warnings.length, 2);
  assert.deepEqual(await mock.getTabStar(2), { starred: false });
  assert.deepEqual(mock.log.filter(item => item[0] === "discard").map(item => item[1]), [3, 4]);
  assert.ok(mock.live.every(tab => !tab.discarded));
});

test("starring an active browser tab keeps it loaded and discards it when selection changes", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2)] });
  await mock.setTabStar(1, true);
  assert.equal(mock.live[0].discarded, false);
  await mock.chrome.tabs.update(2, { active: true });
  await mock.enforceStars(1);
  assert.equal(mock.live[0].discarded, true); assert.equal(mock.live[1].discarded, false);
  assert.equal(mock.live[0].url, "https://example.com/1"); assert.equal(mock.live[0].id, 1);
  assert.deepEqual((await mock.getStars()).tabIds, [1]);
  assert.equal(mock.data.tabHarbor, undefined, "Starring never adds pages to the saved library");
});

test("starring an inactive tab discards it immediately while unrelated tabs stay loaded", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2), tab(3)] });
  const result = await mock.setTabStar(2, true);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(mock.live.map(tab => tab.discarded), [false, true, false]);
  await mock.enforceStars(1);
  assert.equal(mock.log.filter(item => item[0] === "discard").length, 1);
});

test("an individual tab inside an unstarred browser group can be starred", async () => {
  const mock = await setup({ tabs: [tab(1, { groupId: 7 }), tab(2, { groupId: 7 }), tab(3, { groupId: 7 })], groups: [group] });
  await mock.setTabStar(2, true);
  assert.deepEqual(mock.live.map(tab => tab.discarded), [false, true, false]);
  assert.deepEqual(await mock.getStars(), { tabIds: [2], groupIds: [] });
  assert.deepEqual(mock.native.get(7), group);
});

test("starring a group discards inactive members and makes later members inherit the policy", async () => {
  const mock = await setup({ tabs: [tab(1, { groupId: 7 }), tab(2, { groupId: 7 }), tab(3)], groups: [group] });
  await mock.setGroupStar(1, true);
  assert.deepEqual(mock.live.map(tab => tab.discarded), [false, true, false]);
  await mock.chrome.tabs.group({ tabIds: [3], groupId: 7 });
  await mock.enforceStarredTab(3);
  assert.equal(mock.live[2].discarded, true);
  assert.deepEqual(await mock.getStars(), { tabIds: [], groupIds: [7] });
  assert.deepEqual(mock.native.get(7), { ...group, title: "★ Work" });
});

test("an active tab added to a starred group stays loaded until the next switch", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2, { groupId: 7 })], groups: [group] });
  await mock.setGroupStar(2, true);
  await mock.chrome.tabs.group({ tabIds: [1], groupId: 7 });
  await mock.enforceStarredTab(1);
  assert.equal(mock.live[0].discarded, false);
  await mock.chrome.tabs.update(2, { active: true });
  await mock.enforceStars(1);
  assert.equal(mock.live[0].discarded, true);
});

test("moving a tab out of a starred group ends inheritance without removing its individual star", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2, { groupId: 7 }), tab(3, { groupId: 7 })], groups: [group] });
  await mock.setGroupStar(2, true); await mock.setTabStar(3, true);
  for (const tab of mock.live.slice(1)) { tab.groupId = -1; tab.discarded = false; }
  await mock.enforceStars(1);
  assert.equal(mock.live[1].discarded, false); assert.equal(mock.live[2].discarded, true);
});

test("un-starring a group preserves individually starred members", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2, { groupId: 7 }), tab(3, { groupId: 7 })], groups: [group] });
  await mock.setTabStar(3, true); await mock.setGroupStar(2, true);
  await mock.setGroupStar(2, false);
  for (const tab of mock.live) tab.discarded = false;
  await mock.enforceStars(1);
  assert.deepEqual(mock.live.map(tab => tab.discarded), [false, false, true]);
  assert.deepEqual(await mock.getStars(), { tabIds: [3], groupIds: [] });
});

test("removing an individual star still obeys a starred group until the group is unstarred", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2, { groupId: 7 })], groups: [group] });
  await mock.setTabStar(2, true); await mock.setGroupStar(2, true);
  const result = await mock.setTabStar(2, false);
  assert.match(result.message, /still follows/);
  assert.deepEqual(await mock.getStars(), { tabIds: [], groupIds: [7] });
  await mock.setGroupStar(2, false);
  mock.live[1].discarded = false;
  await mock.enforceStars(1);
  assert.equal(mock.live[1].discarded, false);
});

test("un-starring stops future discards without waking an already discarded tab", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2)] });
  await mock.setTabStar(2, true); await mock.setTabStar(2, false);
  assert.equal(mock.live[1].discarded, true);
  mock.live[1].discarded = false;
  await mock.enforceStars(1);
  assert.equal(mock.live[1].discarded, false);
});

test("a failed discard leaves the tab intact and the star available for a later attempt", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2)], failDiscard: true });
  const result = await mock.setTabStar(2, true);
  assert.match(result.warnings[0], /Could not discard starred tab/);
  assert.equal(mock.live[1].discarded, false); assert.equal(mock.live[1].url, "https://example.com/2");
  assert.deepEqual((await mock.getStars()).tabIds, [2]);
});

test("a failed star storage write never discards a browser tab", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2)], failStorage: true });
  await assert.rejects(mock.setTabStar(2, true), /Storage quota exceeded/);
  assert.deepEqual((await mock.getStars()).tabIds, []);
  assert.ok(!mock.log.some(item => item[0] === "discard"));
});

test("stars survive service-worker reload and track Brave discard replacement IDs", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2)], discardRemaps: true });
  await mock.setTabStar(2, true);
  const replacementId = mock.live[1].id;
  assert.notEqual(replacementId, 2);
  assert.deepEqual((await mock.getStars()).tabIds, [replacementId]);
  const reloaded = await import(`../background/stars.js?test=${moduleId++}`);
  assert.deepEqual((await reloaded.getStars()).tabIds, [replacementId]);
  mock.live[1].discarded = false;
  await reloaded.enforceStars(1);
  assert.equal(mock.live[1].discarded, true);
});

test("closed tabs and removed groups are cleaned up without affecting remaining stars", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2, { groupId: 7 })], groups: [group] });
  await mock.setTabStar(1, true); await mock.setTabStar(2, true); await mock.setGroupStar(2, true);
  await mock.removeTabStar(2); await mock.removeGroupStar(7);
  assert.deepEqual(await mock.getStars(), { tabIds: [1], groupIds: [] });
});

test("replacement events migrate individual stars, and restoration removes stale session IDs", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2)] });
  await mock.setTabStar(1, true);
  await mock.replaceTabStar(2, 1);
  assert.deepEqual((await mock.getStars()).tabIds, [2]);
  mock.live.splice(1, 1);
  await mock.restoreStars();
  assert.deepEqual(await mock.getStars(), { tabIds: [], groupIds: [] });
});

test("window-local selection changes leave active starred tabs in other windows loaded", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2), tab(3, { windowId: 2, active: true })] });
  await mock.setTabStar(1, true);
  // Avoid the mock's one-window validation when seeding a second window's star.
  mock.sessionData[mock.STARS_KEY].tabIds.push(3);
  const reloaded = await import(`../background/stars.js?test=${moduleId++}`);
  await mock.chrome.tabs.update(2, { active: true }); mock.live[2].active = true;
  await reloaded.enforceStars(1);
  assert.equal(mock.live[0].discarded, true); assert.equal(mock.live[2].discarded, false);
});

test("unsupported pages and tabs outside browser groups cannot be starred as groups", async () => {
  const mock = await setup({ tabs: [tab(1, { url: "chrome://settings" }), tab(2)] });
  await assert.rejects(mock.setTabStar(1, true), /Only web pages/);
  await assert.rejects(mock.setGroupStar(2, true), /not in a browser group/);
  assert.deepEqual(await mock.getStars(), { tabIds: [], groupIds: [] });
});
