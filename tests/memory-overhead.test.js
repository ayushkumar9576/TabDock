import test from "node:test";
import assert from "node:assert/strict";
import { mockChrome, tab } from "./mock-chrome.js";
import { initialState } from "../shared/model.js";
import { readSettings, writeState, SETTINGS_KEY, STORAGE_KEY } from "../shared/storage.js";

test("tab events use the small settings record without loading a large saved library", async () => {
  const mock = mockChrome({ tabs: [tab(1), tab(2)] });
  mock.data[SETTINGS_KEY] = initialState().settings;
  let settingsReads = 0;
  const get = mock.chrome.storage.local.get;
  mock.chrome.storage.local.get = async key => {
    assert.notEqual(key, STORAGE_KEY, "Tab events must not load saved links");
    if (key === SETTINGS_KEY) settingsReads++;
    return get(key);
  };
  const stars = await import("../background/stars.js?memory=hot-events");
  for (let n = 0; n < 10; n++) { await stars.enforceStars(1); await stars.enforceStarredTab(1); await stars.getTabStar(1); }
  assert.equal(settingsReads, 1);
});

test("legacy settings migrate once and setting changes update the small record", async () => {
  const mock = mockChrome();
  mock.data[STORAGE_KEY] = initialState(); mock.data[STORAGE_KEY].settings.starAllTabs = true;
  assert.equal((await readSettings()).starAllTabs, true);
  assert.equal(mock.data[SETTINGS_KEY].starAllTabs, true);
  mock.data[STORAGE_KEY].settings.starAllTabs = false;
  await writeState(mock.data[STORAGE_KEY]);
  assert.equal((await readSettings()).starAllTabs, false);
  assert.equal(mock.data[SETTINGS_KEY].starAllTabs, false);
});

test("worker suspension resumes without rescanning tabs or rewriting indicators", async () => {
  const mock = mockChrome({ tabs: [tab(1)] });
  mock.sessionData.tabDockStarsInitialized = true;
  mock.chrome.tabs.query = async () => { throw new Error("Unexpected browser-wide scan"); };
  mock.chrome.storage.local.get = async () => { throw new Error("Unexpected saved data read"); };
  const stars = await import("../background/stars.js?memory=worker-resume");
  await stars.initializeStars();
  assert.equal(mock.log.length, 0);
});

test("a pending settings read cannot overwrite a newer user preference", async () => {
  const mock = mockChrome();
  let finishRead;
  mock.chrome.storage.local.get = async () => new Promise(resolve => { finishRead = resolve; });
  const pending = readSettings();
  const state = initialState(); state.settings.starAllTabs = true;
  await writeState(state);
  finishRead({ [SETTINGS_KEY]: initialState().settings });
  assert.equal((await pending).starAllTabs, true);
  assert.equal((await readSettings()).starAllTabs, true);
  assert.equal(mock.data[SETTINGS_KEY].starAllTabs, true);
});
