# TabDock memory audit — 2026-11-22

The extension now lets Brave terminate its background worker when idle. In a controlled Windows/Brave run, extension process memory reached **0 MiB** with the popup closed, both for busy unstarred pages and for an idle starred group. A working popup or a worker processing browser events still has Chromium's process baseline; zero total overhead at all times is not achievable.

## Measured results

These are private resident MiB summed across the isolated browser's extension processes. Page scripts run in page processes, so this column alone does not measure every byte of browser bookkeeping or injected JavaScript. The fixture used 5,000 saved links (about 1.7 MB on disk), three localhost pages allocating 16 MiB each, and a new disposable profile for each run. The popup was closed for idle measurements. Each idle period lasted 35 seconds without extension messages or a debugger attached to the worker.

| Scenario | Before | After |
| --- | ---: | ---: |
| Popup open; 5,000 links in collapsed groups | 242.22 MiB | 47.81 MiB |
| Popup closed; unstarred pages change titles every second | 38.71 MiB | 0 MiB |
| Starred group; one busy page loaded, two discarded | 54.53 MiB | 20.56 MiB |
| Starred group idle; one static page loaded, two discarded | 0 MiB | 0 MiB |

The collapsed popup created 50,486 DOM elements before the fix and 486 after it. The busy starred-page case still receives Chromium tab-update events, which require a worker. Memory depends on browser version, page activity, saved data, and allocator behavior; these are single-run measurements, not universal limits.

Raw samples are in `.browser-test/memory-audit-before.json` and `.browser-test/memory-audit-results.json`. Reproduce the current audit on Windows with Brave installed using `npm run test:memory`; it creates its own hidden profile and does not use the normal browser profile.

## Findings and changes

- **Saved library loaded on ordinary events:** Star checks read the complete library for one boolean preference. Settings now have a small separate storage record and a worker-local cache, with automatic migration of existing preferences. Ordinary star/tab events do not fetch saved links.
- **Full initialization on every worker wake:** Module evaluation rebuilt browser menus and scanned all tabs, rewriting indicators. Menus now rebuild on install, browser startup, and library edits. Indicator restoration runs once per browser session; worker suspension resumes without a browser-wide scan.
- **Unnecessary scripts and observers:** The old global injector and forced restoration injected scripts into unstarred sites. The global registration is removed on upgrade, and only starred pages get the indicator script. Its observer watches the title and title replacement, rather than the entire head subtree, and disconnects when unstarred.
- **Title updates messaging the worker:** Routine title changes sent messages and rewrote ownership data. The page now maintains its star locally, and the original title is captured when needed. Saved titles and restart ownership remain correct.
- **Busy unstarred pages keeping the worker awake:** The tab-update listener is removed when no live star policy or pending restoration needs it, and restored when stars are enabled. Chrome can then suspend the worker despite unrelated page title changes.
- **Hidden popup rows consuming native DOM memory:** Collapsed groups no longer construct their member rows. Expansion or a drag preview mounts them on demand; leaving a preview releases them. Favicon images load lazily.
- **Repeated marker writes and retained copies:** Marker ownership uses a small worker-local cache and skips unchanged writes. Persistent stars retain one record graph and a serialized comparison signature rather than two object graphs.
- **Queues retaining completed action results:** Promise queues now retain only completion, rather than a successful action's return value. A finished library read can be collected after its response is sent instead of staying attached to the serialization queue.

The installed extension has no polling loop, background keepalive, offscreen document, framework, or third-party dependency. The polling in development preview and audit scripts is not loaded by the installed extension. Short timeouts used for page creation and bounded title fetching clean up their listeners or readers.

## Remaining costs

Stored links occupy disk and are loaded while the popup is open or a saved-library action runs. Large expanded lists still require their displayed rows; collapsed groups keep those rows out of memory. Persistent star records and title ownership occupy a small amount of memory while the worker runs and are released when Brave suspends it. A loaded starred page has one small title observer. Busy starred pages can keep the worker running through native tab-update events, as the measured 20.56 MiB case shows.

Saving a copy keeps source websites loaded. Moving tabs closes them; starring inactive tabs discards them; restored links remain unloaded placeholders until selection. These actions reduce page memory, but active websites, Brave's own processes, and an open popup retain their normal memory costs.

## Validation

All 107 unit tests pass, including settings migration, stale-read protection, observer disconnects, unchanged-write suppression, queue recovery, and persistent stars. JavaScript syntax and manifest checks pass. Real Brave checks passed for two restarts, individual and group stars, dynamic webpage title indicators with localhost access, native discarded-tab reload, group inheritance, saved original titles, drag previews, and five-tab group capture. The reload check also exposed a Brave case where a selected discarded tab stayed unloaded; the activation handler now reloads that selected page explicitly while leaving inactive and already loaded tabs alone.
