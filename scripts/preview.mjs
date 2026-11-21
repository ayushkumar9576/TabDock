import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const directories = ["popup", "shared", "assets", "preview"];
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
let revision = Date.now();
const watchers = directories.map(directory => watch(new URL(`${directory}/`, root), { recursive: true }, () => { revision++; }));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") {
      response.writeHead(302, { location: "/preview/index.html" }); response.end(); return;
    }
    if (url.pathname === "/preview-revision") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ revision })); return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const segments = pathname.slice(1).split("/");
    if (!directories.includes(segments[0]) || segments.some(part => part === ".." || part.includes("\\") || part.includes(":"))) { response.writeHead(404); response.end("Not found"); return; }
    const file = new URL(`.${pathname}`, root);
    const body = await readFile(fileURLToPath(file));
    response.writeHead(200, { "content-type": types[extname(pathname)] || "application/octet-stream", "cache-control": "no-store" });
    response.end(body);
  } catch { response.writeHead(404); response.end("Not found"); }
});
const port = Number(process.env.TABDOCK_PREVIEW_PORT || 5173);
server.on("error", error => { console.error(error.code === "EADDRINUSE" ? `Port ${port} is in use. Set TABDOCK_PREVIEW_PORT to use another port.` : error.message); watchers.forEach(watcher => watcher.close()); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => console.log(`Frontend preview: http://127.0.0.1:${port}\nEdit popup/popup.css, popup/popup.js, or popup/popup.html; changes refresh automatically.\nPress Ctrl+C to stop.`));
