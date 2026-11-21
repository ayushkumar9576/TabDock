import test from "node:test";
import assert from "node:assert/strict";
import { savableUrl, makeLink, makeGroup, initialState, moveLink, moveEntry, ungroupLink, groupLink, lazyUrl, parseLazyUrl, tabSnapshot, matchingGroups, pruneState } from "../shared/model.js";
import { titleFromHtml } from "../shared/titles.js";
import { exclusive } from "../shared/storage.js";

test("only real HTTP(S) URLs can be saved or restored", () => {
  for (const url of ["chrome://settings", "brave://newtab", "edge://extensions", "about:blank", "javascript:alert(1)", "file:///tmp/a", "chrome-extension://abc/page", "not a URL"]) assert.equal(savableUrl(url), null);
  assert.equal(savableUrl("https://example.com"), "https://example.com/");
  assert.throws(() => makeLink({ url: "javascript:alert(1)" }));
});
test("deferred URLs round trip Unicode, fragments, titles, and favicon metadata", () => {
  const base = "chrome-extension://abc/pages/lazy.html";
  const link = { url: "https://example.com/?q=猫&b=1#chapter", title: "猫 & <Title>", favicon: "https://example.com/icon.png?a=1&b=2" };
  const encoded = lazyUrl(base, link);
  assert.deepEqual(parseLazyUrl(encoded, base), { ...link, url: savableUrl(link.url) });
  assert.equal(parseLazyUrl(encoded, "chrome-extension://other/pages/lazy.html"), null);
  assert.equal(parseLazyUrl(`${base}#url=javascript:alert(1)`, base), null);
  assert.deepEqual(tabSnapshot({ id: 1, url: encoded, title: "Placeholder", pinned: true }, base).title, link.title);
});
test("saved-link moves preserve metadata and support within-group reordering", () => {
  const state = initialState(); const a = makeGroup({ name: "A" }); const b = makeGroup({ name: "B" }, 1); state.groups.push(a, b);
  const links = [1, 2, 3].map(n => makeLink({ url: `https://example.com/${n}`, pinned: n === 2 })); a.links.push(...links);
  moveLink(state, a.id, links[2].id, a.id, links[0].id);
  assert.deepEqual(a.links.map(link => link.id), [links[2].id, links[0].id, links[1].id]);
  moveLink(state, a.id, links[1].id, b.id);
  assert.equal(b.links[0], links[1]); assert.equal(b.links[0].pinned, true);
  assert.throws(() => moveLink(state, a.id, links[0].id, "missing"));
  assert.equal(a.links.length, 2);
});
test("native empty titles and colors survive data normalization", () => {
  const group = makeGroup({ name: "Untitled group", fromNativeGroup: true, originalTitle: "", color: "purple", collapsed: true });
  assert.equal(group.nativeTitle, ""); assert.equal(group.color, "purple"); assert.equal(group.collapsed, true); assert.equal(group.lazyOpen, true);
  assert.equal(makeGroup({ color: "invalid" }).color, "blue");
  assert.equal(matchingGroups([group], " untitled GROUP ").length, 1);
});
test("background HTML titles decode entities and collapse whitespace", () => {
  assert.equal(titleFromHtml("<HEAD><TITLE class='x'>  A &amp; B &#x1F680;\n &quot;cat&quot; </TITLE></HEAD>"), 'A & B 🚀 "cat"');
  assert.equal(titleFromHtml("<title> </title>"), null);
  assert.equal(titleFromHtml("<title>Missing end"), null);
  assert.equal(titleFromHtml("<title>&#99999999999;</title>"), "&#99999999999;");
});
test("expired plans and undo are pruned without deleting saved groups", () => {
  const state = initialState(); state.groups.push(makeGroup({ name: "Existing" })); state.pendingMoves = [{ createdAt: 1 }]; state.undo = [{ expiresAt: 2 }];
  pruneState(state, 1_000_000); assert.equal(state.pendingMoves.length, 0); assert.equal(state.undo.length, 0); assert.equal(state.groups.length, 1);
});
test("worker queue serializes mutations and continues after a failure", async () => {
  const events = [];
  const a = exclusive(async () => { events.push("a"); await Promise.resolve(); events.push("b"); throw new Error("Expected"); });
  const b = exclusive(async () => { events.push("c"); });
  await assert.rejects(a); await b; assert.deepEqual(events, ["a", "b", "c"]);
});

test("a new library starts with no extra group", () => {
  assert.deepEqual(initialState().groups, []);
});

test("tabs and groups share a persistent order in both directions, including the end", () => {
  const state = initialState();
  const entries = [makeGroup({ name: "First", ungrouped: true }), makeGroup({ name: "Reading" }, 1), makeGroup({ name: "Last", ungrouped: true }, 2)];
  state.groups.push(...entries);
  moveEntry(state, entries[2].id, entries[0].id);
  assert.deepEqual(state.groups.map(group => group.id), [entries[2].id, entries[0].id, entries[1].id]);
  moveEntry(state, entries[2].id);
  assert.deepEqual(state.groups.map(group => group.id), entries.map(group => group.id));
  assert.deepEqual(state.groups.map(group => group.order), [0, 1, 2]);
  const before = structuredClone(state);
  assert.throws(() => moveEntry(state, entries[0].id, "missing")); assert.deepEqual(state, before);
});

test("creating a group moves the original tab in place without duplicating metadata", () => {
  const state = initialState(), loose = makeGroup({ name: "Tab", ungrouped: true }), later = makeGroup({ name: "Later" }, 1);
  const link = makeLink({ url: "https://example.com", title: "A saved page", pinned: true, favicon: "https://example.com/icon.png" });
  loose.links.push(link); state.groups.push(loose, later);
  const group = groupLink(state, loose.id, link.id, "New group");
  assert.deepEqual(state.groups.map(item => item.id), [group.id, later.id]);
  assert.equal(group.links[0], link); assert.equal(group.ungrouped, undefined);
  assert.equal(state.groups.flatMap(item => item.links).length, 1);
});

test("dragging a tab into and out of a group preserves its ID and exact insertion position", () => {
  const state = initialState(), loose = makeGroup({ name: "Tab", ungrouped: true }), group = makeGroup({ name: "Reading" }, 1);
  const links = [1, 2, 3].map(n => makeLink({ url: `https://example.com/${n}` }));
  loose.links.push(links[0]); group.links.push(links[1], links[2]); state.groups.push(loose, group);
  moveLink(state, loose.id, links[0].id, group.id, links[2].id);
  assert.deepEqual(group.links, [links[1], links[0], links[2]]); assert.equal(state.groups.length, 1);
  const detached = ungroupLink(state, group.id, links[0].id, group.id);
  assert.deepEqual(state.groups.map(item => item.id), [detached.id, group.id]);
  assert.equal(detached.links[0], links[0]); assert.deepEqual(group.links, [links[1], links[2]]);
  assert.equal(matchingGroups(state.groups, detached.name).length, 0);
});

test("invalid drop destinations leave the source tab intact", () => {
  const state = initialState(), group = makeGroup({ name: "Reading" }), loose = makeGroup({ name: "Other", ungrouped: true }, 1);
  const link = makeLink({ url: "https://example.com" }); group.links.push(link); state.groups.push(group, loose);
  assert.throws(() => ungroupLink(state, group.id, link.id, "missing"));
  assert.throws(() => moveLink(state, group.id, link.id, loose.id));
  assert.deepEqual(group.links, [link]);
});
