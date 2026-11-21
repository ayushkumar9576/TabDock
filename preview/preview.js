const popup = document.querySelector("#popup");
document.querySelectorAll("[data-fixture]").forEach(button => button.addEventListener("click", () => {
  popup.contentWindow.postMessage({ type: "TABDOCK_PREVIEW_RESET", fixture: button.dataset.fixture }, location.origin);
  document.querySelector("#action").textContent = "Sample tabs reset. Preview changes are saved separately.";
}));
window.addEventListener("message", event => {
  if (event.origin === location.origin && event.source === popup.contentWindow && event.data?.type === "TABDOCK_PREVIEW_ACTION") document.querySelector("#action").textContent = event.data.text;
});
let revision;
setInterval(async () => {
  try {
    const result = await (await fetch("/preview-revision", { cache: "no-store" })).json();
    if (revision !== undefined && result.revision !== revision) popup.contentWindow.location.reload();
    revision = result.revision;
  } catch { /* Keep the usable preview when the server restarts. */ }
}, 1000);
