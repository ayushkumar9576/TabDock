import { request, faviconUrl } from "../shared/client.js";
import { COLORS, sortGroups } from "../shared/model.js";
import { el, button } from "./dom.js";
import { icon } from "../shared/icons.js";
import { installDragging } from "./drag.js";

const $ = selector => document.querySelector(selector);
let state = { groups: [], undo: [] };
let windowId, undoId, toastTimer, menuOrigin, renameId;
let busy = false, dragging = false, needsRefresh = false;

function notify(message, record = null) {
  clearTimeout(toastTimer);
  $("#toast-text").textContent = message; $("#toast").hidden = false;
  undoId = record?.id; $("#undo").hidden = !record || record.expiresAt <= Date.now();
  toastTimer = setTimeout(() => { $("#toast").hidden = true; undoId = null; }, record ? Math.max(0, record.expiresAt - Date.now()) : 6000);
}

async function run(task) {
  if (busy) return;
  busy = true; document.body.setAttribute("aria-busy", "true");
  try { return await task(); }
  catch (error) { notify(error.message); await refreshState().catch(() => { }); }
  finally { busy = false; document.body.removeAttribute("aria-busy"); }
}

function thumbnailUrl(value) {
  const url = new URL(value), host = url.hostname.replace(/^www\./, "");
  let videoId;
  if (host === "youtu.be") videoId = url.pathname.split("/")[1];
  if (["youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) videoId = url.searchParams.get("v") || (/^\/(shorts|embed|live)\//.test(url.pathname) ? url.pathname.split("/")[2] : null);
  return /^[\w-]{11}$/.test(videoId || "") ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : null;
}

function preview(link) {
  const node = el("div", "tab-preview"); node.setAttribute("aria-hidden", "true");
  const host = new URL(link.url).hostname.replace(/^www\./, "");
  const colors = ["#edf0e9", "#e8edf0", "#efe8df", "#eee9ed"];
  const hash = [...host].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  node.style.setProperty("--preview-bg", colors[hash % colors.length]);
  const fallback = () => {
    const favicon = el("img", "preview-favicon"); favicon.alt = ""; favicon.draggable = false; favicon.loading = "lazy"; favicon.src = faviconUrl(link.url, 32);
    favicon.addEventListener("error", () => favicon.replaceWith(el("span", "preview-letter", host[0]?.toUpperCase() || "T")), { once: true });
    node.replaceChildren(favicon);
  };
  const url = thumbnailUrl(link.url);
  if (url) {
    node.classList.add("video-preview");
    const image = el("img", "thumbnail");
    image.alt = ""; image.draggable = false; image.loading = "lazy"; image.referrerPolicy = "no-referrer"; image.src = url;
    image.addEventListener("error", fallback, { once: true }); node.append(image);
  } else fallback();
  return node;
}

function hideMenu(restoreFocus = false) { $("#context-menu").hidden = true; if (restoreFocus) menuOrigin?.focus({ preventScroll: true }); }
async function openTab(group, link) {
  const result = await request("OPEN_LINK", { groupId: group.id, linkId: link.id, windowId });
  if (result.warnings?.length) notify(result.warnings.join(" "));
}
function toggleGroup(group) {
  return run(async () => {
    await request("UPDATE_GROUP", { groupId: group.id, collapsed: !group.collapsed });
    await refreshState();
  });
}

function showMenu(event, group, link = null) {
  event.preventDefault(); event.stopPropagation();
  if (busy || dragging) return;
  hideMenu(); menuOrigin = link ? event.currentTarget : event.currentTarget.querySelector(".group-header") || event.currentTarget;
  const menu = $("#context-menu"); menu.setAttribute("aria-label", link ? `Actions for ${link.title}` : `Actions for ${group.name}`);
  const actions = [];
  if (link) {
    const add = button("", "Add to group", () => {
      hideMenu();
      run(async () => {
        const names = new Set(state.groups.filter(item => !item.ungrouped).map(item => item.name));
        let name = "New group", n = 2;
        while (names.has(name)) name = `New group ${n++}`;
        await request("GROUP_LINK", { sourceId: group.id, linkId: link.id, name });
        state = await request("GET_STATE");
        renameId = state.groups.find(item => !item.ungrouped && item.name === name && item.links.some(item => item.id === link.id))?.id;
        render();
      });
    }, "menu-item");
    add.append(icon("folder"), el("span", "", "Add to group")); actions.push(add);
  }
  const open = button("", "Open", () => {
    hideMenu();
    run(async () => {
      if (link) await openTab(group, link);
      else { const result = await request("OPEN_GROUP", { groupId: group.id, windowId }); if (result.warnings?.length) notify(result.warnings.join(" ")); }
    });
  }, "menu-item");
  open.append(icon("external-link"), el("span", "", "Open")); open.disabled = !link && !group.links.length; actions.push(open);
  if (!link) {
    const rename = button("", `Rename ${group.name}`, () => {
      const header = menuOrigin.closest(".group-header") || menuOrigin.querySelector(".group-header");
      hideMenu();
      if (header) renameGroup(header, group);
    }, "menu-item");
    rename.append(icon("pencil"), el("span", "", "Rename group")); actions.push(rename);
    const remove = button("", `Delete ${group.name} and its saved tabs`, () => {
      hideMenu();
      run(async () => { await request("DELETE_GROUP", { groupId: group.id }); await refreshState(); $("#workspace").focus({ preventScroll: true }); });
    }, "menu-item menu-danger");
    remove.append(icon("trash-2"), el("span", "", "Delete group")); actions.push(remove);
  }
  actions.forEach(node => node.setAttribute("role", "menuitem")); menu.replaceChildren(...actions); menu.hidden = false;
  const origin = menuOrigin.getBoundingClientRect(), x = event.clientX || origin.left + 20, y = event.clientY || origin.top + 25;
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
  actions[0]?.focus({ preventScroll: true });
}

function contextKeys(event, group, link) { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) showMenu(event, group, link); }

function renderTab(group, link) {
  const row = el("article", "tab-card"); row.tabIndex = 0; row.setAttribute("role", "listitem");
  row.setAttribute("aria-label", `${link.title}, ${new URL(link.url).hostname}. Right-click for actions. Hold and drag to move.`);
  row.title = `${link.title}\n${link.url}`;
  row.dataset.dragKind = "tab"; row.dataset.sourceId = group.id; row.dataset.linkId = link.id; row.dataset.focusKey = link.id;
  if (group.ungrouped) row.dataset.entryId = group.id;
  const copy = el("div", "tab-copy"); copy.append(el("h2", "tab-title", link.title));
  const domain = el("div", "tab-domain"); if (link.pinned) domain.append(icon("pin"));
  domain.append(el("span", "", new URL(link.url).hostname.replace(/^www\./, ""))); copy.append(domain); row.append(preview(link), copy);
  const remove = button("", `Remove ${link.title} from saved tabs`, event => {
    event.stopPropagation(); hideMenu();
    run(async () => {
      const rows = [...document.querySelectorAll(".tab-card")].filter(node => node.offsetParent !== null);
      const index = rows.indexOf(row);
      const focusKey = (rows[index + 1] || rows[index - 1])?.dataset.focusKey || group.id;
      await request("DELETE_LINK", { groupId: group.id, linkId: link.id });
      await refreshState();
      [...document.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
    });
  }, "tab-remove");
  remove.dataset.focusKey = `remove:${link.id}`;
  remove.append(icon("x"));
  remove.addEventListener("keydown", event => event.stopPropagation());
  row.append(remove);
  row.addEventListener("contextmenu", event => showMenu(event, group, link));
  row.addEventListener("keydown", event => {
    contextKeys(event, group, link);
    if (event.key === "Enter" && !event.ctrlKey && !event.altKey) { event.preventDefault(); run(() => openTab(group, link)); }
    if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); keyboardMove(group, link, event.key === "ArrowUp" ? -1 : 1); }
    if (event.altKey && event.key === "ArrowLeft" && !group.ungrouped) { event.preventDefault(); run(async () => { await request("UNGROUP_LINK", { sourceId: group.id, linkId: link.id, beforeId: group.id }); await refreshState(); }); }
  });
  return row;
}

