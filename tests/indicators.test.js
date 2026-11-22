import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { mockChrome, tab } from "./mock-chrome.js";
import { parseLazyUrl } from "../shared/model.js";
mockChrome();
const { syncTabIndicator, syncGroupIndicator, cleanBrowserTabs, cleanBrowserGroup, restoreGroupIndicators, registerIndicators, rememberTabTitle } = await import("../background/indicators.js");

function pageMock(options = {}) {
  const mock = mockChrome(options);
  const installed = new Set(), originalTitles = new Map();
  mock.chrome.permissions = { contains: async () => true };
  mock.chrome.scripting = { executeScript: async ({ target }) => { installed.add(target.tabId); } };
  mock.chrome.tabs.sendMessage = async (tabId, message) => {
    if (!installed.has(tabId)) throw new Error("No receiver");
    const page = mock.live.find(tab => tab.id === tabId);
    const title = originalTitles.get(tabId) ?? page.title;
    if (message.starred) { originalTitles.set(tabId, title); page.title = `★ ${title}`; }
    else { page.title = title; originalTitles.delete(tabId); }
    return { title, displayed: page.title };
  };
  return mock;
}

test("loaded tab symbols preserve original titles and remove cleanly without reloading", async () => {
  const mock = pageMock({ tabs: [tab(1, { title: "★ Original page star" })] });
  await syncTabIndicator(mock.live[0], true);
  assert.equal(mock.live[0].title, "★ ★ Original page star");
  assert.equal((await cleanBrowserTabs(mock.live))[0].title, "★ Original page star");
  await syncTabIndicator(mock.live[0], false);
  assert.equal(mock.live[0].title, "★ Original page star");
  assert.equal(mock.live[0].url, "https://example.com/1");
  assert.ok(!mock.log.some(item => item[0] === "update" || item[0] === "discard"));
});

test("native group symbols follow renaming and restore the underlying group name", async () => {
  const mock = mockChrome({ groups: [{ id: 7, title: "Research", color: "purple", collapsed: true, windowId: 1 }] });
  await syncGroupIndicator(7, true); assert.equal(mock.native.get(7).title, "★ Research");
  mock.native.get(7).title = "★ New research";
  await syncGroupIndicator(7, true); assert.equal(mock.native.get(7).title, "★ New research");
  assert.equal((await cleanBrowserGroup(mock.native.get(7))).title, "New research");
  await syncGroupIndicator(7, false);
  assert.deepEqual(mock.native.get(7), { id: 7, title: "New research", color: "purple", collapsed: true, windowId: 1 });
});

test("a group name's original star is preserved when un-starring", async () => {
  const mock = mockChrome({ groups: [{ id: 7, title: "★ Favorites", windowId: 1 }] });
  await syncGroupIndicator(7, true); assert.equal(mock.native.get(7).title, "★ ★ Favorites");
  await syncGroupIndicator(7, false); assert.equal(mock.native.get(7).title, "★ Favorites");
});

test("updating a discarded tab's symbol keeps its website unloaded and uses its original URL", async () => {
  const mock = mockChrome({ tabs: [tab(1), tab(2, { title: "★ Sleeping", discarded: true })], discardRemaps: true });
  await rememberTabTitle(2, "Sleeping");
  const sleeping = await syncTabIndicator(mock.live[1], false);
  assert.equal(sleeping.discarded, true); assert.notEqual(sleeping.id, 2);
  const link = parseLazyUrl(sleeping.url, mock.chrome.runtime.getURL("pages/lazy.html"));
  assert.deepEqual(link, { url: "https://example.com/2", title: "Sleeping", favicon: "https://example.com/icon2.png" });
  assert.equal(mock.live[0].active, true);
  assert.ok(mock.log.filter(item => item[0] === "update").every(item => item[2].url.startsWith(mock.chrome.runtime.getURL("pages/lazy.html"))));
});

test("stale group indicators clear after stars reset, including changed native IDs", async () => {
  const mock = mockChrome({ groups: [{ id: 7, title: "Research", windowId: 1 }] });
  mock.chrome.tabGroups.query = async () => [...mock.native.values()];
  await syncGroupIndicator(7, true);
  const renamedId = { ...mock.native.get(7), id: 9 };
  mock.native.delete(7); mock.native.set(9, renamedId);
  await restoreGroupIndicators({ groupIds: [] });
  assert.equal(mock.native.get(9).title, "Research");
});

test("startup removes the old global injector without registering scripts on unstarred pages", async () => {
  const mock = mockChrome(); let registrations = 0, removals = 0; let registered = [{ id: "tabdock-star-indicator" }];
  mock.chrome.permissions = { contains: async () => true };
  mock.chrome.scripting = { getRegisteredContentScripts: async () => registered, registerContentScripts: async items => { registrations++; registered = items; }, unregisterContentScripts: async () => { removals++; registered = []; } };
  await Promise.all([registerIndicators(), registerIndicators()]);
  assert.equal(registrations, 0); assert.equal(removals, 1); assert.deepEqual(registered, []);
});

test("the content script handles dynamic titles, natural stars, and repeated injection", async () => {
  const source = readFileSync(new URL("../content/star-indicator.js", import.meta.url), "utf8");
  const attributes = new Map(); let changed, listener, observerCount = 0, messages = 0, connected = false; const observed = [];
  const titleElement = { getAttribute: key => attributes.get(key) ?? null, setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key) };
  const document = { title: "★ Favorites", head: {}, querySelector: () => titleElement };
  const context = { document, MutationObserver: class { constructor(callback) { changed = callback; observerCount++; } observe(target, options) { connected = true; observed.push({ target, options }); } disconnect() { connected = false; } }, chrome: { runtime: { id: "test", getURL: () => "", sendMessage: async () => { messages++; return { ok: true, data: { starred: false } }; }, onMessage: { addListener: callback => { listener = callback; } } } } };
  runInNewContext(source, context); await Promise.resolve(); await Promise.resolve();
  assert.equal(observerCount, 0); assert.equal(messages, 0);
  listener({ type: "SET_TAB_STAR_INDICATOR", starred: true }, { id: "test" }, () => { });
  assert.equal(document.title, "★ ★ Favorites");
  assert.equal(observed.find(item => item.target === document.head).options.subtree, undefined);
  document.title = "New title"; changed(); assert.equal(document.title, "★ New title");
  changed(); assert.equal(document.title, "★ New title");
  runInNewContext(source, context); assert.equal(document.title, "★ New title");
  listener({ type: "SET_TAB_STAR_INDICATOR", starred: false }, { id: "test" }, () => { });
  assert.equal(document.title, "New title"); assert.equal(attributes.size, 0);
  assert.equal(connected, false); assert.equal(messages, 0, "Title changes must not message or keep alive the worker");
});

test("unchanged indicators do not rewrite ownership, and dynamic titles still save correctly", async () => {
  const mock = pageMock({ tabs: [tab(1)] });
  await syncTabIndicator(mock.live[0], true);
  const writes = mock.log.filter(item => ["store", "session-store"].includes(item[0])).length;
  await syncTabIndicator(mock.live[0], true);
  assert.equal(mock.log.filter(item => ["store", "session-store"].includes(item[0])).length, writes);
  mock.live[0].title = "★ New page title";
  assert.equal((await cleanBrowserTabs(mock.live))[0].title, "New page title");
});
