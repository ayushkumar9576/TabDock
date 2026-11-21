export class CDP {
  constructor(url) {
    this.socket = new WebSocket(url); this.pending = new Map(); this.nextId = 1; this.events = [];
    this.ready = new Promise((resolve, reject) => { this.socket.addEventListener("open", resolve, { once: true }); this.socket.addEventListener("error", reject, { once: true }); });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) { this.events.push(message); return; }
      const task = this.pending.get(message.id); this.pending.delete(message.id);
      if (task) { clearTimeout(task.timer); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); }
    });
  }
  async send(method, params = {}, sessionId) {
    await this.ready; const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(sessionId, expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function poll(check, message = "Browser did not become ready") {
  const deadline = Date.now() + 8000;
  do { const result = await check(); if (result) return result; await pause(80); } while (Date.now() < deadline);
  throw new Error(message);
}
export async function connect() {
  const port = Number(process.env.TABDOCK_DEBUG_PORT || 9224);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const connection = new CDP(version.webSocketDebuggerUrl); await connection.ready;
  let targets = (await connection.send("Target.getTargets")).targetInfos;
  if (!targets.some(target => target.url.endsWith("/background/worker.js"))) {
    const extensionPage = targets.find(target => target.url.startsWith("chrome-extension://") && /\/(popup|pages)\//.test(target.url));
    let extensionBase = extensionPage ? extensionPage.url.split("/").slice(0, 3).join("/") + "/" : null;
    if (!extensionPage) {
      const { targetId } = await connection.send("Target.createTarget", { url: "chrome://extensions/" });
      const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
      await poll(() => connection.evaluate(sessionId, "typeof chrome.developerPrivate !== 'undefined'"));
      const extensions = await connection.evaluate(sessionId, "chrome.developerPrivate.getExtensionsInfo({includeDisabled:false,includeTerminated:true}).then(items=>items.filter(item=>item.name==='TabDock').map(item=>item.id))");
      if (!extensions.length) throw new Error("Load TabDock in the isolated test browser first");
      extensionBase = `chrome-extension://${extensions[0]}/`;
    }
    await connection.send("Target.createTarget", { url: `${extensionBase}popup/popup.html` });
  }
  const worker = await poll(async () => (await connection.send("Target.getTargets")).targetInfos.find(target => target.url.endsWith("/background/worker.js")), "No extension worker found in the isolated test browser");
  return { connection, version, worker, base: worker.url.replace("background/worker.js", "") };
}
