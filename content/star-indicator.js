// Runs in the extension's isolated world. No page contents leave the browser.
(() => {
  if (globalThis.tabDockStarIndicator) return;
  const attribute = "data-tabdock-original-title";
  let starred = false;
  let observer;
  let observedTitle;
  function observeTitle() {
    const title = document.querySelector("title");
    if (title === observedTitle) return;
    observer.disconnect(); observedTitle = title;
    // Watch title text and replacement of the title element, not meta/style or body changes.
    if (document.head) observer.observe(document.head, { childList: true });
    if (title) observer.observe(title, { childList: true, characterData: true, subtree: true });
  }
  function update() {
    try { chrome.runtime.getURL(""); } catch { observer?.disconnect(); return; }
    const title = document.querySelector("title");
    if (starred) observeTitle();
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
    // The original title stays in the DOM. No worker messages or storage writes
    // are needed for routine title changes; sync captures it before discarding.
  }
  function set(value) {
    starred = value === true;
    if (starred) {
      observer ||= new MutationObserver(update);
      observedTitle = undefined; observeTitle();
    } else { observer?.disconnect(); observedTitle = undefined; }
    update();
    return { title: document.querySelector("title")?.getAttribute(attribute) ?? document.title, displayed: document.title };
  }
  globalThis.tabDockStarIndicator = { set };
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id === chrome.runtime.id && message.type === "SET_TAB_STAR_INDICATOR") reply(set(message.starred));
  });
})();
