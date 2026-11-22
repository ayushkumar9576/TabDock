import test from "node:test";
import assert from "node:assert/strict";
import { mockChrome, tab } from "./mock-chrome.js";
import { lazyUrl, parseLazyUrl } from "../shared/model.js";

const KEY = "tabDockPersistentStars";
let sequence = 0;
async function setup(options, local = {}) {
  const mock = mockChrome(options);
  Object.assign(mock.data, structuredClone(local));
  return { ...mock, ...await import(`../background/stars.js?restart=${sequence++}`) };
}
const group = (id, overrides = {}) => ({ id, windowId: 1, title: "Research", color: "purple", collapsed: false, ...overrides });

test("manual tab and group stars survive changed IDs without starring unrelated reused IDs", async () => {
  const before = await setup({ tabs: [tab(1), tab(2, { groupId: 7 }), tab(3, { groupId: 7 })], groups: [group(7)] });
  await before.setTabStar(1, true); await before.setGroupStar(2, true);
  const after = await setup({ tabs: [tab(1, { url: "https://unrelated.example/", active: false }), tab(10, { url: tab(1).url, active: true }), tab(20, { url: tab(2).url, groupId: 70 }), tab(30, { url: tab(3).url, groupId: 70 })], groups: [group(70, { title: "★ Research" })] }, before.data);
  await after.restoreStars();
  assert.deepEqual(await after.getStars(), { tabIds: [10], groupIds: [70] });
  assert.deepEqual(await after.getTabStar(1), { starred: false });
  assert.equal(after.native.get(70).title, "★ Research");
  assert.equal(after.live.find(tab => tab.id === 10).discarded, false);
  assert.ok(after.live.filter(tab => tab.groupId === 70).every(tab => tab.discarded));
  await after.setGroupStar(20, false);
  assert.equal(after.native.get(70).title, "Research");
  assert.deepEqual(await after.getStars(), { tabIds: [10], groupIds: [] });
});

test("pending stars survive worker suspension while Brave restores pages and groups in stages", async () => {
  const before = await setup({ tabs: [tab(1), tab(2, { groupId: 7 })], groups: [group(7)] });
  await before.setTabStar(1, true); await before.setGroupStar(2, true);
  const after = await setup({ tabs: [] }, before.data);
  assert.deepEqual(await after.getStars(), { tabIds: [], groupIds: [] });
  const reloaded = await import(`../background/stars.js?restart=${sequence++}`);
  const first = await after.chrome.tabs.create({ url: tab(1).url, active: true });
  await reloaded.enforceStarredTab(first.id, { persist: true });
  const member = await after.chrome.tabs.create({ url: tab(2).url, active: false });
  await reloaded.enforceStarredTab(member.id, { persist: true });
  assert.equal(after.live.find(tab => tab.id === member.id).discarded, false);
  const groupId = await after.chrome.tabs.group({ tabIds: [member.id] });
  await after.chrome.tabGroups.update(groupId, { title: "Research", color: "purple" });
  await reloaded.refreshGroupIndicator(groupId);
  assert.deepEqual(await reloaded.getStars(), { tabIds: [first.id], groupIds: [groupId] });
  assert.equal(after.live.find(tab => tab.id === member.id).discarded, true);
  assert.equal(after.native.get(groupId).title, "★ Research");
});

test("duplicate URL stars bind once to the same occurrence and keep pinned pages separate", async () => {
  const url = "https://example.com/duplicate";
  const before = await setup({ tabs: [tab(1, { url, pinned: true }), tab(2, { url }), tab(3, { url })] });
  await before.setTabStar(3, true);
  const after = await setup({ tabs: [tab(11, { url, pinned: true, active: true }), tab(12, { url }), tab(13, { url })] }, before.data);
  assert.deepEqual(await after.getStars(), { tabIds: [13], groupIds: [] });
  const added = await after.chrome.tabs.create({ url, active: false });
  await after.enforceStarredTab(added.id);
  assert.deepEqual(await after.getTabStar(added.id), { starred: false });
  assert.deepEqual(await after.getTabStar(12), { starred: false });
  await after.chrome.tabs.remove(12); await after.removeTabStar(12);
  const again = await setup({ tabs: [tab(21, { url, pinned: true, active: true }), tab(23, { url }), tab(24, { url })] }, after.data);
  assert.deepEqual(await again.getStars(), { tabIds: [23], groupIds: [] });
});

test("window contents distinguish same-name groups across restarted windows", async () => {
  const before = await setup({ tabs: [tab(1, { groupId: 7 }), tab(2, { groupId: 7 }), tab(3, { windowId: 2, groupId: 8, active: true })], groups: [group(7), group(8, { windowId: 2 })] });
  await before.setGroupStar(1, true);
  const after = await setup({ tabs: [tab(31, { url: tab(3).url, windowId: 1, groupId: 80, active: true }), tab(11, { url: tab(1).url, windowId: 2, groupId: 70, active: true }), tab(12, { url: tab(2).url, windowId: 2, groupId: 70 })], groups: [group(80), group(70, { windowId: 2 })] }, before.data);
  await after.restoreStars();
  assert.deepEqual(await after.getStars(), { tabIds: [], groupIds: [70] });
  assert.deepEqual(await after.getTabStar(31), { starred: false });
  assert.equal(after.live.find(tab => tab.id === 11).discarded, false);
});

