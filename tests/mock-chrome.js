export function mockChrome({ tabs = [], groups = [], failRemove = [], failCreate = false, failCreateUrls = [], failStorage = false, failDiscard = false, discardRemaps = false } = {}) {
  const log = [];
  const data = {};
  const sessionData = {};
  const live = structuredClone(tabs);
  const native = new Map(groups.map(group => [group.id, structuredClone(group)]));
  let nextTab = Math.max(100, ...live.map(tab => tab.id)) + 1;
  let nextGroup = Math.max(100, ...groups.map(group => group.id)) + 1;
  const listeners = new Set();
  function indices() { live.forEach((tab, index) => { tab.index = index; }); }
  function getTab(tabId) { const tab = live.find(tab => tab.id === tabId); if (!tab) throw new Error("No tab"); return tab; }
  const chrome = {
    runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", getURL: path => `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${path}` },
    storage: {
      session: {
        get: async key => ({ [key]: structuredClone(sessionData[key]) }),
        set: async value => { log.push(["session-store"]); if (failStorage) throw new Error("Storage quota exceeded"); Object.assign(sessionData, structuredClone(value)); },
      },
      local: {
        get: async key => ({ [key]: structuredClone(data[key]) }),
        set: async value => { log.push(["store"]); if (failStorage) throw new Error("Storage quota exceeded"); Object.assign(data, structuredClone(value)); },
      }
    },
    windows: {
      get: async id => { if (id !== 1) throw new Error("No window"); return { id: 1, type: "normal", focused: true }; },
      getLastFocused: async () => ({ id: 1, type: "normal" }),
      getAll: async () => [{ id: 1, type: "normal", focused: true }],
    },
    tabs: {
      onUpdated: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      get: async tabId => structuredClone(getTab(tabId)),
      query: async query => structuredClone(live.filter(tab => (!query.windowId || tab.windowId === query.windowId) && (!query.active || tab.active) && (query.groupId === undefined || tab.groupId === query.groupId))),
      create: async properties => {
        log.push(["create", properties]);
        const originalUrl = properties.url.startsWith(`${chrome.runtime.getURL("pages/lazy.html")}#`)
          ? new URLSearchParams(new URL(properties.url).hash.slice(1)).get("url") : properties.url;
        if (failCreate || failCreateUrls.includes(originalUrl)) throw new Error("Creation failed");
        if (properties.active) live.forEach(tab => { tab.active = false; });
        const tab = { id: nextTab++, windowId: 1, groupId: -1, discarded: false, status: "complete", title: "", pinned: false, ...properties };
        const pinnedCount = live.filter(item => item.pinned).length;
        const index = properties.pinned ? Math.min(properties.index ?? pinnedCount, pinnedCount) : Math.max(pinnedCount, Math.min(properties.index ?? live.length, live.length));
        live.splice(index, 0, tab); indices(); return structuredClone(tab);
      },
      remove: async tabId => {
        log.push(["remove", tabId]);
        if (failRemove.includes(tabId)) throw new Error("Close rejected");
        getTab(tabId); live.splice(live.findIndex(tab => tab.id === tabId), 1); indices();
        for (const groupId of native.keys()) if (!live.some(tab => tab.groupId === groupId)) native.delete(groupId);
      },
      discard: async tabId => {
        log.push(["discard", tabId]); if (failDiscard) throw new Error("Discard failed");
        const tab = getTab(tabId); tab.discarded = true; tab.status = "unloaded";
        if (discardRemaps) tab.id = nextTab++;
        return structuredClone(tab);
      },
      update: async (tabId, properties) => {
        log.push(["update", tabId, properties]);
        if (properties.active) live.forEach(tab => { tab.active = false; });
        Object.assign(getTab(tabId), properties); return structuredClone(getTab(tabId));
      },
      group: async properties => {
        const groupId = properties.groupId ?? nextGroup++;
        if (!native.has(groupId)) native.set(groupId, { id: groupId, windowId: 1, title: "", color: "grey", collapsed: false });
        for (const tabId of properties.tabIds) { const tab = getTab(tabId); if (tab.pinned) throw new Error("Cannot group pinned tabs"); tab.groupId = groupId; }
        log.push(["group", properties]); return groupId;
      },
    },
    tabGroups: {
      get: async groupId => { if (!native.has(groupId)) throw new Error("No group"); return structuredClone(native.get(groupId)); },
      update: async (groupId, properties) => { if (!native.has(groupId)) throw new Error("No group"); Object.assign(native.get(groupId), properties); return structuredClone(native.get(groupId)); },
    },
  };
  globalThis.chrome = chrome;
  return { chrome, live, native, log, data, sessionData };
}

export function tab(id, overrides = {}) {
  return { id, windowId: 1, index: id - 1, groupId: -1, url: `https://example.com/${id}`, title: `Tab ${id}`, favIconUrl: `https://example.com/icon${id}.png`, pinned: false, active: id === 1, discarded: false, status: "complete", ...overrides };
}
