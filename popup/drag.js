// Pointer dragging keeps a live insertion gap, animates surrounding cards, and
// commits once on release. No native drag image or visible grip is needed.
export function installDragging({ workspace, list, onDrop, onCancel, onStart, onGroupPreview }) {
  let pending, drag, frame;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const visible = node => node && !node.classList.contains("drag-origin");
  const cards = () => [...list.querySelectorAll(".tab-card, .tab-group")].filter(visible);

  function animateChange(change) {
    const rects = new Map(cards().map(node => [node, node.getBoundingClientRect()]));
    change();
    if (reducedMotion) return;
    for (const [node, before] of rects) {
      const after = node.getBoundingClientRect();
      const x = before.left - after.left, y = before.top - after.top;
      if (!x && !y) continue;
      node.getAnimations().forEach(animation => animation.cancel());
      node.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }], { duration: 190, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }

  function start(event) {
    const { source, handle, x, y } = pending;
    const rect = source.getBoundingClientRect();
    const sourceStyle = getComputedStyle(source);
    const placeholder = document.createElement("div");
    placeholder.className = "drop-placeholder";
    placeholder.style.height = `${rect.height}px`;
    placeholder.style.background = sourceStyle.background;
    placeholder.style.border = sourceStyle.border;
    placeholder.style.borderRadius = sourceStyle.borderRadius;
    placeholder.setAttribute("aria-hidden", "true");
    const ghost = document.createElement("div");
    ghost.className = "drag-card"; ghost.style.width = `${rect.width}px`;
    const copy = source.cloneNode(true);
    const originals = [source, ...source.querySelectorAll("*")];
    const copies = [copy, ...copy.querySelectorAll("*")];
    for (const [index, node] of copies.entries()) {
      // Moving the clone outside its group loses ancestor-based CSS rules.
      // Snapshot the actual card styles, including the user's grouped-tab border.
      const computed = getComputedStyle(originals[index]);
      for (const property of ["background", "border", "border-radius", "color", "font", "letter-spacing", "padding", "gap", "width", "height", "flex-basis", "flex-shrink"]) {
        node.style.setProperty(property, computed.getPropertyValue(property));
      }
      node.removeAttribute("id"); node.removeAttribute("tabindex");
      for (const attribute of [...node.attributes]) if (attribute.name.startsWith("data-")) node.removeAttribute(attribute.name);
    }
    ghost.append(copy); ghost.setAttribute("aria-hidden", "true"); document.body.append(ghost);
    source.before(placeholder); source.classList.add("drag-origin"); document.body.classList.add("is-dragging");
    const groupStates = new Map([...list.querySelectorAll(".tab-group")].map(group => {
      const links = group.querySelector(".group-links"), toggle = group.querySelector(".group-collapse");
      return [group, { links, hidden: links.hidden, toggle, expanded: toggle?.getAttribute("aria-expanded"), title: toggle?.title, label: toggle?.getAttribute("aria-label") }];
    }));
    drag = {
      source, placeholder, ghost, groupStates, previewGroup: null, height: rect.height, offsetX: x - rect.left, offsetY: y - rect.top, x: event.clientX, y: event.clientY, pointerId: event.pointerId,
      kind: handle.dataset.dragKind, sourceId: handle.dataset.sourceId, linkId: handle.dataset.linkId
    };
    workspace.setPointerCapture(event.pointerId); pending = null; onStart?.();
    update(event.clientX, event.clientY); frame = requestAnimationFrame(autoScroll);
  }

  function previewGroup(current, target = null) {
    for (const [group, original] of current.groupStates) {
      const previewing = group === target;
      if (original.hidden && previewing !== (group === current.previewGroup)) onGroupPreview?.(group, previewing);
      group.classList.toggle("drop-target", previewing);
      original.links.hidden = previewing ? false : original.hidden;
      if (original.toggle) {
        original.toggle.setAttribute("aria-expanded", previewing ? "true" : original.expanded);
        original.toggle.title = previewing ? original.title.replace(/^Expand /, "Collapse ") : original.title;
        original.toggle.setAttribute("aria-label", previewing ? original.label.replace(/^Expand /, "Collapse ") : original.label);
      }
    }
    current.previewGroup = target;
  }

  function placement(x, y) {
    let parent = list;
    if (drag.kind === "tab") {
      for (const group of list.querySelectorAll(".tab-group")) {
        if (!visible(group)) continue;
        const rect = group.getBoundingClientRect();
        // The outer gutter and the group's top/bottom edge place a tab outside.
        if (x > rect.left + 13 && x < rect.right - 7 && y > rect.top + 12 && y < rect.bottom - 9) {
          parent = group.querySelector(".group-links"); break;
        }
      }
    }
    const target = parent === list ? null : parent.closest(".tab-group");
    const insertionPoint = () => [...parent.children].filter(node => node !== drag.placeholder && visible(node) && node.matches(".tab-card, .tab-group"))
      .find(node => { const rect = node.getBoundingClientRect(); return y < rect.top + rect.height / 2; });
    if (drag.previewGroup === target && drag.placeholder.parentElement === parent && drag.placeholder.nextElementSibling === (insertionPoint() || null)) return;
    animateChange(() => {
      previewGroup(drag, target);
      drag.placeholder.style.height = `${parent === list ? drag.kind === "tab" ? 92 : drag.height : 77}px`;
      // Expand the preview before measuring the cards' insertion positions.
      parent.insertBefore(drag.placeholder, insertionPoint() || null);
    });
  }

  function update(x, y) {
    drag.x = x; drag.y = y;
    drag.ghost.style.transform = `translate(${x - drag.offsetX}px, ${y - drag.offsetY}px)`;
    placement(x, y);
  }

  function autoScroll() {
    if (!drag) return;
    const rect = workspace.getBoundingClientRect(), top = drag.y - rect.top, bottom = rect.bottom - drag.y;
    const speed = top < 44 ? -Math.min(13, (44 - top) / 4) : bottom < 44 ? Math.min(13, (44 - bottom) / 4) : 0;
    if (speed) { workspace.scrollTop += speed; placement(drag.x, drag.y); }
    frame = requestAnimationFrame(autoScroll);
  }

  function finish(cancel = false) {
    pending = null;
    if (!drag) return;
    cancelAnimationFrame(frame);
    const current = drag, parent = current.placeholder.parentElement;
    const next = [...parent.children].slice([...parent.children].indexOf(current.placeholder) + 1).find(node => node !== current.source && visible(node) && node.matches(".tab-card, .tab-group"));
    const payload = {
      kind: current.kind, sourceId: current.sourceId, linkId: current.linkId,
      targetId: parent.classList.contains("group-links") ? parent.closest(".tab-group").dataset.entryId : null,
      beforeId: parent === list ? next?.dataset.entryId || null : next?.dataset.linkId || null
    };
    drag = null;
    if (workspace.hasPointerCapture(current.pointerId)) workspace.releasePointerCapture(current.pointerId);
    document.body.classList.remove("is-dragging"); current.source.classList.remove("drag-origin");
    if (cancel) { current.placeholder.remove(); current.ghost.remove(); previewGroup(current); onCancel(); return; }
    current.placeholder.replaceWith(current.source);
    previewGroup(current);
    const landing = current.source.offsetParent === null ? parent.closest(".tab-group")?.querySelector(".group-header") : current.source;
    const rect = (landing || current.source).getBoundingClientRect();
    if (!reducedMotion) {
      const animation = current.ghost.animate([{ transform: current.ghost.style.transform }, { transform: `translate(${rect.left}px, ${rect.top}px)`, opacity: 0 }], { duration: 140, easing: "ease-out", fill: "forwards" });
      animation.finished.finally(() => current.ghost.remove());
    } else current.ghost.remove();
    onDrop(payload);
  }

  workspace.addEventListener("pointerdown", event => {
    if (event.button !== 0 || document.body.hasAttribute("aria-busy") || event.target.closest("input, button")) return;
    const handle = event.target.closest("[data-drag-kind]");
    if (!handle) return;
    const source = handle.dataset.dragKind === "group" ? handle.closest(".tab-group") : handle;
    pending = { source, handle, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  });
  workspace.addEventListener("pointermove", event => {
    if (pending && event.pointerId === pending.pointerId && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 6) start(event);
    if (drag && event.pointerId === drag.pointerId) { event.preventDefault(); update(event.clientX, event.clientY); }
  });
  document.addEventListener("pointerup", event => { if (!drag || event.pointerId === drag.pointerId) finish(); });
  document.addEventListener("pointercancel", () => finish(true));
  document.addEventListener("keydown", event => { if (event.key === "Escape" && (drag || pending)) { event.preventDefault(); finish(true); } });
  window.addEventListener("blur", () => finish(true));
}
