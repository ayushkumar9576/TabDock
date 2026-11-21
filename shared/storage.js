import { initialState, pruneState } from "./model.js";
// Keep the legacy key so renaming to TabDock preserves saved tabs and settings.
export const STORAGE_KEY = "tabHarbor";

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
  state.settings = { ...state.settings, removeAfterOpen: state.settings?.removeAfterOpen === true, includeNewTabs: state.settings?.includeNewTabs !== false };
  return pruneState(state);
}

export async function writeState(state) { await chrome.storage.local.set({ [STORAGE_KEY]: state }); }

// Every worker operation goes through this queue, including events and reads.
// No popup writes directly to storage, so simultaneous saves cannot overwrite each other.
let tail = Promise.resolve();
export function exclusive(task) {
  const operation = tail.then(task);
  tail = operation.catch(() => { });
  return operation;
}
