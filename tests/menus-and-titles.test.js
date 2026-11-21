import test from "node:test";
import assert from "node:assert/strict";
import { initialState, makeGroup } from "../shared/model.js";
import { rebuildMenus } from "../background/menus.js";
import { fetchPageTitle, linkText } from "../background/titles.js";

test("context menus offer standalone saving, hide storage buckets, and rebuild named destinations", async () => {
  const menus = new Map(); let rebuilds = 0;
  globalThis.chrome = {
    runtime: { lastError: null },
    contextMenus: { removeAll: async () => { menus.clear(); rebuilds++; }, remove: async id => menus.delete(id), create: (properties, callback) => { menus.set(properties.id, properties); callback(); } },
  };
  const state = initialState(); await rebuildMenus(state, true);
  assert.equal(menus.get("link:default").parentId, undefined);
  state.groups.push(makeGroup({ name: "First" })); await rebuildMenus(state);
  assert.equal(menus.get(`link:${state.groups[0].id}`).parentId, "link-root");
  assert.equal(menus.get("link:default").title, "As an individual tab");
  assert.deepEqual(menus.get("page:default").contexts, ["page", "action", "tab"]);
  assert.deepEqual(menus.get("park:default").contexts, ["page", "action", "tab"]);
  assert.ok(menus.has("save-native")); assert.ok(menus.has("park-native"));
  assert.deepEqual(menus.get("save-native").contexts, ["page", "action", "tab"]);
  assert.ok(!menus.has("tabdock-tab-context-probe"));
  assert.ok(menus.has(`page:${state.groups[0].id}`)); assert.ok(menus.has(`park:${state.groups[0].id}`));
  state.groups.push(makeGroup({ name: "Second" }, 1)); await rebuildMenus(state);
  assert.equal(menus.get(`link:${state.groups[1].id}`).parentId, "link-root");
  state.groups[1].name = "Renamed"; await rebuildMenus(state);
  assert.equal(menus.get(`link:${state.groups[1].id}`).title, "Renamed");
  const count = rebuilds; await rebuildMenus(state); assert.equal(rebuilds, count);
  const loose = makeGroup({ name: "Hidden tab", ungrouped: true }, 2); state.groups.push(loose); await rebuildMenus(state); assert.ok(!menus.has(`link:${loose.id}`)); assert.equal(rebuilds, count);
  state.groups = []; await rebuildMenus(state); assert.ok(menus.has("link:default"));
});
test("background title fetching is optional, credential-free, and handles URLs with ports", async () => {
  let permission; let fetchOptions;
  globalThis.chrome = { permissions: { contains: async properties => { permission = properties; return true; } } };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => { fetchOptions = options; return new Response("<html><title>Real &amp; Title</title></html>", { headers: { "content-type": "text/html" } }); };
  try {
    assert.equal(await fetchPageTitle("http://localhost:1234/test"), "Real & Title");
    assert.deepEqual(permission, { origins: ["http://localhost/*"] }); assert.equal(fetchOptions.credentials, "omit");
    chrome.permissions.contains = async () => false;
    globalThis.fetch = () => { throw new Error("Must not fetch without permission"); };
    assert.equal(await fetchPageTitle("https://example.com/test"), null);
  } finally { globalThis.fetch = original; }
});

test("browsers without tab-header contexts still get page and toolbar capture menus", async () => {
  const menus = new Map();
  globalThis.chrome = {
    runtime: { lastError: null }, contextMenus: {
      removeAll: async () => menus.clear(), remove: async id => menus.delete(id),
      create(properties, callback) {
        if (properties.contexts.includes("tab")) throw new Error("Unsupported tab context");
        menus.set(properties.id, properties); callback();
      },
    }
  };
  const fallback = await import("../background/menus.js?without-tab-context");
  await fallback.rebuildMenus(initialState(), true);
  assert.deepEqual(menus.get("page:default").contexts, ["page", "action"]);
  assert.ok(menus.has("save-native")); assert.ok(menus.has("park-native"));
});
test("title fetching rejects non-HTML responses and does not read titles beyond its limit", async () => {
  globalThis.chrome = { permissions: { contains: async () => true } };
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("<title>Not HTML</title>", { headers: { "content-type": "text/plain" } });
    assert.equal(await fetchPageTitle("https://example.com/test"), null);
    globalThis.fetch = async () => new Response(" ".repeat(128 * 1024) + "<title>Too late</title>", { headers: { "content-type": "text/html" } });
    assert.equal(await fetchPageTitle("https://example.com/test"), null);
  } finally { globalThis.fetch = original; }
});
test("right-click link text is used when available and scripting failures have a fallback", async () => {
  globalThis.chrome = { scripting: { executeScript: async () => [{ result: "Useful anchor text" }] } };
  assert.equal(await linkText({ linkUrl: "https://example.com", frameId: 2 }, { id: 1 }), "Useful anchor text");
  chrome.scripting.executeScript = async () => { throw new Error("Restricted frame"); };
  assert.equal(await linkText({ linkUrl: "https://example.com" }, { id: 1 }), "");
});
