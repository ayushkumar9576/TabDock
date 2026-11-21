import test from "node:test";
import assert from "node:assert/strict";
import { request } from "../shared/client.js";

test("drag metadata cannot overwrite the intended worker message type", async () => {
  let message;
  globalThis.chrome = { runtime: { sendMessage: async payload => { message = payload; return { ok: true, data: null }; } } };
  await request("MOVE_LINK", { type: "link", sourceId: "a", targetId: "b", linkId: "c" });
  assert.equal(message.type, "MOVE_LINK"); assert.equal(message.linkId, "c");
});
