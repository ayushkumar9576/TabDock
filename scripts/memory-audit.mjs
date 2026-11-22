// Windows/Brave audit. Uses a new disposable profile and localhost pages only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, pause, poll } from "./cdp.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const extensionPath = baseline ? `${root}.browser-test/memory-baseline-extension` : root;
const profile = `${root}.browser-test/memory-${baseline ? "before" : "after"}-${Date.now()}`;
mkdirSync(profile, { recursive: true });
process.env.TABDOCK_DEBUG_PORT = "9227";
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><title>Memory ${request.url}</title><script>window.memoryData=new Uint8Array(16*1024*1024);window.memoryData.fill(7);let n=0;window.memoryTicker=setInterval(()=>{document.title='Memory ${request.url} '+(++n);},1000);</script><p>Controlled 16 MiB page</p>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const site = `http://127.0.0.1:${server.address().port}`;
const report = { phase: baseline ? "before" : "after", allocationPerPageMiB: 16, savedLinks: 5000, metric: "Private resident memory of the isolated Brave process tree. Extension processes are a subset; injected page scripts reside in page processes. Measurements include browser baseline and allocator noise.", samples: [] };
const output = new URL(`../.browser-test/${baseline ? "memory-audit-before.json" : "memory-audit-results.json"}`, import.meta.url);
let browser, connection, base, developerSession;
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
async function snapshot(label, extra = {}) {
  const browserPid = browser.pid;
  assert.ok(Number.isInteger(browserPid) && browserPid > 0);
  const code = `$auditProcesses = @(Get-CimInstance Win32_Process); $auditIds = [System.Collections.Generic.HashSet[int]]::new(); [void]$auditIds.Add(${browserPid}); $auditChanged = $true; while ($auditChanged) { $auditChanged = $false; foreach ($auditProcess in $auditProcesses) { if ($auditIds.Contains([int]$auditProcess.ParentProcessId) -and $auditIds.Add([int]$auditProcess.ProcessId)) { $auditChanged = $true } } }; $auditExtensionIds = @($auditProcesses | Where-Object { $auditIds.Contains([int]$_.ProcessId) -and $_.CommandLine -match '--extension-process' } | Select-Object -ExpandProperty ProcessId); $auditPerf = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $auditIds.Contains([int]$_.IDProcess) }); $auditSelected = @(Get-Process -Id @($auditIds) -ErrorAction SilentlyContinue); [pscustomobject]@{processCount=$auditSelected.Count;privateResidentBytes=($auditPerf | Measure-Object WorkingSetPrivate -Sum).Sum;privateCommittedBytes=($auditSelected | Measure-Object PrivateMemorySize64 -Sum).Sum;extensionPrivateResidentBytes=($auditPerf | Where-Object { $auditExtensionIds -contains $_.IDProcess } | Measure-Object WorkingSetPrivate -Sum).Sum;extensionPrivateCommittedBytes=($auditSelected | Where-Object { $auditExtensionIds -contains $_.Id } | Measure-Object PrivateMemorySize64 -Sum).Sum} | ConvertTo-Json -Compress`;
  const data = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", code], { encoding: "utf8", windowsHide: true }));
  const targets = (await connection.send("Target.getTargets")).targetInfos;
  const sample = { label, ...Object.fromEntries(Object.entries(data).map(([key, value]) => [key.endsWith("Bytes") ? key.replace("Bytes", "MiB") : key, key.endsWith("Bytes") ? +((value || 0) / 1048576).toFixed(2) : value])), workerRunning: targets.some(target => target.url === `${base}background/worker.js`), ...extra };
  report.samples.push(sample); save(); console.log(JSON.stringify(sample));
}
async function task(callback, popup = false) {
  const { targetId } = await connection.send("Target.createTarget", { url: `${base}${popup ? "popup/popup.html" : "pages/lazy.html"}` });
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = code => connection.evaluate(sessionId, code);
  await poll(() => evaluate(popup ? "document.body?.dataset.ready==='true' && !document.body.hasAttribute('aria-busy')" : "typeof chrome?.tabs!=='undefined'"));
  const call = async (type, payload = {}) => {
    const result = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ ...payload, type })})`);
    assert.equal(result.ok, true, result.error); return result.data;
  };
  try { return await callback({ evaluate, call, sessionId }); }
  finally { await connection.send("Target.closeTarget", { targetId }); }
}
async function settle() { console.log("Waiting 35 seconds without extension requests..."); await pause(35000); }
try {
  const occupied = await fetch("http://127.0.0.1:9227/json/version").then(() => true, () => false);
  if (occupied) throw new Error("Port 9227 is occupied; refusing to touch another browser");
  browser = spawn("C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", ["--headless=new", "--remote-debugging-port=9227", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, `--load-extension=${extensionPath}`, `--disable-extensions-except=${extensionPath}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking", "about:blank"], { windowsHide: true, stdio: "ignore" });
  await poll(async () => { try { return (await fetch("http://127.0.0.1:9227/json/version")).ok; } catch { return false; } });
  const connected = await connect(); connection = connected.connection; base = connected.base; report.browser = connected.version.Browser;
  const developer = await connection.send("Target.createTarget", { url: "chrome://extensions/" });
  ({ sessionId: developerSession } = await connection.send("Target.attachToTarget", { targetId: developer.targetId, flatten: true }));
  await poll(() => connection.evaluate(developerSession, "typeof chrome.developerPrivate!=='undefined'"));
  const extensionId = base.split("/")[2];
  await connection.evaluate(developerSession, `chrome.developerPrivate.addHostPermission(${JSON.stringify(extensionId)},'http://127.0.0.1/*')`);
  for (const target of (await connection.send("Target.getTargets")).targetInfos.filter(target => target.type === "page" && target.targetId !== developer.targetId)) await connection.send("Target.closeTarget", { targetId: target.targetId });
  await connection.evaluate(developerSession, `chrome.management.setEnabled(${JSON.stringify(extensionId)},false)`);
  const pages = [];
  for (const path of ["one", "two", "three"]) {
    const { targetId } = await connection.send("Target.createTarget", { url: `${site}/${path}` });
    pages.push(targetId);
    const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    await poll(() => connection.evaluate(sessionId, "window.memoryData?.byteLength===16*1024*1024"));
    await connection.send("Target.detachFromTarget", { sessionId });
  }
  await settle(); await snapshot("Disabled, three pages changing their titles");
  await connection.evaluate(developerSession, `chrome.management.setEnabled(${JSON.stringify(extensionId)},true)`);
  await task(async ({ evaluate }) => {
    await evaluate(`(()=>{const groups=[];for(let g=0;g<50;g++)groups.push({id:'group-'+g,name:'Saved group '+g,color:'blue',collapsed:true,order:g,fromNativeGroup:false,lazyOpen:true,links:Array.from({length:100},(_,n)=>({id:'link-'+g+'-'+n,url:'https://example.com/'+g+'/'+n,title:'Saved research page '+n+' '+('x'.repeat(200)),favicon:'',savedAt:Date.now(),pinned:false}))});return chrome.storage.local.set({tabHarbor:{version:1,groups,pendingMoves:[],undo:[],settings:{removeAfterOpen:false,includeNewTabs:true,starAllTabs:false}}});})()`);
    report.savedLibraryBytes = await evaluate("chrome.storage.local.getBytesInUse('tabHarbor')");
  });
  for (const targetId of pages) {
    const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    await connection.send("Page.reload", {}, sessionId);
    await poll(() => connection.evaluate(sessionId, "window.memoryData?.byteLength===16*1024*1024"));
    await connection.send("Target.detachFromTarget", { sessionId });
  }
  await task(async ({ evaluate, sessionId }) => {
    const dom = await evaluate("({rows:document.querySelectorAll('.tab-card').length,elements:document.querySelectorAll('*').length})");
    const heap = await connection.send("Runtime.getHeapUsage", {}, sessionId);
    await snapshot("Popup open, 5,000 links in collapsed groups", { ...dom, popupHeapMiB: +(heap.usedSize / 1048576).toFixed(2) });
  }, true);
  await settle(); await snapshot("Unstarred pages changing titles, popup closed, 5,000 saved links");
  let groupId;
  await task(async ({ evaluate, call }) => {
    const tabs = await evaluate(`chrome.tabs.query({}).then(tabs=>tabs.filter(tab=>tab.url?.startsWith(${JSON.stringify(site)})))`);
    groupId = await evaluate(`chrome.tabs.group({tabIds:${JSON.stringify(tabs.map(tab => tab.id))}})`);
    await evaluate(`chrome.tabGroups.update(${groupId},{title:'Memory group',color:'blue'})`);
    await evaluate(`chrome.tabs.update(${tabs[0].id},{active:true})`);
    await call("STAR_BROWSER_GROUP", { tabId: tabs[0].id, starred: true });
    await poll(() => evaluate(`chrome.tabs.query({groupId:${groupId}}).then(tabs=>tabs.filter(tab=>tab.discarded).length===2)`));
  });
  await settle(); await snapshot("Starred group, one changing-title page loaded and two discarded");
  const target = (await connection.send("Target.getTargets")).targetInfos.find(target => target.type === "page" && target.url.startsWith(site));
  assert.ok(target, "Expected one loaded fixture page");
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  await connection.evaluate(sessionId, "clearInterval(window.memoryTicker)");
  await connection.send("Target.detachFromTarget", { sessionId });
  await settle(); await snapshot("Starred group idle, one static page loaded and two discarded");
  report.result = "PASS"; save(); console.log(`Saved ${fileURLToPath(output)}`);
} catch (error) { report.result = "FAIL"; report.error = error.message; save(); throw error; }
finally {
  if (connection) { await connection.send("Browser.close").catch(() => { }); connection.close(); }
  else if (browser && browser.exitCode === null) browser.kill();
  server.close();
}
