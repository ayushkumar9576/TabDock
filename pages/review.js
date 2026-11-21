import { request } from "../shared/client.js";
import { conflictFields } from "../popup/dom.js";
import { icon } from "../shared/icons.js";
for (const node of document.querySelectorAll("[data-icon]")) node.append(icon(node.dataset.icon));
const $ = selector => document.querySelector(selector);
const planId = new URLSearchParams(location.search).get("plan");
let choices = {};
let undo;
let timer;
try {
  const { plan, groups } = await request("GET_PLAN", { planId });
  const fields = conflictFields(plan, groups);
  choices = fields.choices;
  $("#choices").append(fields.container);
  $("#warnings").textContent = plan.warnings.join(" ");
} catch (error) { $("#status").textContent = error.message; $("#confirm").disabled = true; }

$("#review-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#confirm").disabled = true;
  $("#cancel").disabled = true;
  try {
    const result = await request("COMMIT_MOVE", { planId, choices });
    $("#review-form").hidden = true;
    $("#heading").textContent = "Your tabs are parked";
    $("#description").textContent = "Open TabDock from the toolbar to find your saved links.";
    $("#status").textContent = result.message + " " + result.warnings.join(" ");
    undo = result.undo;
    $("#undo").hidden = false;
    timer = setTimeout(() => { $("#undo").hidden = true; }, Math.max(0, undo.expiresAt - Date.now()));
  } catch (error) { $("#status").textContent = error.message; $("#confirm").disabled = false; $("#cancel").disabled = false; }
});
$("#cancel").addEventListener("click", async () => { await request("CANCEL_MOVE", { planId }); window.close(); });
$("#undo").addEventListener("click", async () => {
  $("#undo").disabled = true;
  try {
    const result = await request("UNDO_MOVE", { undoId: undo.id });
    $("#status").textContent = result.message + " " + result.warnings.join(" ");
    $("#undo").hidden = true; clearTimeout(timer);
  } catch (error) { $("#status").textContent = error.message; $("#undo").disabled = false; }
});