function renameGroup(header, group) {
  if (busy || header.querySelector("input")) return;
  renameId = group.id;
  hideMenu();
  const input = el("input", "group-name-input"); input.value = group.name; input.maxLength = 120; input.setAttribute("aria-label", "Group name");
  header.querySelector(".group-name").replaceWith(input);
  let done = false;
  const finish = save => {
    if (done) return;
    done = true; renameId = null; needsRefresh = false;
    const name = input.value.trim();
    if (save && name && name !== group.name) run(async () => { await request("UPDATE_GROUP", { groupId: group.id, name }); await refreshState(); });
    else render();
  };
  input.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Enter") { event.preventDefault(); finish(true); }
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true)); input.focus({ preventScroll: true }); input.select();
}

function renderGroup(group) {
  const card = el("section", "tab-group"); card.dataset.entryId = group.id; card.setAttribute("role", "listitem");
  card.setAttribute("aria-label", `${group.name}, ${group.links.length} tabs`);
  card.style.setProperty("--group-color", COLORS[group.color] || "#70897a");
  const header = el("div", "group-header"); header.tabIndex = 0;
  header.dataset.dragKind = "group"; header.dataset.sourceId = group.id; header.dataset.focusKey = group.id;
  header.setAttribute("role", "group"); header.setAttribute("aria-label", `${group.name}. Double-click or press F2 to rename. Right-click for actions. Hold and drag to move.`);
  header.append(el("span", "group-dot"), el("span", "group-name", group.name), el("span", "group-size", String(group.links.length)));
  const toggle = button("", `${group.collapsed ? "Expand" : "Collapse"} ${group.name}`, event => { event.stopPropagation(); toggleGroup(group); }, "group-collapse");
  toggle.dataset.focusKey = `collapse:${group.id}`;
  toggle.setAttribute("aria-expanded", String(!group.collapsed));
  toggle.setAttribute("aria-controls", `group-${group.id}`);
  toggle.append(icon("chevron-right"));
  toggle.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) event.stopPropagation(); });
  header.append(toggle);
  header.addEventListener("dblclick", event => { if (!event.target.closest("button,input")) renameGroup(header, group); });
  header.addEventListener("keydown", event => {
    contextKeys(event, group);
    if (event.key === "F2") { event.preventDefault(); renameGroup(header, group); }
    if (["Enter", " "].includes(event.key)) { event.preventDefault(); toggleGroup(group); }
    if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); keyboardMove(group, null, event.key === "ArrowUp" ? -1 : 1); }
  });
  const links = el("div", "group-links"); links.id = `group-${group.id}`; links.hidden = Boolean(group.collapsed);
  links.dataset.lazy = String(Boolean(group.collapsed));
  links.setAttribute("role", "list"); links.setAttribute("aria-label", `${group.name} tabs`);
  if (!group.collapsed) links.append(...group.links.map(link => renderTab(group, link)));
  if (!group.links.length) links.append(el("div", "group-empty", "Drop a tab here"));
  card.append(header, links); card.addEventListener("contextmenu", event => showMenu(event, group)); return card;
}

