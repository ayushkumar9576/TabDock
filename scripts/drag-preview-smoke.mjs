// Regressions for temporary group expansion and unchanged group styling.
// Use only the disposable debugging browser profile used by browser-smoke.mjs.
import assert from "node:assert/strict";
import { connect, pause, poll } from "./cdp.mjs";
const { connection, base } = await connect();
try {
  const { targetId } = await connection.send("Target.createTarget", { url: `${base}popup/popup.html` });
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  await connection.send("Runtime.enable", {}, sessionId);
  await connection.send("Emulation.setDeviceMetricsOverride", { width: 440, height: 580, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = expression => connection.evaluate(sessionId, expression);
  const ready = () => poll(() => evaluate("document.body?.dataset.ready==='true' && !document.body.hasAttribute('aria-busy')"));
  async function call(type, payload = {}) {
    const response = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ ...payload, type })})`);
    assert.equal(response.ok, true, response.error); return response.data;
  }
  const groupSelector = id => `.tab-group[data-entry-id="${id}"]`;
  const linkSelector = id => `.tab-card[data-link-id="${id}"]`;
  async function rect(selector) {
    return evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});const rect=node.getBoundingClientRect();return {x:rect.left,y:rect.top,width:rect.width,height:rect.height};})()`);
  }
  const style = id => evaluate(`(()=>{const css=getComputedStyle(document.querySelector(${JSON.stringify(groupSelector(id))}));return [css.backgroundColor,css.borderColor,css.borderRadius,css.color,css.fontFamily];})()`);
  const hidden = id => evaluate(`document.querySelector(${JSON.stringify(groupSelector(id))}).querySelector('.group-links').hidden`);
  const expanded = id => evaluate(`document.querySelector(${JSON.stringify(groupSelector(id))}).querySelector('.group-collapse').getAttribute('aria-expanded')`);
  async function move(x, y) {
    await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 1 }, sessionId);
    await pause(230);
  }
  async function begin(linkId) {
    const position = await rect(linkSelector(linkId));
    const x = position.x + 140, y = position.y + 32;
    await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
    await move(x + 8, y);
  }
  async function hover(groupId) {
    const position = await rect(`${groupSelector(groupId)} .group-header`);
    await move(position.x + 140, position.y + 25);
  }
  async function cancel() {
    await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" }, sessionId);
    await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 20, y: 250, button: "left", clickCount: 1 }, sessionId);
    await pause(230);
  }
  await ready();
  await evaluate("chrome.storage.local.set({tabHarbor:{version:1,groups:[],pendingMoves:[],undo:[],settings:{removeAfterOpen:false}}})");
  const source = await call("SAVE_PAGE", { url: "https://example.com/source", title: "Drag this tab" });
  for (const group of [{ name: "Collapsed A", color: "purple", collapsed: true }, { name: "Expanded B", color: "blue" }, { name: "Collapsed C", color: "orange", collapsed: true }]) await call("CREATE_GROUP", group);
  const groups = (await call("GET_STATE")).groups;
  const a = groups.find(group => group.name === "Collapsed A"), b = groups.find(group => group.name === "Expanded B"), c = groups.find(group => group.name === "Collapsed C");
  const existing = await call("SAVE_PAGE", { groupId: b.id, url: "https://example.com/existing", title: "Existing tab" });
  await ready(); await pause(230);
  const original = (await call("GET_STATE")).groups, originalStyles = new Map(await Promise.all([a, b, c].map(async group => [group.id, await style(group.id)])));
  await begin(source.linkId); await hover(a.id);
  assert.equal(await hidden(a.id), false); assert.equal(await expanded(a.id), "true");
  assert.deepEqual(await style(a.id), originalStyles.get(a.id), "Hover must preserve the group's background, border and text styling");
  assert.equal((await call("GET_STATE")).groups.find(group => group.id === a.id).collapsed, true);
  await move(18, 220);
  assert.equal(await hidden(a.id), true, "Leaving without releasing must immediately restore collapse");
  assert.equal(await expanded(a.id), "false");
  await hover(b.id); await move(18, 220);
  assert.equal(await hidden(b.id), false, "Originally expanded groups must remain expanded");
  await hover(a.id); await hover(c.id);
  assert.equal(await hidden(a.id), true, "Moving between groups restores the previous group's state");
  assert.equal(await hidden(c.id), false); assert.deepEqual(await style(c.id), originalStyles.get(c.id));
  await cancel();
  assert.equal(await hidden(c.id), true); assert.equal(await expanded(c.id), "false");
  assert.deepEqual((await call("GET_STATE")).groups, original, "Preview and cancellation must not modify saved groups");
  const cardAppearance = selector => evaluate(`(()=>{const css=getComputedStyle(document.querySelector(${JSON.stringify(selector)}));return [css.backgroundColor,css.borderColor,css.borderWidth,css.borderStyle,css.borderRadius];})()`);
  const originalCard = await cardAppearance(linkSelector(existing.linkId));
  await begin(existing.linkId);
  assert.deepEqual(await cardAppearance(".drag-card > .tab-card"), originalCard, "Floating grouped tabs must retain their actual CSS background and border");
  assert.deepEqual(await cardAppearance(".drop-placeholder"), originalCard, "The insertion gap must retain the dragged tab's background and border");
  await hover(a.id);
  assert.deepEqual(await cardAppearance(".drag-card > .tab-card"), originalCard);
  assert.deepEqual(await cardAppearance(".drop-placeholder"), originalCard, "Entering another group must not apply its color to the insertion gap");
  await cancel();
  await begin(source.linkId); await hover(a.id);
  const destination = await rect(`${groupSelector(a.id)} .group-header`);
  await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: destination.x + 140, y: destination.y + 25, button: "left", clickCount: 1 }, sessionId);
  await poll(async () => (await call("GET_STATE")).groups.find(group => group.id === a.id).links.some(link => link.id === source.linkId));
  await ready();
  assert.equal(await hidden(a.id), true, "Dropping a tab must preserve the group's saved collapsed preference");
  assert.equal(await expanded(a.id), "false"); assert.deepEqual(await style(a.id), originalStyles.get(a.id));
  console.log("PASS: actual tab backgrounds and borders on floating cards and insertion gaps; group styling, hover expansion, restoration on leave, cancellation, and collapsed state after dropping.");
  if (process.argv.includes("--close")) await connection.send("Browser.close");
} finally { connection.close(); }
