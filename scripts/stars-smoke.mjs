// Run only against the disposable development browser at TABDOCK_DEBUG_PORT.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, pause, poll } from "./cdp.mjs";

const requests = new Map();
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  requests.set(path, (requests.get(path) || 0) + 1);
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><title>Star test ${path}</title><h1>${path}</h1>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const site = `http://127.0.0.1:${server.address().port}`;
let connection, evaluate;
let testWindowId;
try {
  const connected = await connect(); connection = connected.connection;
  const { targetId } = await connection.send("Target.createTarget", { url: `${connected.base}popup/popup.html` });
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  await connection.send("Runtime.enable", {}, sessionId);
  evaluate = expression => connection.evaluate(sessionId, expression);
  await poll(() => evaluate("document.body?.dataset.ready==='true' && !document.body.hasAttribute('aria-busy')"));
  async function call(type, payload = {}) {
    const result = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ ...payload, type })})`);
    assert.equal(result.ok, true, result.error); return result.data;
  }
  const indicators = await evaluate("chrome.permissions.contains({origins:['http://127.0.0.1/*']})");
  const libraryBefore = (await call("GET_STATE")).groups;
  testWindowId = await evaluate(`chrome.windows.create({url:${JSON.stringify(`${site}/one`)}}).then(window=>window.id)`);
  // Brave replaces live tab IDs on discard; find the current ID by each unique test URL.
  const first = `${site}/one`;
  const createTab = async (path, active = false) => {
    const url = `${site}/${path}`;
    await evaluate(`chrome.tabs.create({windowId:${testWindowId},url:${JSON.stringify(url)},active:${active}})`);
    return url;
  };
  const tab = url => evaluate(`chrome.tabs.query({windowId:${testWindowId}}).then(tabs=>tabs.find(tab=>(tab.pendingUrl||tab.url)===${JSON.stringify(url)} || (tab.url?.startsWith(chrome.runtime.getURL('pages/lazy.html')+'#') && new URLSearchParams(new URL(tab.url).hash.slice(1)).get('url')===${JSON.stringify(url)})))`);
  const id = async url => (await tab(url)).id;
  const activate = async url => evaluate(`chrome.tabs.update(${await id(url)},{active:true})`);
  const waitLoaded = id => poll(async () => { const value = await tab(id); return !value.discarded && value.status === "complete"; }, "Selected starred tab did not load");
  const waitDiscarded = id => poll(async () => (await tab(id)).discarded, "Inactive starred tab did not discard");
  const second = await createTab("two"), third = await createTab("three");
  await Promise.all([first, second, third].map(waitLoaded));

  // Exercise star controls through the background worker while real tab events run.
  const menuClick = async (menuItemId, url) => call(menuItemId.endsWith("native") ? "STAR_BROWSER_GROUP" : "STAR_TAB", { tabId: await id(url), starred: menuItemId.startsWith("star-") });
  await menuClick("star-tab", first);
  if (indicators) {
    await poll(async () => (await tab(first)).title === "★ Star test /one", "Star symbol did not appear on the browser tab");
    await evaluate(`chrome.scripting.executeScript({target:{tabId:${await id(first)}},func:()=>{document.title='Renamed page';}})`);
    await poll(async () => (await tab(first)).title === "★ Renamed page", "The star did not survive a page title change");
  }
  await poll(async () => (await call("GET_STARS")).tabIds.includes(await id(first)));
  assert.equal((await tab(first)).discarded, false);
  await activate(second); await waitLoaded(second); await waitDiscarded(first);
  if (indicators) assert.ok((await tab(first)).title.startsWith("★ "), "Discarding must preserve the visible star");
  const firstLoads = requests.get("/one");
  await activate(first); await waitLoaded(first);
  await poll(() => requests.get("/one") > firstLoads, "Selecting a discarded starred tab must reload its website");
  assert.equal((await tab(third)).discarded, false, "Unstarred inactive tabs should remain loaded");
  await menuClick("unstar-tab", first);
  await poll(async () => !(await tab(first)).title.startsWith("★ "), "Unstar did not restore the page title");
  await poll(async () => !(await call("GET_STARS")).tabIds.includes(await id(first)));
  await activate(second); await pause(250);
  assert.equal((await tab(first)).discarded, false);

  const groupId = await evaluate(`chrome.tabs.group({tabIds:[${await id(first)},${await id(second)}],createProperties:{windowId:${testWindowId}}})`);
  await evaluate(`chrome.tabGroups.update(${groupId},{title:'Starred research',color:'purple',collapsed:false})`);
  // Individually starring a group member still works before the whole group is starred.
  await menuClick("star-tab", first); await waitDiscarded(first);
  assert.equal((await tab(second)).discarded, false);
  await menuClick("star-native", second);
  assert.equal(await evaluate(`chrome.tabGroups.get(${groupId}).then(group=>group.title)`), "★ Starred research");
  const copied = await call("SAVE_BROWSER_GROUP", { tabId: await id(second) });
  const captured = (await call("GET_STATE")).groups.find(group => group.id === copied.groupId);
  assert.equal(captured.name, "Starred research");
  assert.ok(captured.links.every(link => !link.title.startsWith("★ ")), "Saving must preserve original page titles");
  await call("DELETE_GROUP", { groupId: copied.groupId });
  await poll(async () => (await call("GET_STARS")).groupIds.includes(groupId));
  await activate(first); await waitLoaded(first); await waitDiscarded(second);
  assert.equal((await tab(first)).groupId, groupId); assert.equal((await tab(second)).groupId, groupId);

  const added = await createTab("added"); await waitLoaded(added);
  await evaluate(`chrome.tabs.group({tabIds:[${await id(added)}],groupId:${groupId}})`);
  await waitDiscarded(added);
  if (indicators) assert.ok((await tab(added)).title.startsWith("★ "), "New group members must receive a star symbol");
  assert.equal((await tab(added)).groupId, groupId);
  await activate(added); await waitLoaded(added); await waitDiscarded(first);
  await activate(third); await waitDiscarded(added);

  // An active new member stays loaded, then discards when selection changes.
  const activeAdded = await createTab("active-added", true); await waitLoaded(activeAdded);
  await evaluate(`chrome.tabs.group({tabIds:[${await id(activeAdded)}],groupId:${groupId}})`);
  assert.equal((await tab(activeAdded)).discarded, false);
  await activate(third); await waitDiscarded(activeAdded);

  // Leaving a starred group stops inheritance without changing the tab's URL.
  await activate(added); await waitLoaded(added);
  await evaluate(`chrome.tabs.ungroup([${await id(added)}])`);
  await activate(third); await pause(250);
  assert.equal((await tab(added)).discarded, false); assert.equal((await tab(added)).groupId, -1);
  await poll(async () => !(await tab(added)).title.startsWith("★ "), "Moving out of a starred group must remove its inherited symbol");

  await menuClick("unstar-native", second);
  assert.equal(await evaluate(`chrome.tabGroups.get(${groupId}).then(group=>group.title)`), "Starred research");
  assert.equal((await tab(second)).discarded, true, "Removing a star from a sleeping tab must not load its website");
  await poll(async () => !(await tab(second)).title.startsWith("★ "), "Unstar must update a sleeping tab's symbol");
  await poll(async () => !(await call("GET_STARS")).groupIds.includes(groupId));
  assert.ok((await call("GET_STARS")).tabIds.includes(await id(first)), "Removing a group star must preserve individual stars");
  await activate(second); await waitLoaded(second);
  await activate(third); await pause(250);
  assert.equal((await tab(second)).discarded, false);
  await activate(first); await waitLoaded(first);
  await activate(third); await waitDiscarded(first);
  assert.deepEqual((await call("GET_STATE")).groups, libraryBefore);
  assert.deepEqual(await evaluate(`chrome.tabGroups.get(${groupId}).then(group=>({title:group.title,color:group.color}))`), { title: "Starred research", color: "purple" });

  await menuClick("star-native", second);
  const finalFirstId = await id(first);
  await evaluate(`chrome.tabs.query({}).then(tabs=>chrome.tabs.remove(tabs.filter(tab=>tab.url?.startsWith(${JSON.stringify(`${site}/`)})).map(tab=>tab.id)))`);
  await evaluate(`chrome.windows.remove(${testWindowId})`).catch(() => { }); testWindowId = null;
  await poll(async () => { const stars = await call("GET_STARS"); return !stars.tabIds.includes(finalFirstId) && !stars.groupIds.includes(groupId); });
  assert.deepEqual(connection.events.filter(event => event.method === "Runtime.exceptionThrown"), []);
  console.log(`PASS: browser tab/group stars, group symbols, original saved titles, group inheritance, unstar cleanup, immediate discard, automatic reload, and closed-tab cleanup. Webpage symbol checks: ${indicators ? "passed" : "skipped (grant optional localhost access in the isolated profile)"}.`);
  if (process.argv.includes("--close")) await connection.send("Browser.close");
} finally {
  if (testWindowId && evaluate) {
    await evaluate(`chrome.tabs.query({}).then(tabs=>chrome.tabs.remove(tabs.filter(tab=>tab.url?.startsWith(${JSON.stringify(`${site}/`)})).map(tab=>tab.id)))`).catch(() => { });
    await evaluate(`chrome.windows.remove(${testWindowId})`).catch(() => { });
  }
  connection?.close(); await new Promise(resolve => server.close(resolve));
}
