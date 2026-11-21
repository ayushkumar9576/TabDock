// Measure Chromium's real toolbar-attached action popup, without a preset viewport.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect, poll } from "./cdp.mjs";
const { connection, base } = await connect();
try {
  const source = (await connection.send("Target.createTarget", { url: `${base}popup/popup.html` })).targetId;
  const workerSession = (await connection.send("Target.attachToTarget", { targetId: source, flatten: true })).sessionId;
  await connection.send("Runtime.enable", {}, workerSession);
  const evaluateWorker = expression => connection.evaluate(workerSession, expression);
  await poll(() => evaluateWorker("typeof chrome !== 'undefined' && Boolean(chrome.action)"));
  const previous = new Set((await connection.send("Target.getTargets")).targetInfos.map(target => target.targetId));
  const windowId = await evaluateWorker("chrome.windows.getLastFocused({windowTypes:['normal']}).then(window=>window.id)");
  // Headless Chromium starts on an 800×600 display and caps popups to 516px.
  // Give its browser window a normal-sized display; leave the popup viewport alone.
  const { screenInfos } = await connection.send("Emulation.getScreenInfos");
  let screen = screenInfos.find(item => item.availHeight >= 900);
  if (!screen) screen = (await connection.send("Emulation.addScreen", { left: 800, top: 0, width: 1440, height: 1080, devicePixelRatio: 1, isInternal: false, label: "Popup layout test" })).screenInfo;
  await evaluateWorker(`chrome.windows.update(${windowId},{focused:true,left:${screen.left + 40},top:${screen.top + 40},width:1000,height:800})`);
  await evaluateWorker(`chrome.tabs.create({windowId:${windowId},url:'about:blank',active:true})`);
  await poll(async () => { try { await evaluateWorker(`chrome.action.openPopup({windowId:${windowId}})`); return true; } catch { return false; } }, "Could not open the toolbar popup");
  const popup = await poll(async () => (await connection.send("Target.getTargets")).targetInfos.find(target => !previous.has(target.targetId) && target.url === `${base}popup/popup.html`));
  const sessionId = (await connection.send("Target.attachToTarget", { targetId: popup.targetId, flatten: true })).sessionId;
  const evaluate = expression => connection.evaluate(sessionId, expression);
  await poll(() => evaluate("document.body.dataset.ready==='true' && !document.body.hasAttribute('aria-busy')"));
  const measure = () => evaluate(`(()=>{const main=document.querySelector('main');return {viewport:[innerWidth,innerHeight],root:[document.documentElement.offsetWidth,document.documentElement.offsetHeight],horizontalOverflow:document.documentElement.scrollWidth>innerWidth,outerOverflow:document.documentElement.scrollHeight>innerHeight,mainScrollable:main.scrollHeight>main.clientHeight};})()`);
  const initial = await poll(async () => { const result = await measure(); return result.root[0] === 440 && !result.outerOverflow && result; });
  assert.deepEqual(initial.root, [440, 580]); assert.equal(initial.horizontalOverflow, false); assert.equal(initial.outerOverflow, false);
  assert.equal(await evaluate("document.querySelectorAll('header,footer').length"), 0);
  await connection.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);
  assert.equal(await evaluate("getComputedStyle(document.documentElement).colorScheme"), "light");
  mkdirSync(new URL("../.browser-test/", import.meta.url), { recursive: true });
  const screenshot = await connection.send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(new URL("../.browser-test/native-redesigned-popup.png", import.meta.url), Buffer.from(screenshot.data, "base64"));
  // DOM-only overflow fixtures leave saved tabs intact.
  await evaluate("(()=>{for(let i=0;i<30;i++){const row=document.createElement('div');row.className='tab-card';row.textContent='A long tab title '.repeat(14);document.querySelector('#tabs').append(row);}})()");
  const overflow = await measure(); assert.deepEqual(overflow.viewport, initial.viewport); assert.equal(overflow.mainScrollable, true); assert.equal(overflow.outerOverflow, false);
  await evaluate("document.querySelector('main').scrollTop=10000"); assert.equal((await measure()).horizontalOverflow, false);
  console.log(JSON.stringify({ result: "PASS", initial, overflow, screenshot: ".browser-test/native-redesigned-popup.png" }, null, 2));
  if (process.argv.includes("--close")) await connection.send("Browser.close");
} finally { connection.close(); }
