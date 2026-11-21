// Verify real native-group copying and moving in the disposable test profile.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, poll } from "./cdp.mjs";
import { isNewTabUrl } from "../shared/model.js";
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<title>Capture test</title>");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const site = `http://127.0.0.1:${server.address().port}`;
let connection;
try {
  const connected = await connect(); connection = connected.connection;
  const { targetId } = await connection.send("Target.createTarget", { url: `${connected.base}popup/popup.html` });
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  await connection.send("Runtime.enable", {}, sessionId);
  const evaluate = expression => connection.evaluate(sessionId, expression);
  async function call(type, payload = {}) {
    const result = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ ...payload, type })})`);
    assert.equal(result.ok, true, result.error); return result.data;
  }
  await poll(() => evaluate("document.body?.dataset.ready==='true' && !document.body.hasAttribute('aria-busy')"));
  await evaluate("chrome.storage.local.set({tabHarbor:{version:1,groups:[],pendingMoves:[],undo:[],settings:{removeAfterOpen:false}}})");
  const windowId = await evaluate("chrome.windows.getCurrent().then(window=>window.id)");
  const currentId = await evaluate(`chrome.tabs.query({windowId:${windowId},active:true}).then(tabs=>tabs[0].id)`);
  const sourceIds = [];
  const sourceUrls = ["chrome://newtab/", ...["two", "three", "four", "five"].map(path => `${site}/${path}`)];
  for (const url of sourceUrls) sourceIds.push(await evaluate(`chrome.tabs.create({windowId:${windowId},url:${JSON.stringify(url)},active:false}).then(tab=>tab.id)`));
  await poll(() => evaluate(`Promise.all(${JSON.stringify(sourceIds)}.map(id=>chrome.tabs.get(id))).then(tabs=>tabs.every(tab=>tab.status==='complete'))`));
  const nativeGroupId = await evaluate(`chrome.tabs.group({tabIds:${JSON.stringify(sourceIds)},createProperties:{windowId:${windowId}}})`);
  await evaluate(`chrome.tabGroups.update(${nativeGroupId},{title:'Research',color:'purple',collapsed:true})`);
  const copied = await call("SAVE_BROWSER_GROUP", { windowId, tabId: sourceIds[1] });
  assert.equal(copied.savedCount, 5); assert.deepEqual(copied.warnings, []);
  const saved = (await call("GET_STATE")).groups.find(group => group.id === copied.groupId);
  assert.equal(saved.name, "Research"); assert.equal(saved.color, "purple"); assert.equal(saved.collapsed, true);
  assert.deepEqual(saved.links.map(link => link.url), sourceUrls);
  assert.deepEqual((await evaluate(`Promise.all(${JSON.stringify(sourceIds)}.map(id=>chrome.tabs.get(id)))`)).map(tab => tab.id), sourceIds);
  assert.equal(await evaluate(`chrome.tabs.query({windowId:${windowId},active:true}).then(tabs=>tabs[0].id)`), currentId);
  const added = await call("SAVE_PAGE", { groupId: copied.groupId, url: `${site}/extra`, title: "Extra page" });
  assert.equal(added.groupId, copied.groupId);
  const individual = await call("SAVE_PAGE", { url: `${site}/individual`, title: "Individual page" });
  assert.equal((await call("GET_STATE")).groups.find(group => group.id === individual.groupId).ungrouped, true);
  const plan = await call("PREPARE_MOVE", { scope: "group", windowId, tabId: sourceIds[1] });
  assert.deepEqual(plan.groups[0].tabs.map(tab => tab.id), sourceIds);
  const moved = await call("COMMIT_MOVE", { planId: plan.id, choices: { [plan.groups[0].key]: { mode: "new" } } });
  assert.equal(moved.undo.entries.filter(entry => entry.closed).length, 5);
  assert.equal(await evaluate(`chrome.tabs.query({windowId:${windowId}}).then(tabs=>tabs.filter(tab=>${JSON.stringify(sourceIds)}.includes(tab.id)).length)`), 0);
  assert.equal(await evaluate(`chrome.tabs.query({windowId:${windowId},active:true}).then(tabs=>tabs[0].id)`), currentId);
  assert.ok((await call("GET_STATE")).groups.some(group => group.id === copied.groupId));
  const restored = await call("OPEN_GROUP", { groupId: moved.undo.createdGroupIds[0], windowId });
  assert.equal(restored.tabIds.length, 5);
  const restoredTabs = await evaluate(`Promise.all(${JSON.stringify(restored.tabIds)}.map(id=>chrome.tabs.get(id)))`);
  assert.ok(restoredTabs.every(tab => tab.discarded && tab.status === "unloaded" && !tab.active));
  assert.equal(await evaluate(`chrome.tabs.query({windowId:${windowId},active:true}).then(tabs=>tabs[0].id)`), currentId);
  await evaluate(`chrome.tabs.update(${restored.tabIds[0]},{active:true})`);
  await poll(async () => {
    const active = await evaluate(`chrome.tabs.query({windowId:${windowId},active:true}).then(tabs=>tabs[0])`);
    return isNewTabUrl(active.pendingUrl || active.url);
  });
  await evaluate(`chrome.tabs.update(${currentId},{active:true})`);
  // Change the preference through the actual settings UI, then reopen it.
  await poll(() => evaluate("!document.body.hasAttribute('aria-busy')"));
  await evaluate("document.querySelector('#settings-toggle').click();document.querySelector('#include-new-tabs').click()");
  await poll(async () => (await call("GET_STATE")).settings.includeNewTabs === false);
  await evaluate("document.querySelector('#settings-close').click()");
  await connection.send("Page.reload", {}, sessionId);
  await poll(() => evaluate("document.body?.dataset.ready==='true' && !document.body.hasAttribute('aria-busy')"));
  assert.equal(await evaluate("document.querySelector('#include-new-tabs').checked"), false);
  for (const action of ["add", "move"]) {
    const ids = [];
    for (const url of sourceUrls) ids.push(await evaluate(`chrome.tabs.create({windowId:${windowId},url:${JSON.stringify(url)},active:false}).then(tab=>tab.id)`));
    await poll(() => evaluate(`Promise.all(${JSON.stringify(ids)}.map(id=>chrome.tabs.get(id))).then(tabs=>tabs.every(tab=>tab.status==='complete'))`));
    const nativeId = await evaluate(`chrome.tabs.group({tabIds:${JSON.stringify(ids)},createProperties:{windowId:${windowId}}})`);
    await evaluate(`chrome.tabGroups.update(${nativeId},{title:${JSON.stringify(`Exclude empty (${action})`)},color:'blue',collapsed:false})`);
    if (action === "add") {
      const addedGroup = await call("SAVE_BROWSER_GROUP", { windowId, tabId: ids[1] });
      assert.equal(addedGroup.savedCount, 4); assert.equal(addedGroup.discardedCount, 1);
      assert.deepEqual((await call("GET_STATE")).groups.find(group => group.id === addedGroup.groupId).links.map(link => link.url), sourceUrls.slice(1));
      assert.deepEqual(await evaluate(`chrome.tabs.query({windowId:${windowId},groupId:${nativeId}}).then(tabs=>tabs.map(tab=>tab.id))`), ids.slice(1));
    } else {
      const moving = await call("PREPARE_MOVE", { scope: "group", windowId, tabId: ids[1] });
      assert.equal(moving.excludedTabs.length, 1);
      const movedGroup = await call("COMMIT_MOVE", { planId: moving.id });
      assert.equal(movedGroup.discardedCount, 1); assert.equal(movedGroup.undo.entries.filter(entry => entry.closed).length, 5);
      assert.equal(await evaluate(`chrome.tabs.query({windowId:${windowId},groupId:${nativeId}}).then(tabs=>tabs.length)`), 0);
      assert.deepEqual((await call("GET_STATE")).groups.find(group => group.name === "Exclude empty (move)").links.map(link => link.url), sourceUrls.slice(1));
    }
  }
  await call("UPDATE_SETTINGS", { includeNewTabs: true });
  assert.deepEqual(connection.events.filter(event => event.method === "Runtime.exceptionThrown"), []);
  console.log("PASS: five-tab Add and Move from the second member include the first New Tab; the persisted include setting saves empty tabs when on and closes/excludes them for both Add and Move when off.");
  if (process.argv.includes("--close")) await connection.send("Browser.close");
} finally { connection?.close(); await new Promise(resolve => server.close(resolve)); }
