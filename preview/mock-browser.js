import { initialState, makeGroup, makeLink, sortGroups, findGroup, findLink, moveLink, moveEntry, groupLink, ungroupLink, cleanLooseTabs } from "../shared/model.js";

// Keep the legacy key so existing TabDock frontend previews retain their saved data.
const KEY = "tab-harbor-frontend-preview";
const listeners = new Set();
const clone = value => structuredClone(value);

function samples(fixture = "default") {
  const state = initialState();
  if (fixture === "empty") return state;
  const loose = (url, title) => {
    const group = makeGroup({ name: title, ungrouped: true }, state.groups.length);
    group.links.push(makeLink({ url, title })); state.groups.push(group);
  };
  loose("https://www.youtube.com/watch?v=jfKfPfyJRdk", "lofi hip hop radio — beats to relax/study to");
  const coding = makeGroup({ name: "LeetCode", color: "green" }, state.groups.length);
  coding.links = [
    ["two-sum", "Two Sum"],
    ["longest-substring-without-repeating-characters", "Longest Substring Without Repeating Characters"],
    ["merge-intervals", "Merge Intervals"],
  ].map(([slug, title]) => makeLink({ url: `https://leetcode.com/problems/${slug}/`, title }));
  state.groups.push(coding);
  loose("https://developer.mozilla.org/en-US/docs/Web/JavaScript", "JavaScript reference · MDN Web Docs");
  const reading = makeGroup({ name: "Reading", color: "blue", collapsed: true }, state.groups.length);
  reading.links.push(makeLink({ url: "https://web.dev/learn/css/", title: "Learn CSS: layout, typography, and responsive design" }));
  state.groups.push(reading);
  if (fixture === "long") {
    coding.name = "A very long group name to check truncation and layout";
    for (let n = 1; n <= 20; n++) loose(`https://example.com/notes/${n}`, `Research note ${n}: a deliberately long title to test wrapping, scrolling, and dragging across the list`);
  }
  return state;
}

let state;
try { state = JSON.parse(localStorage.getItem(KEY)); } catch { /* Start fresh if preview data is invalid. */ }
if (!state || state.version !== 1 || !Array.isArray(state.groups)) state = samples();
state.settings = { removeAfterOpen: state.settings?.removeAfterOpen === true, includeNewTabs: state.settings?.includeNewTabs !== false, starAllTabs: state.settings?.starAllTabs === true };

function persist() {
  cleanLooseTabs(state);
  localStorage.setItem(KEY, JSON.stringify(state));
  queueMicrotask(() => listeners.forEach(listener => listener({ tabHarbor: { newValue: clone(state) } }, "local")));
}
function report(text) { window.parent.postMessage({ type: "TABDOCK_PREVIEW_ACTION", text }, location.origin); }

async function handle(message) {
  switch (message.type) {
    case "GET_STATE": return { ...clone(state), groups: clone(sortGroups(state.groups)) };
    case "GET_BROWSER": return { windowId: 1, tabCount: 0, groups: [] };
    case "GET_NOTICE": return null;
    case "UPDATE_SETTINGS": {
      const preferences = ["removeAfterOpen", "includeNewTabs", "starAllTabs"].filter(key => message[key] !== undefined);
      if (!preferences.length || preferences.some(key => typeof message[key] !== "boolean")) throw new Error("Choose a valid setting.");
      for (const key of preferences) state.settings[key] = message[key];
      break;
    }
    case "GROUP_LINK": groupLink(state, message.sourceId, message.linkId, message.name); break;
    case "MOVE_LINK": moveLink(state, message.sourceId, message.linkId, message.targetId, message.beforeId); break;
    case "MOVE_ENTRY": moveEntry(state, message.groupId, message.beforeId); break;
    case "UNGROUP_LINK": ungroupLink(state, message.sourceId, message.linkId, message.beforeId); break;
    case "DELETE_LINK": {
      const { group } = findLink(state, message.groupId, message.linkId);
      group.links = group.links.filter(link => link.id !== message.linkId);
      break;
    }
    case "DELETE_GROUP": {
      findGroup(state, message.groupId); state.groups = state.groups.filter(group => group.id !== message.groupId); break;
    }
    case "UPDATE_GROUP": {
      const group = findGroup(state, message.groupId);
      if (message.name !== undefined) {
        const name = String(message.name).trim().slice(0, 120);
        if (!name) throw new Error("Give the group a name.");
        group.name = name;
      }
      if (message.collapsed !== undefined) group.collapsed = Boolean(message.collapsed);
      break;
    }
    case "OPEN_LINK": {
      const { group, link } = findLink(state, message.groupId, message.linkId);
      report(`Would restore unloaded in the background: ${link.title}`);
      if (message.remove ?? state.settings.removeAfterOpen) { group.links = group.links.filter(item => item.id !== link.id); persist(); }
      return { tabIds: [], warnings: [] };
    }
    case "OPEN_GROUP": {
      const group = findGroup(state, message.groupId);
      if (!group.links.length) throw new Error("This group has no saved links.");
      report(`Would restore ${group.name} unloaded in the background: ${group.links.map(link => link.title).join(" → ")}`);
      if (message.remove ?? state.settings.removeAfterOpen) { state.groups = state.groups.filter(item => item.id !== group.id); persist(); }
      return { tabIds: [], warnings: [] };
    }
    default: throw new Error("This action is only available in the installed extension.");
  }
  persist(); return null;
}

globalThis.chrome = {
  runtime: {
    getURL(path) { return new URL(path === "_favicon/" ? "favicon.svg" : `../${path}`, import.meta.url).href; },
    async sendMessage(message) {
      try { return { ok: true, data: await handle(message) }; }
      catch (error) { return { ok: false, error: error.message }; }
    },
  },
  storage: { onChanged: { addListener(listener) { listeners.add(listener); } } },
};
window.addEventListener("message", event => {
  if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== "TABDOCK_PREVIEW_RESET") return;
  const settings = state.settings; state = samples(event.data.fixture); state.settings = settings; persist();
});
