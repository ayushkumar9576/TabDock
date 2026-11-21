const port = Number(process.env.TABDOCK_DEBUG_PORT || 9224);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(target => target.type === "page");
if (!page) throw new Error("No browser page target is available.");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let nextId = 1; const pending = new Map();
socket.addEventListener("message", event => { const message = JSON.parse(event.data); const task = pending.get(message.id); if (task) { pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); } });
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
await send("Page.navigate", { url: "chrome://extensions/" });
await new Promise(resolve => setTimeout(resolve, 400));
const expression = `chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}).then(items=>items.filter(item=>item.name==='TabDock').map(item=>({state:item.state,disableReasons:item.disableReasons,manifestErrors:item.manifestErrors,runtimeErrors:item.runtimeErrors,runtimeWarnings:item.runtimeWarnings,views:item.views})))`;
const details = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(details.result.value, null, 2));
if (process.argv.includes("--pin")) {
  const pin = await send("Runtime.evaluate", { expression: "chrome.developerPrivate.updateExtensionConfiguration({extensionId:'ghbgikahkmmhpkjhhgikfbbbpdkheohi',pinnedToToolbar:true}).then(()=>chrome.management.get('ghbgikahkmmhpkjhhgikfbbbpdkheohi'))", awaitPromise: true, returnByValue: true });
  if (pin.exceptionDetails) throw new Error(pin.exceptionDetails.exception?.description || pin.exceptionDetails.text);
  console.log("Pinned isolated test extension.");
}
if (process.argv.includes("--apis")) {
  const apis = await send("Runtime.evaluate", { expression: "Object.keys(chrome.developerPrivate).sort()", returnByValue: true });
  console.log(JSON.stringify(apis.result.value, null, 2));
}
socket.close();
