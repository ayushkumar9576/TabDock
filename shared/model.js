export const COLORS = {
  grey: "#8C8478", blue: "#3D7BD9", red: "#D9453D", yellow: "#F2B134",
  green: "#4A9B5F", pink: "#EC6A9B", purple: "#8A5CC2", cyan: "#2BA6B8", orange: "#EF8A3C",
};
export const UNDO_MS = 30_000;
export const PLAN_MS = 5 * 60_000;
export const id = () => crypto.randomUUID();

export function savableUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function savableTabUrl(value) {
  const web = savableUrl(value);
  if (web) return web;
  try {
    const url = new URL(value);
    if (url.protocol === "about:" && url.pathname === "blank") return url.href;
    if (["chrome:", "brave:", "edge:"].includes(url.protocol) && url.hostname === "newtab" &&
      ["", "/"].includes(url.pathname) && !url.username && !url.password && !url.port) return url.href;
  } catch { /* Unsupported browser pages stay open. */ }
  return null;
}

export function isNewTabUrl(value) {
  return Boolean(savableTabUrl(value) && !savableUrl(value));
}

export function displayTitle(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "about:" && parsed.pathname === "blank") return "Blank tab";
    if (parsed.hostname === "newtab" && !["http:", "https:"].includes(parsed.protocol)) return "New tab";
    return parsed.hostname.replace(/^www\./, "");
  }
  catch { return "Saved link"; }
}

export function makeLink(tab) {
  const url = savableTabUrl(tab.url);
  if (!url) throw new Error("Only web pages, New Tab, and blank tabs can be saved.");
  return {
    id: id(), url, title: String(tab.title || displayTitle(url)).slice(0, 1000),
    favicon: String(tab.favicon || tab.favIconUrl || ""), savedAt: Date.now(), pinned: Boolean(tab.pinned),
  };
}

export function makeGroup(input = {}, order = 0) {
  return {
    id: id(), name: String(input.name || "Untitled group").trim().slice(0, 120) || "Untitled group",
    color: Object.hasOwn(COLORS, input.color) ? input.color : "blue",
    collapsed: Boolean(input.collapsed), order, fromNativeGroup: Boolean(input.fromNativeGroup),
    lazyOpen: input.lazyOpen !== false, links: [],
    ...(input.ungrouped ? { ungrouped: true } : {}),
    ...(input.fromNativeGroup && typeof input.originalTitle === "string" ? { nativeTitle: input.originalTitle } : {}),
  };
}

export function initialState() {
  return { version: 1, groups: [], pendingMoves: [], undo: [], settings: { removeAfterOpen: false, includeNewTabs: true } };
}

export function sortGroups(groups) { return [...groups].sort((a, b) => a.order - b.order); }
export function reindex(groups) { groups.forEach((group, order) => { group.order = order; }); return groups; }

export function findGroup(state, groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!group) throw new Error("This saved group no longer exists.");
  return group;
}

export function findLink(state, groupId, linkId) {
  const group = findGroup(state, groupId);
  const link = group.links.find(item => item.id === linkId);
  if (!link) throw new Error("This link no longer exists.");
  return { group, link };
}

export function moveLink(state, sourceId, linkId, targetId, beforeId = null) {
  const { group, link } = findLink(state, sourceId, linkId);
  const target = findGroup(state, targetId);
  if (target.ungrouped && target.id !== group.id) throw new Error("Choose a named group as the destination.");
  if (beforeId === linkId && sourceId === targetId) return;
  group.links = group.links.filter(item => item.id !== linkId);
  const index = beforeId ? target.links.findIndex(item => item.id === beforeId) : -1;
  target.links.splice(index < 0 ? target.links.length : index, 0, link);
  cleanLooseTabs(state);
}

// Standalone cards use the same durable group/link storage as saved native groups.
// Each ungrouped entry contains one link, so a single order covers the whole list.
export function cleanLooseTabs(state) {
  state.groups = reindex(sortGroups(state.groups).filter(group => !group.ungrouped || group.links.length));
}

export function moveEntry(state, groupId, beforeId = null) {
  const groups = sortGroups(state.groups);
  const group = findGroup(state, groupId);
  if (beforeId === groupId) return;
  if (beforeId) findGroup(state, beforeId);
  const remaining = groups.filter(item => item.id !== groupId);
  const index = beforeId ? remaining.findIndex(item => item.id === beforeId) : remaining.length;
  remaining.splice(index, 0, group);
  state.groups = reindex(remaining);
}

export function ungroupLink(state, sourceId, linkId, beforeId = null) {
  const { group, link } = findLink(state, sourceId, linkId);
  if (beforeId) findGroup(state, beforeId);
  if (group.ungrouped) { moveEntry(state, group.id, beforeId); return group; }
  const loose = makeGroup({ name: link.title, ungrouped: true }, state.groups.length);
  group.links = group.links.filter(item => item.id !== linkId);
  loose.links.push(link);
  state.groups.push(loose);
  moveEntry(state, loose.id, beforeId);
  return loose;
}

export function groupLink(state, sourceId, linkId, name) {
  const { group, link } = findLink(state, sourceId, linkId);
  const created = makeGroup({ name, color: "green" }, state.groups.length);
  created.links.push(link);
  group.links = group.links.filter(item => item.id !== linkId);
  state.groups.push(created);
  moveEntry(state, created.id, group.id);
  cleanLooseTabs(state);
  return created;
}

export function matchingGroups(groups, name) {
  const normalized = name.trim().toLocaleLowerCase();
  return groups.filter(group => !group.ungrouped && group.name.trim().toLocaleLowerCase() === normalized);
}

// Lazy tabs carry their metadata in their own URL, so browser/session restarts need no in-memory map.
export function lazyUrl(baseUrl, link) {
  return `${baseUrl}#${new URLSearchParams({ url: link.url, title: link.title, favicon: link.favicon || "" })}`;
}

export function parseLazyUrl(value, baseUrl) {
  if (!value?.startsWith(`${baseUrl}#`)) return null;
  const params = new URLSearchParams(value.slice(baseUrl.length + 1));
  const url = savableTabUrl(params.get("url"));
  return url ? { url, title: params.get("title") || displayTitle(url), favicon: params.get("favicon") || "" } : null;
}

export function tabSnapshot(tab, baseUrl) {
  const lazy = parseLazyUrl(tab.pendingUrl || tab.url, baseUrl);
  return {
    id: tab.id, windowId: tab.windowId, index: tab.index, groupId: tab.groupId ?? -1,
    pinned: Boolean(tab.pinned), active: Boolean(tab.active), discarded: Boolean(tab.discarded),
    ...(lazy || { url: tab.pendingUrl || tab.url || "", title: tab.title || "", favicon: tab.favIconUrl || "" }),
  };
}

export function pruneState(state, now = Date.now()) {
  state.pendingMoves = state.pendingMoves.filter(plan => now - plan.createdAt < PLAN_MS);
  state.undo = state.undo.filter(item => item.expiresAt > now);
  return state;
}
