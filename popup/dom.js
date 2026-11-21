import { icon } from "../shared/icons.js";

export function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function button(text, title, handler, className = "") {
  const node = el("button", className, text);
  node.type = "button";
  node.title = title;
  node.setAttribute("aria-label", title);
  node.addEventListener("click", handler);
  return node;
}

export function option(value, text) {
  const node = el("option", "", text);
  node.value = value;
  return node;
}

export function iconButton(name, text, title, handler, className = "", focusKey = "") {
  const node = button("", title, handler, className);
  node.append(icon(name));
  if (text) node.append(el("span", "", text));
  if (focusKey) node.dataset.focusKey = focusKey;
  return node;
}

export function field(label, input) {
  const node = el("label", "field", label);
  node.append(input);
  return node;
}

export function conflictFields(plan, savedGroups) {
  const container = el("div");
  const choices = {};
  for (const incoming of plan.groups.filter(group => group.conflicts.length)) {
    const card = el("div", "conflict");
    card.append(el("div", "", `“${incoming.name}” already exists (${incoming.tabs.length} tabs incoming).`));
    const select = el("select");
    select.setAttribute("aria-label", `How to save ${incoming.name}`);
    select.append(option("new", "Create a separate group with the same name"));
    for (const groupId of incoming.conflicts) {
      const target = savedGroups.find(group => group.id === groupId);
      select.append(option(groupId, `Merge into ${target?.name || incoming.name} (${target?.links.length || 0} links)`));
    }
    choices[incoming.key] = { mode: "new" };
    select.addEventListener("change", () => {
      choices[incoming.key] = select.value === "new" ? { mode: "new" } : { mode: "merge", groupId: select.value };
    });
    card.append(select, el("p", "", "A merge keeps the existing group’s color and collapsed setting and appends incoming tabs in order."));
    container.append(card);
  }
  return { container, choices };
}
