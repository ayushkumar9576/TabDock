import { tabSnapshot } from "../shared/model.js";
import { cleanBrowserGroup } from "./indicators.js";

export const STAR_RECORDS_KEY = "tabDockPersistentStars";
const empty = () => ({ version: 1, tabs: [], groups: [] });
const ordered = tabs => [...tabs].sort((a, b) => a.index - b.index);
const overlap = (left, right) => {
  const counts = new Map();
  for (const url of right) counts.set(url, (counts.get(url) || 0) + 1);
  let count = 0;
  for (const url of left) if (counts.get(url)) { count++; counts.set(url, counts.get(url) - 1); }
  return count;
};

// Chrome has no durable IDs for open tabs or groups. Match restored windows by
// their pages, then bind each star once using URL, duplicate occurrence and order.
export class StarPersistence {
  constructor() {
    this.records = empty();
    this.pendingTabs = new Set();
    this.pendingGroups = new Set();
    this.windows = {};
    this.closingWindows = new Set();
  }
  async load(session) {
    const stored = (await chrome.storage.local.get(STAR_RECORDS_KEY))[STAR_RECORDS_KEY];
    if (stored?.version === 1 && Array.isArray(stored.tabs) && Array.isArray(stored.groups)) this.records = stored;
    this.lastWritten = JSON.stringify(this.records);
    this.pendingTabs = new Set(session ? session.pendingTabKeys || [] : this.records.tabs.map(tab => tab.key));
    this.pendingGroups = new Set(session ? session.pendingGroupKeys || [] : this.records.groups.map(group => group.key));
    this.windows = session?.restoredWindows || {};
  }
  session(stars) {
    if (!this.pendingTabs.size && !this.pendingGroups.size) return stars;
    return { ...stars, pendingTabKeys: [...this.pendingTabs], pendingGroupKeys: [...this.pendingGroups], restoredWindows: this.windows };
  }
  snapshots(tabs) { return tabs.map(tab => tabSnapshot(tab, chrome.runtime.getURL("pages/lazy.html"))); }
  needsRestore(tab) {
    if (!this.pendingTabs.size && !this.pendingGroups.size) return false;
    if (!tab) return true;
    const url = this.snapshots([tab])[0].url;
    return this.records.tabs.some(record => this.pendingTabs.has(record.key) && record.url === url) ||
      this.records.groups.some(record => this.pendingGroups.has(record.key) && record.tabs.some(member => member.url === url));
  }
  async restore(stars, liveTabs) {
    if (!this.needsRestore()) return stars;
    const tabs = this.snapshots(liveTabs);
    const groups = this.pendingGroups.size ? await chrome.tabGroups.query({}) : [];
    const oldWindows = new Set([
      ...this.records.tabs.filter(tab => this.pendingTabs.has(tab.key)).map(tab => tab.windowId),
      ...this.records.groups.filter(group => this.pendingGroups.has(group.key)).map(group => group.windowId),
    ]);
    const usedWindows = new Set(Object.values(this.windows));
    const edges = [];
    for (const oldWindow of oldWindows) {
      if (this.windows[oldWindow] !== undefined) continue;
      const savedTabs = this.records.tabs.filter(tab => tab.windowId === oldWindow);
      const savedGroups = this.records.groups.filter(group => group.windowId === oldWindow);
      const urls = [...savedTabs.map(tab => tab.url), ...savedGroups.flatMap(group => group.tabs.map(tab => tab.url))];
      for (const windowId of new Set(tabs.map(tab => tab.windowId))) {
        if (usedWindows.has(windowId)) continue;
        const members = tabs.filter(tab => tab.windowId === windowId);
        const score = overlap(urls, members.map(tab => tab.url));
        if (score) edges.push({ oldWindow, windowId, score });
      }
    }
    for (const edge of edges.sort((a, b) => b.score - a.score)) {
      if (this.windows[edge.oldWindow] !== undefined || usedWindows.has(edge.windowId)) continue;
      this.windows[edge.oldWindow] = edge.windowId; usedWindows.add(edge.windowId);
    }
    const next = { tabIds: [...stars.tabIds], groupIds: [...stars.groupIds] };
    const usedTabs = new Set(next.tabIds), usedGroups = new Set(next.groupIds);
    for (const record of this.records.tabs) {
      if (!this.pendingTabs.has(record.key)) continue;
      const windowId = this.windows[record.windowId];
      const matches = ordered(tabs.filter(tab => tab.windowId === windowId && tab.url === record.url && tab.pinned === record.pinned));
      const match = matches[record.occurrence || 0];
      if (!match || usedTabs.has(match.id)) continue;
      next.tabIds.push(match.id); usedTabs.add(match.id); this.pendingTabs.delete(record.key);
      record.id = match.id; record.windowId = windowId;
    }
    for (const record of this.records.groups) {
      if (!this.pendingGroups.has(record.key)) continue;
      const candidates = groups.filter(group => group.windowId === this.windows[record.windowId] && !usedGroups.has(group.id) &&
        (group.title === record.title || group.title === `★ ${record.title}`) && group.color === record.color)
        .map(group => {
          const members = ordered(tabs.filter(tab => tab.groupId === group.id));
          return { group, members, score: overlap(record.tabs.map(tab => tab.url), members.map(tab => tab.url)), distance: Math.abs((members[0]?.index ?? 0) - (record.tabs[0]?.index ?? 0)) };
        }).filter(candidate => candidate.score).sort((a, b) => b.score - a.score || a.distance - b.distance);
      const match = candidates[0];
      if (!match) continue;
      next.groupIds.push(match.group.id); usedGroups.add(match.group.id); this.pendingGroups.delete(record.key);
      record.id = match.group.id; record.windowId = match.group.windowId;
      record.tabs = match.members.map(({ id, url, index, pinned }) => ({ id, url, index, pinned }));
    }
    return next;
  }
  async capture(stars, previous = stars, { preserveRemoved = false, tabs: suppliedTabs } = {}) {
    const records = structuredClone(this.records);
    if (!preserveRemoved) {
      records.tabs = records.tabs.filter(record => this.pendingTabs.has(record.key) || !previous.tabIds.includes(record.id) || stars.tabIds.includes(record.id));
      records.groups = records.groups.filter(record => this.pendingGroups.has(record.key) || !previous.groupIds.includes(record.id) || stars.groupIds.includes(record.id));
    }
    if (stars.tabIds.length || stars.groupIds.length) {
      const tabs = this.snapshots(suppliedTabs || await chrome.tabs.query({}));
      for (const id of stars.tabIds) {
        const tab = tabs.find(tab => tab.id === id);
        if (!tab || this.closingWindows.has(tab.windowId)) continue;
        const matches = ordered(tabs.filter(member => member.windowId === tab.windowId && member.url === tab.url && member.pinned === tab.pinned));
        const previousRecord = records.tabs.find(record => record.id === id && !this.pendingTabs.has(record.key));
        const record = { key: previousRecord?.key || crypto.randomUUID(), id, windowId: tab.windowId, url: tab.url, index: tab.index, pinned: tab.pinned, occurrence: matches.findIndex(member => member.id === id),
          ...(matches.length > 1 ? { duplicateIds: matches.map(member => member.id) } : {}) };
        records.tabs = records.tabs.filter(record => record.id !== id || this.pendingTabs.has(record.key)); records.tabs.push(record);
      }
      for (const id of stars.groupIds) {
        let group;
        try { group = await cleanBrowserGroup(await chrome.tabGroups.get(id)); } catch { continue; }
        const members = ordered(tabs.filter(tab => tab.groupId === id));
        if (!members.length) continue;
        if (this.closingWindows.has(group.windowId)) continue;
        const previousRecord = records.groups.find(record => record.id === id && !this.pendingGroups.has(record.key));
        const title = previousRecord && group.title === `★ ${previousRecord.title}` ? previousRecord.title : group.title;
        const record = { key: previousRecord?.key || crypto.randomUUID(), id, windowId: group.windowId, title, color: group.color,
          tabs: members.map(({ id, url, index, pinned }) => ({ id, url, index, pinned })) };
        records.groups = records.groups.filter(record => record.id !== id || this.pendingGroups.has(record.key)); records.groups.push(record);
      }
    }
    records.tabs.sort((a, b) => a.id - b.id); records.groups.sort((a, b) => a.id - b.id);
    const signature = JSON.stringify(records);
    if (signature !== this.lastWritten) await chrome.storage.local.set({ [STAR_RECORDS_KEY]: records });
    this.records = records; this.lastWritten = signature;
  }
  affectsTab(tabId, tab, stars) {
    const url = tab && this.snapshots([tab])[0].url;
    return stars.tabIds.includes(tabId) || (tab && stars.groupIds.includes(tab.groupId)) ||
      this.records.tabs.some(record => stars.tabIds.includes(record.id) && record.duplicateIds?.includes(tabId)) ||
      (tab && this.records.tabs.some(record => record.windowId === tab.windowId && record.url === url)) ||
      this.records.groups.some(record => stars.groupIds.includes(record.id) && record.tabs.some(member => member.id === tabId));
  }
  windowClosing(windowId) { this.closingWindows.add(windowId); }
}
