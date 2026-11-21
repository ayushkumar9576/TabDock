// Runs in the extension's isolated world. No page contents leave the browser.
(() => {
  if (globalThis.tabDockStarIndicator) return;
  const attribute = "data-tabdock-original-title";
  let starred = false;
  let observer;
  function update() {
    try { chrome.runtime.getURL(""); } catch { observer?.disconnect(); return; }
    const title = document.querySelector("title");
    if (!title) return;
    const original = title.getAttribute(attribute);
    const value = document.title;
    const base = original !== null && value === `★ ${original}` ? original : value;
    if (starred) {
      title.setAttribute(attribute, base);
      if (value !== `★ ${base}`) document.title = `★ ${base}`;
    } else if (original !== null) {
      title.removeAttribute(attribute);
      if (value === `★ ${original}`) document.title = original;
    }
    if (starred && (original !== base || value !== `★ ${base}`)) {
      chrome.runtime.sendMessage({ type: "STAR_TITLE", title: base }).catch(() => { });
    }
  }
  function set(value) {
    starred = value === true;
    update();
    return { title: document.querySelector("title")?.getAttribute(attribute) ?? document.title, displayed: document.title };
  }
  globalThis.tabDockStarIndicator = { set };
  observer = new MutationObserver(update);
  // Only title/head changes matter; ignore routine body updates.
  observer.observe(document.head || document.documentElement || document, { childList: true, characterData: true, subtree: true });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id === chrome.runtime.id && message.type === "SET_TAB_STAR_INDICATOR") reply(set(message.starred));
  });
  chrome.runtime.sendMessage({ type: "GET_TAB_STAR" }).then(result => { if (result.ok) set(result.data.starred); }).catch(() => { });
})();
