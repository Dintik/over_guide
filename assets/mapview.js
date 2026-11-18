'use strict';

// A map picture in an <svg> with markers that keep their size on screen: drag, wheel and pinch zoom,
// +/−/⤢ buttons. Items carry `at` in percent of the picture; `draw(g, item)` fills each marker.
function createMapView(svg, { onPick = () => {}, onHover = () => {}, buttons = null } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 1000;
  let full = { x: 0, y: 0, w: W, h: W }, view = { ...full }, fitBox = null, markers = [];

  const el = (tag, attrs = {}, parent) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  };
  const point = item => [item.at[0] / 100 * W, item.at[1] / 100 * full.h];

  function set({ image, ratio, label = '', items, draw }) {
    svg.innerHTML = '';
    svg.setAttribute('aria-label', label);
    svg.style.aspectRatio = `1 / ${ratio}`;
    full = { x: 0, y: 0, w: W, h: W * ratio };
    view = { ...full };
    el('image', { href: image, x: 0, y: 0, width: full.w, height: full.h, preserveAspectRatio: 'none' }, svg);
    const layer = el('g', {}, svg);
    markers = items.map(item => {
      const g = el('g', { class: 'mk' }, layer);
      g._item = item;
      draw(g, item);
      return g;
    });
    fit();
  }

  // Redraws one marker in place (its item changed).
  function redraw(g, draw) {
    g.textContent = '';
    for (const a of [...g.attributes]) if (a.name !== 'transform') g.removeAttribute(a.name);
    g.setAttribute('class', 'mk');
    draw(g, g._item);
  }

  function update() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    const box = svg.getBoundingClientRect();
    const small = box.width && box.width < 600 ? 0.75 : 1;
    const unit = (box.width ? Math.max(view.w / box.width, view.h / box.height) : 1) * small;
    for (const g of markers) {
      const [x, y] = point(g._item);
      g.setAttribute('transform', `translate(${x} ${y}) scale(${unit})`);
    }
  }

  // The view stays inside the picture: no zooming out past the whole map, no dragging into the dark.
  function clamp(v) {
    const f = full, fb = fitBox || f;
    const w = Math.min(Math.max(v.w, f.w / 10), fb.w);
    const h = w * (fb.h / fb.w);
    const axis = (pos, size, start, total) => size >= total ? start + (total - size) / 2 : Math.min(Math.max(pos, start), start + total - size);
    return { x: axis(v.x, w, f.x, f.w), y: axis(v.y, h, f.y, f.h), w, h };
  }

  function fit() {
    const box = svg.getBoundingClientRect();
    const ratio = box.width && box.height ? box.height / box.width : full.h / full.w;
    let w = full.w, h = full.w * ratio;
    if (h < full.h) { h = full.h; w = h / ratio; }
    view = { x: (full.w - w) / 2, y: (full.h - h) / 2, w, h };
    fitBox = { ...view };
    update();
  }

  function zoomAt(factor, cx, cy) {
    view = clamp({ x: cx - (cx - view.x) * factor, y: cy - (cy - view.y) * factor, w: view.w * factor, h: view.h * factor });
    update();
  }

  // Brings an item into view without changing the zoom (only when it is off the visible part).
  function reveal(item) {
    const [x, y] = point(item), mx = view.w * 0.08, my = view.h * 0.08;
    if (x > view.x + mx && x < view.x + view.w - mx && y > view.y + my && y < view.y + view.h - my) return;
    view = clamp({ ...view, x: x - view.w / 2, y: y - view.h / 2 });
    update();
  }

  const toMap = (cx, cy) => {
    const box = svg.getBoundingClientRect();
    return [view.x + (cx - box.left) / box.width * view.w, view.y + (cy - box.top) / box.height * view.h];
  };
  const markerAt = e => document.elementFromPoint(e.clientX, e.clientY)?.closest('.mk');

  const pointers = new Map();
  let drag = null, pinch = null, moved = false;
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAt(Math.exp(e.deltaY * 0.0015), ...toMap(e.clientX, e.clientY));
  }, { passive: false });
  svg.addEventListener('pointerdown', e => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    moved = false;
    if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, view: { ...view } };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), view: { ...view }, mid: toMap((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) };
      drag = null;
    }
  });
  svg.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) {
      const m = markerAt(e);
      onHover(m ? m._item : null, e);
      return;
    }
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    const box = svg.getBoundingClientRect();
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      view = pinch.view;
      zoomAt(pinch.dist / Math.max(20, Math.hypot(a[0] - b[0], a[1] - b[1])), ...pinch.mid);
      moved = true;
    } else if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      svg.classList.add('drag');
      const v = drag.view;
      view = clamp({ ...v, x: v.x - dx / box.width * v.w, y: v.y - dy / box.height * v.h });
      update();
      onHover(null, e);
    }
  });
  svg.addEventListener('pointerup', e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      svg.classList.remove('drag');
      if (!moved) {
        const m = markerAt(e);
        if (m) onPick(m._item, e);
      }
      drag = null;
    }
  });
  svg.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); drag = pinch = null; svg.classList.remove('drag'); });
  svg.addEventListener('pointerleave', e => onHover(null, e));
  window.addEventListener('resize', () => markers.length && fit());

  (buttons ? buttons.querySelectorAll('[data-zoom]') : []).forEach(b => b.addEventListener('click', () => {
    const c = [view.x + view.w / 2, view.y + view.h / 2];
    if (b.dataset.zoom === 'in') zoomAt(0.7, ...c);
    else if (b.dataset.zoom === 'out') zoomAt(1 / 0.7, ...c);
    else fit();
  }));

  return { set, fit, reveal, redraw, el, markers: () => markers };
}
