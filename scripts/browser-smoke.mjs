// Run only against the separate development browser/profile at TABDOCK_DEBUG_PORT.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect, pause, poll } from "./cdp.mjs";

const requests = new Map();
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  requests.set(path, (requests.get(path) || 0) + 1);
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>TabDock ${path}</title><h1>${path}</h1>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const site = `http://127.0.0.1:${server.address().port}`;
let connection;
try {
  const connected = await connect(); connection = connected.connection;
  const { base } = connected;
  const { targetId } = await connection.send("Target.createTarget", { url: `${base}popup/popup.html` });
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  await connection.send("Runtime.enable", {}, sessionId);
  await connection.send("Emulation.setDeviceMetricsOverride", { width: 440, height: 580, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = expression => connection.evaluate(sessionId, expression);
  async function call(type, payload = {}) {
    const response = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ ...payload, type })})`);
    assert.equal(response.ok, true, response.error); return response.data;
  }
  const saved = () => call("GET_STATE");
  const selector = id => `[data-link-id="${id}"]`;
  const groupSelector = id => `.tab-group[data-entry-id="${id}"]`;
  async function rect(select) {
    return evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(select)});node.scrollIntoView({block:'nearest'});const rect=node.getBoundingClientRect();return {x:rect.left,y:rect.top,width:rect.width,height:rect.height};})()`);
  }
  async function drag(select, x, y) {
    const start = await rect(select), sx = start.x + start.width / 2, sy = start.y + Math.min(start.height / 2, 36);
    await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx, y: sy }, sessionId);
    await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: sx, y: sy, button: "left", clickCount: 1 }, sessionId);
    // Start the gesture before aiming at a drop destination.
    await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx + 8, y: sy, buttons: 1 }, sessionId);
    for (let step = 1; step <= 6; step++) {
      await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx + (x - sx) * step / 6, y: sy + (y - sy) * step / 6, buttons: 1 }, sessionId);
      await pause(35);
    }
    await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
    await poll(() => evaluate("!document.body.hasAttribute('aria-busy')")); await pause(200);
  }
  async function context(select) {
    const target = await rect(select);
    await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x + 25, y: target.y + 20, button: "right", clickCount: 1 }, sessionId);
    await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x + 25, y: target.y + 20, button: "right", clickCount: 1 }, sessionId);
    await poll(() => evaluate("!document.querySelector('#context-menu').hidden"), "Right-click menu did not open");
    return evaluate("[...document.querySelectorAll('#context-menu button')].map(node=>node.textContent)");
  }
  await poll(() => evaluate("document.body?.dataset.ready==='true' && !document.body.hasAttribute('aria-busy')"));
  // This intentionally resets only the isolated extension test library.
  await evaluate("chrome.storage.local.set({tabHarbor:{version:1,groups:[],pendingMoves:[],undo:[]}})");
  await poll(() => evaluate("!document.querySelector('#empty').hidden"));
  assert.equal(await evaluate("document.querySelectorAll('header,footer,#theme,#search,.link-actions').length"), 0);
  const first = await call("SAVE_PAGE", { url: `${site}/one`, title: "Understanding binary search" });
  const second = await call("SAVE_PAGE", { url: `${site}/two`, title: "Two pointers · LeetCode" });
  const third = await call("SAVE_PAGE", { url: `${site}/three`, title: "Dynamic programming notes" });
  await poll(() => evaluate("document.querySelectorAll('.tab-card').length===3"));
  assert.ok((await saved()).groups.every(group => group.ungrouped));
  const top = await rect(selector(first.linkId));
  await drag(selector(third.linkId), top.x + 150, top.y + 3);
  assert.equal((await saved()).groups[0].id, third.groupId, "Dragging up must persist the new order");
  await drag(selector(third.linkId), 210, 380);
  assert.equal((await saved()).groups.at(-1).id, third.groupId, "Dragging down must reach the end");

  assert.deepEqual(await context(selector(first.linkId)), ["Add to group", "Open"]);
  await evaluate("document.querySelector('#context-menu button').click()");
  await poll(() => evaluate("Boolean(document.querySelector('.group-name-input'))"), "New group name was not editable");
  await evaluate("(()=>{const input=document.querySelector('.group-name-input');input.value='LeetCode';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()");
  const group = await poll(async () => (await saved()).groups.find(group => group.name === "LeetCode"));
  await poll(() => evaluate("!document.body.hasAttribute('aria-busy')"));
  assert.equal(group.links[0].id, first.linkId);
  // Groups move as a whole amongst standalone cards, in either direction.
  await drag(`${groupSelector(group.id)} .group-header`, 210, 380);
  assert.equal((await saved()).groups.at(-1).id, group.id, "Group headers reorder to the end");
  const rootTop = await rect(selector(second.linkId));
  await drag(`${groupSelector(group.id)} .group-header`, 210, rootTop.y + 3);
  assert.equal((await saved()).groups[0].id, group.id, "Group headers reorder to the beginning");
  let destination = await rect(`${groupSelector(group.id)} .group-header`);
  await drag(selector(second.linkId), destination.x + 160, destination.y + 28);
  assert.deepEqual((await saved()).groups.find(item => item.id === group.id).links.map(item => item.id), [second.linkId, first.linkId], "Dropping on a group header inserts at the beginning");
  assert.ok(!(await saved()).groups.some(item => item.id === second.groupId), "Empty standalone storage entry must be removed");
  const last = await rect(selector(third.linkId));
  await drag(selector(second.linkId), last.x + 6, last.y + last.height + 22);
  assert.ok((await saved()).groups.at(-1).ungrouped);
  assert.equal((await saved()).groups.at(-1).links[0].id, second.linkId, "Dragging out retains the original tab ID");
  destination = await rect(`${groupSelector(group.id)} .group-header`);
  await drag(selector(second.linkId), destination.x + 160, destination.y + 28);
  const firstCard = await rect(selector(first.linkId));
  await drag(selector(second.linkId), firstCard.x + 160, firstCard.y + firstCard.height - 6);
  assert.deepEqual((await saved()).groups.find(item => item.id === group.id).links.map(item => item.id), [first.linkId, second.linkId], "Grouped tabs reorder down");
  await evaluate(`document.querySelector(${JSON.stringify(selector(second.linkId))}).focus()`);
  await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowUp", code: "ArrowUp", modifiers: 1 }, sessionId);
  await connection.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowUp", code: "ArrowUp", modifiers: 1 }, sessionId);
  await poll(async () => (await saved()).groups.find(item => item.id === group.id).links[0].id === second.linkId, "Keyboard tab reorder failed");

  // Escape cancels a real pointer gesture without changing saved data.
  const beforeCancel = await saved(), cancelRect = await rect(selector(third.linkId));
  await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 220, y: cancelRect.y + 25, button: "left", clickCount: 1 }, sessionId);
  await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 220, y: cancelRect.y - 35, buttons: 1 }, sessionId);
  await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" }, sessionId);
  await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 220, y: cancelRect.y - 35, button: "left", clickCount: 1 }, sessionId);
  assert.deepEqual((await saved()).groups, beforeCancel.groups);
  const persisted = (await saved()).groups;
  await connection.send("Page.reload", {}, sessionId);
  await poll(() => evaluate("document.body.dataset.ready==='true' && !document.body.hasAttribute('aria-busy')"));
  assert.deepEqual((await saved()).groups, persisted, "Reopening retains mixed order and grouping");
  assert.deepEqual(await context(`${groupSelector(group.id)} .group-header`), ["Open", "Delete group"]);
  await evaluate("document.querySelector('#context-menu').hidden=true");
  await connection.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);
  assert.equal(await evaluate("getComputedStyle(document.documentElement).colorScheme"), "light");
  await evaluate("document.fonts.ready"); assert.equal(await evaluate("document.fonts.check('13px \"DM Sans\"')"), true);

  // Native restoration follows the group's current saved link order.
  await call("MOVE_LINK", { sourceId: group.id, linkId: second.linkId, targetId: group.id });
  const sourceWindow = await evaluate("chrome.windows.getCurrent().then(window=>window.id)");
  const activeBefore = await evaluate(`chrome.tabs.query({windowId:${sourceWindow},active:true}).then(tabs=>tabs[0].id)`);
  const opened = await call("OPEN_GROUP", { groupId: group.id, windowId: sourceWindow });
  assert.equal(opened.tabIds.length, 2); assert.deepEqual(opened.warnings, []);
  await pause(350); assert.equal(requests.has("/one"), false); assert.equal(requests.has("/two"), false);
  const restored = await evaluate(`Promise.all(${JSON.stringify(opened.tabIds)}.map(id=>chrome.tabs.get(id)))`);
  assert.ok(restored.every(tab => tab.discarded && tab.status === "unloaded" && !tab.active));
  assert.equal(await evaluate(`chrome.tabs.query({windowId:${sourceWindow},active:true}).then(tabs=>tabs[0].id)`), activeBefore);
  assert.ok(restored.every(tab => tab.groupId === opened.nativeGroupId));
  const native = await evaluate(`chrome.tabGroups.get(${opened.nativeGroupId})`); assert.equal(native.title, "LeetCode");
  await evaluate(`chrome.tabs.update(${opened.tabIds[1]},{active:true})`);
  await poll(() => requests.has("/two"), "Deferred page did not load when activated");
  assert.equal(requests.has("/one"), false, "Selecting the second tab must not load the first");
  const plan = await call("PREPARE_MOVE", { scope: "group", windowId: sourceWindow, nativeGroupId: opened.nativeGroupId });
  assert.deepEqual(plan.groups[0].tabs.map(tab => tab.url), [`${site}/one`, `${site}/two`]);
  const parked = await call("COMMIT_MOVE", { planId: plan.id, choices: { [plan.groups[0].key]: { mode: "new" } } });
  assert.equal(parked.undo.entries.filter(entry => entry.closed).length, 2);
  const undone = await call("UNDO_MOVE", { undoId: parked.undo.id }); assert.match(undone.message, /2 tabs restored/);
  const openedSingle = await call("OPEN_LINK", { groupId: third.groupId, linkId: third.linkId, windowId: sourceWindow });
  assert.equal(openedSingle.tabIds.length, 1); assert.equal(requests.has("/three"), false);
  const singleTab = await evaluate(`chrome.tabs.get(${openedSingle.tabIds[0]})`);
  assert.equal(singleTab.discarded, true); assert.equal(singleTab.status, "unloaded"); assert.equal(singleTab.active, false);
  await evaluate(`chrome.tabs.update(${singleTab.id},{active:true})`); await poll(() => requests.has("/three"));

  // Leave a small visual fixture for the real toolbar-popup check.
  await evaluate(`chrome.tabs.update(${await evaluate("chrome.tabs.getCurrent().then(tab=>tab.id)")},{active:true})`);
  await evaluate("chrome.storage.local.set({tabHarbor:{version:1,groups:[],pendingMoves:[],undo:[]}})");
  await call("SAVE_PAGE", { url: "https://www.youtube.com/watch?v=jfKfPfyJRdk", title: "lofi hip hop radio — beats to relax/study to" });
  await call("CREATE_GROUP", { name: "LeetCode", color: "green" });
  const visualGroup = (await saved()).groups.find(item => item.name === "LeetCode");
  for (const [slug, title] of [["two-sum", "Two Sum"], ["longest-substring-without-repeating-characters", "Longest Substring Without Repeating Characters"], ["merge-intervals", "Merge Intervals"]]) await call("SAVE_PAGE", { groupId: visualGroup.id, url: `https://leetcode.com/problems/${slug}/`, title });
  await call("SAVE_PAGE", { url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript", title: "JavaScript reference · MDN Web Docs" });
  await poll(() => evaluate("document.querySelectorAll('.tab-card').length===5"));
  await pause(800);
  mkdirSync(new URL("../.browser-test/", import.meta.url), { recursive: true });
  const screenshot = await connection.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 440, height: 580, scale: 1 } }, sessionId);
  writeFileSync(new URL("../.browser-test/redesigned-popup.png", import.meta.url), Buffer.from(screenshot.data, "base64"));
  const errors = connection.events.filter(event => event.method === "Runtime.exceptionThrown"); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", browser: connected.version.Browser, checks: ["Minimal popup and empty state", "Pointer reorder in both directions", "Group-header dragging", "Exactly two tab menu actions", "Immediate grouping and inline naming", "Drag into/out of groups", "Within-group reorder", "Keyboard reorder", "Escape cancels dragging", "Persistence after reopening", "Light appearance under dark system setting", "Native group name and saved order", "All restored tabs discarded with unloaded status", "Current tab stays selected", "No target requests before selection", "Parking and undo", "Standalone unloaded opening"], screenshot: ".browser-test/redesigned-popup.png" }, null, 2));
  if (process.argv.includes("--close")) await connection.send("Browser.close");
} finally { connection?.close(); await new Promise(resolve => server.close(resolve)); }
