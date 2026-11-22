import { initialState, pruneState } from "./model.js";
// Keep the legacy key so renaming to TabDock preserves saved tabs and settings.
export const STORAGE_KEY = "tabHarbor";
export const SETTINGS_KEY = "tabDockSettings";
let settingsOwner, cachedSettings, settingsRead, settingsPersisted = false;
let settingsRevision = 0;
const normalizeSettings = settings => ({ removeAfterOpen: settings?.removeAfterOpen === true, includeNewTabs: settings?.includeNewTabs !== false, starAllTabs: settings?.starAllTabs === true });
function settingsContext() {
  if (settingsOwner === chrome) return;
  settingsOwner = chrome; cachedSettings = undefined; settingsRead = undefined; settingsPersisted = false; settingsRevision++;
}
export function cacheSettings(settings) { settingsContext(); cachedSettings = normalizeSettings(settings); settingsRevision++; }
export async function readSettings() {
  settingsContext();
  if (cachedSettings) return cachedSettings;
  const revision = settingsRevision;
  if (!settingsRead) settingsRead = (async () => {
    const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
    const legacy = stored === undefined ? (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] : null;
    if (revision !== settingsRevision && cachedSettings) return cachedSettings;
    const settings = normalizeSettings(stored ?? legacy?.settings);
    if (stored === undefined && legacy) await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    settingsPersisted = stored !== undefined || Boolean(legacy);
    if (revision === settingsRevision) cachedSettings = settings;
    return cachedSettings;
  })().finally(() => { settingsRead = undefined; });
  return settingsRead;
}

export async function readState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const state = result[STORAGE_KEY];
  if (!state) {
    const fresh = initialState();
    await writeState(fresh);
    return fresh;
  }
  if (state.version !== 1 || !Array.isArray(state.groups)) {
    throw new Error("Unsupported saved data version. Your data has been left intact.");
  }
  state.pendingMoves ||= [];
  state.undo ||= [];
  state.settings = { ...state.settings, removeAfterOpen: state.settings?.removeAfterOpen === true, includeNewTabs: state.settings?.includeNewTabs !== false, starAllTabs: state.settings?.starAllTabs === true };
  cacheSettings(state.settings);
  return pruneState(state);
}

export async function writeState(state) {
  settingsContext();
  const settings = normalizeSettings(state.settings);
  const value = { [STORAGE_KEY]: state };
  if (!settingsPersisted || JSON.stringify(settings) !== JSON.stringify(cachedSettings)) value[SETTINGS_KEY] = settings;
  await chrome.storage.local.set(value);
  cacheSettings(settings);
  settingsPersisted = true;
}

// Every worker operation goes through this queue, including events and reads.
// No popup writes directly to storage, so simultaneous saves cannot overwrite each other.
let tail = Promise.resolve();
export function exclusive(task) {
  const operation = tail.then(task);
  // Keep only queue completion; GET_STATE results can contain a large library.
  tail = operation.then(() => { }, () => { });
  return operation;
}
