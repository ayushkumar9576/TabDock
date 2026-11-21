// The preview runs the real popup with a browser mock; the extension uses Chrome's APIs.
if (location.protocol !== "chrome-extension:") await import("../preview/mock-browser.js");
await import("./popup.js");