test("navigation, group renames and new members update the records used at restart", async () => {
  const before = await setup({ tabs: [tab(1), tab(2, { groupId: 7 }), tab(3)], groups: [group(7)] });
  await before.setTabStar(1, true); await before.setGroupStar(2, true);
  await before.chrome.tabs.update(1, { url: "https://example.com/changed" });
  await before.enforceStarredTab(1, { persist: true });
  await before.chrome.tabs.group({ tabIds: [3], groupId: 7 });
  await before.enforceStarredTab(3, { persist: true });
  await before.chrome.tabGroups.update(7, { title: "★ New research", color: "green" });
  await before.refreshGroupIndicator(7);
  const after = await setup({ tabs: [tab(11, { url: "https://example.com/changed", active: true }), tab(12, { url: tab(2).url, groupId: 70 }), tab(13, { url: tab(3).url, groupId: 70 })], groups: [group(70, { title: "★ New research", color: "green" })] }, before.data);
  await after.restoreStars();
  assert.deepEqual(await after.getStars(), { tabIds: [11], groupIds: [70] });
  assert.equal(after.native.get(70).title, "★ New research");
  assert.deepEqual(await after.getTabStar(13), { starred: true });
});

test("window-close events retain full group membership and individual stars for restart", async () => {
  const before = await setup({ tabs: [tab(1), tab(2, { groupId: 7 }), tab(3, { groupId: 7 })], groups: [group(7)] });
  await before.setTabStar(1, true); await before.setGroupStar(2, true);
  for (const id of [2, 1, 3]) {
    await before.chrome.tabs.remove(id);
    await before.removeTabStar(id, { isWindowClosing: true, windowId: 1 });
  }
  await before.removeGroupStar(7, 1);
  assert.deepEqual(await before.getStars(), { tabIds: [], groupIds: [] });
  assert.equal(before.data[KEY].groups[0].tabs.length, 2);
  const after = await setup({ tabs: [tab(11, { url: tab(1).url, active: true }), tab(12, { url: tab(2).url, groupId: 70 }), tab(13, { url: tab(3).url, groupId: 70 })], groups: [group(70, { title: "★ Research" })] }, before.data);
  assert.deepEqual(await after.getStars(), { tabIds: [11], groupIds: [70] });
});

test("explicit unstars and individual tab closes remain unstarred after restart", async () => {
  const before = await setup({ tabs: [tab(1), tab(2), tab(3, { groupId: 7 })], groups: [group(7)] });
  await before.setTabStar(1, true); await before.setTabStar(2, true); await before.setGroupStar(3, true);
  await before.setTabStar(1, false); await before.setGroupStar(3, false);
  await before.chrome.tabs.remove(2); await before.removeTabStar(2, { windowId: 1, isWindowClosing: false });
  const after = await setup({ tabs: [tab(11, { url: tab(1).url, active: true }), tab(12, { url: tab(2).url }), tab(13, { url: tab(3).url, groupId: 70 })], groups: [group(70)] }, before.data);
  await after.restoreStars();
  assert.deepEqual(await after.getStars(), { tabIds: [], groupIds: [] });
  assert.ok(after.live.every(tab => !tab.discarded));
});

test("restored lazy placeholders retain the target URL and manual star", async () => {
  const before = await setup({ tabs: [tab(1), tab(2)] });
  await before.setTabStar(2, true);
  const base = before.chrome.runtime.getURL("pages/lazy.html");
  const placeholder = lazyUrl(base, { url: tab(2).url, title: "Sleeping page" });
  await before.chrome.tabs.update(2, { url: placeholder }); await before.enforceStarredTab(2, { persist: true });
  const after = await setup({ tabs: [tab(11, { active: true }), tab(12, { url: placeholder, discarded: true })] }, before.data);
  await after.restoreStars();
  assert.deepEqual(await after.getTabStar(12), { starred: true });
  assert.equal(parseLazyUrl(after.live.find(tab => tab.id === 12).url, base).url, tab(2).url);
  assert.equal(after.live.find(tab => tab.id === 12).discarded, true);
});

test("persistence reads once per worker and adds no snapshots or local writes to tab switches", async () => {
  const mock = await setup({ tabs: [tab(1), tab(2)] });
  let reads = 0, writes = 0, queries = 0;
  const get = mock.chrome.storage.local.get, set = mock.chrome.storage.local.set, query = mock.chrome.tabs.query;
  mock.chrome.storage.local.get = async key => { if (key === KEY) reads++; return get(key); };
  mock.chrome.storage.local.set = async value => { if (value[KEY]) writes++; return set(value); };
  mock.chrome.tabs.query = async value => { queries++; return query(value); };
  await mock.setTabStar(1, true);
  const initial = { reads, writes, queries };
  for (let n = 0; n < 5; n++) {
    await mock.enforceStars(1); await mock.enforceStarredTab(1); await mock.getTabStar(1);
  }
  assert.equal(reads, 1); assert.equal(writes, initial.writes);
  assert.equal(queries - initial.queries, 5, "Only the existing window enforcement queries should run");
  await mock.refreshStarPersistence(1);
  assert.equal(writes, initial.writes, "Unchanged metadata must not write local storage");
});