function render() {
  if (dragging) { needsRefresh = true; return; }
  hideMenu();
  const focusKey = document.activeElement?.dataset.focusKey, groups = sortGroups(state.groups);
  const nodes = groups.flatMap(group => group.ungrouped ? group.links.map(link => renderTab(group, link)) : [renderGroup(group)]);
  $("#tabs").replaceChildren(...nodes); $("#empty").hidden = nodes.length > 0; document.body.dataset.ready = "true";
  $("#remove-after-open").checked = state.settings?.removeAfterOpen === true;
  $("#include-new-tabs").checked = state.settings?.includeNewTabs !== false;
  $("#star-all-tabs").checked = state.settings?.starAllTabs === true;
  if (focusKey) [...document.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  if (renameId) {
    const group = groups.find(item => item.id === renameId), header = [...document.querySelectorAll(".group-header")].find(node => node.dataset.sourceId === renameId);
    if (group && header) requestAnimationFrame(() => renameGroup(header, group));
  }
}
async function refreshState() { state = await request("GET_STATE"); render(); }

function keyboardMove(group, link, direction) {
  run(async () => {
    if (link && !group.ungrouped) {
      const index = group.links.findIndex(item => item.id === link.id);
      if (index + direction < 0 || index + direction >= group.links.length) return;
      const beforeId = direction < 0 ? group.links[index - 1].id : group.links[index + 2]?.id || null;
      await request("MOVE_LINK", { sourceId: group.id, linkId: link.id, targetId: group.id, beforeId });
    } else {
      const groups = sortGroups(state.groups), index = groups.findIndex(item => item.id === group.id);
      if (index + direction < 0 || index + direction >= groups.length) return;
      const beforeId = direction < 0 ? groups[index - 1].id : groups[index + 2]?.id || null;
      await request("MOVE_ENTRY", { groupId: group.id, beforeId });
    }
    await refreshState();
  });
}

installDragging({
  workspace: $("#workspace"), list: $("#tabs"),
  onStart() { dragging = true; hideMenu(); },
  onGroupPreview(card, expanded) {
    const links = card.querySelector(".group-links");
    if (links.dataset.lazy !== "true") return;
    const group = state.groups.find(group => group.id === card.dataset.entryId);
    links.replaceChildren(...(expanded && group ? group.links.map(link => renderTab(group, link)) : []));
    if (expanded && !group?.links.length) links.append(el("div", "group-empty", "Drop a tab here"));
  },
  onCancel() { dragging = false; render(); if (needsRefresh) { needsRefresh = false; run(refreshState); } },
  onDrop(payload) {
    dragging = false; needsRefresh = false;
    run(async () => {
      if (payload.kind === "group") await request("MOVE_ENTRY", { groupId: payload.sourceId, beforeId: payload.beforeId });
      else if (payload.targetId) await request("MOVE_LINK", { sourceId: payload.sourceId, linkId: payload.linkId, targetId: payload.targetId, beforeId: payload.beforeId });
      else await request("UNGROUP_LINK", { sourceId: payload.sourceId, linkId: payload.linkId, beforeId: payload.beforeId });
      await refreshState();
    });
  },
});

$("#context-menu").addEventListener("keydown", event => {
  const items = [...event.currentTarget.querySelectorAll("button:not(:disabled)")], index = items.indexOf(document.activeElement);
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
  if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); hideMenu(true); }
});
document.addEventListener("pointerdown", event => { if (!event.target.closest("#context-menu")) hideMenu(); });
$("#workspace").addEventListener("scroll", () => hideMenu(), { passive: true });
document.addEventListener("keydown", event => { if (event.key === "Escape") hideMenu(true); });
window.addEventListener("blur", () => hideMenu());
$("#toast-close").addEventListener("click", () => { clearTimeout(toastTimer); $("#toast").hidden = true; });
$("#settings-toggle").addEventListener("click", () => { hideMenu(); $("#settings-dialog").showModal(); });
$("#settings-close").addEventListener("click", () => $("#settings-dialog").close());
$("#settings-dialog").addEventListener("click", event => {
  const dialog = event.currentTarget, rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
});
function changeSetting(key, event) {
  const input = event.currentTarget;
  if (busy) { render(); return; }
  const checked = input.checked;
  // Request title-indicator access directly from the checkbox gesture.
  const access = key === "starAllTabs" && checked && chrome.permissions?.request
    ? chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] }) : Promise.resolve(true);
  run(async () => {
    input.disabled = true;
    try {
      const granted = await access;
      const result = await request("UPDATE_SETTINGS", { [key]: checked });
      await refreshState();
      const warnings = result?.warnings || [];
      if (!granted) warnings.push("Allow optional website access to show ★ on loaded webpage tabs. Automatic discarding is enabled.");
      if (warnings.length) notify(warnings.join(" "));
    }
    finally { input.disabled = false; }
  });
}
$("#star-all-tabs").addEventListener("change", event => changeSetting("starAllTabs", event));
$("#remove-after-open").addEventListener("change", event => changeSetting("removeAfterOpen", event));
$("#include-new-tabs").addEventListener("change", event => changeSetting("includeNewTabs", event));
$("#undo").addEventListener("click", () => run(async () => {
  if (!undoId) return;
  const result = await request("UNDO_MOVE", { undoId });
  await refreshState(); notify(result.message + (result.warnings.length ? ` ${result.warnings.join(" ")}` : ""));
}));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.tabHarbor) return;
  if (dragging || renameId) { needsRefresh = true; return; }
  refreshState().catch(error => notify(error.message));
});
run(async () => {
  windowId = (await request("GET_BROWSER")).windowId; await refreshState();
  const notice = await request("GET_NOTICE"), undo = state.undo.filter(record => record.expiresAt > Date.now()).at(-1);
  if (notice || undo) notify(notice || undo.message, undo);
});
