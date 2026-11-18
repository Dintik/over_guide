'use strict';

const $ = id => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAP_W = 1000;   // the map picture in SVG units; locations come in percent of it

const EFFECTS = {
  stuns: 'Оглушение', slows: 'Замедление', wolf: 'Превращение в волка', panic: 'Паника',
  blind: 'Ослепление', beguile: 'Очарование', knockbacks: 'Отбрасывание',
  ranged: 'Атаки издалека',
};
// A location's place among all of the map's (rank 0 = the weakest, 1 = the strongest).
const rankColor = rank => `hsl(${Math.round(120 - 120 * rank)}, 68%, ${Math.round(50 - 5 * rank)}%)`;
const rankText = rank => rank < 0.25 ? 'Одна из слабых' : rank > 0.75 ? 'Одна из сильных' : 'Средняя';
const LOC_TEXT = {
  weak: 'Слабее большинства локаций региона', strong: 'Сильнее большинства локаций региона',
  equal: 'Как большинство локаций региона', only: 'Единственная локация с боссом в регионе',
};
const ARROW = { weak: '▼', strong: '▲' };

const state = { index: [], maps: {}, map: null, selected: null, view: null, full: null, fx: {} };

const isPhone = () => window.matchMedia('(max-width: 860px)').matches;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

/* ---------- Routing: #<map>/<location> ---------- */

function parseHash() {
  const [mapId, locId] = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/');
  return { mapId: mapId || null, locId: locId || null };
}

async function route() {
  const { mapId, locId } = parseHash();
  renderTabs(mapId);
  const known = state.index.find(m => m.id === mapId);
  document.body.classList.toggle('on-map', Boolean(known));
  $('overview').hidden = Boolean(known);
  $('mapview').hidden = !known;
  if (!known) {
    document.title = 'Справочник по картам Overkings';
    return;
  }
  if (!state.map || state.map.id !== mapId) await openMap(mapId);
  select(locId, { reveal: true });
}

function go(locId) {
  const hash = `#${state.map.id}${locId ? '/' + locId : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

/* ---------- Overview ---------- */

function renderTabs(active) {
  $('tabs').innerHTML = state.index.map(m =>
    `<a href="#${m.id}" class="${m.id === active ? 'on' : ''}">${esc(m.name)}</a>`).join('');
  $('tabs').querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderCards() {
  $('cards').innerHTML = state.index.map((m, i) => `
    <a class="card" href="#${m.id}">
      <img src="maps/${m.id}.jpg" alt="" loading="lazy">
      <div class="body">
        <h3><span class="step">${i + 1}</span>${esc(m.name)}</h3>
        <div class="meta">Локаций с боссами: ${m.locations} · регионов: ${m.regions}</div>
      </div>
    </a>`).join('');
}

/* ---------- Map ---------- */

async function openMap(mapId) {
  if (!state.maps[mapId]) state.maps[mapId] = await getJSON(`data/${mapId}.json`);
  const map = state.maps[mapId];
  state.map = map;
  state.selected = null;
  state.byId = new Map(map.locations.map(l => [l.id, l]));
  document.title = `${map.name} — справочник Overkings`;
  state.full = { x: 0, y: 0, w: MAP_W, h: MAP_W * map.ratio };
  state.view = { ...state.full };
  $('map').style.aspectRatio = `1 / ${map.ratio}`;
  renderRegionSelect();
  drawMap();
  fitView();
  renderList();
  showList();
}

const point = l => [l.at[0] / 100 * MAP_W, l.at[1] / 100 * MAP_W * state.map.ratio];

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function drawMap() {
  const svg = $('map');
  const map = state.map;
  svg.innerHTML = '';
  svg.setAttribute('aria-label', `Карта ${map.name}`);
  el('image', { href: `maps/${map.id}.jpg`, x: 0, y: 0, width: state.full.w, height: state.full.h, preserveAspectRatio: 'none' }, svg);
  state.markers = [];
  const layer = el('g', {}, svg);
  for (const l of map.locations) {
    // Grey: nothing known yet about the location's effects.
    const cls = `mk${l.effects == null ? ' unknown' : ''}${l.mega ? ' mega' : ''}`;
    const g = el('g', { class: cls, 'data-id': l.id }, layer);
    const r = l.mega ? 14 : 11;
    el('circle', { class: 'ring', r: r + 4 }, g);
    el('circle', { class: 'dot', r, fill: rankColor(l.rank) }, g);
    if (l.mega) skull(g);
    else if (ARROW[l.strength]) el('text', {}, g).textContent = ARROW[l.strength];
    g._loc = l;
    state.markers.push(g);
  }
  updateView();
}

// A megaboss's skull, drawn around (0, 0) so it sits in the middle of the marker.
function skull(g) {
  const s = el('g', { class: 'skull' }, g);
  el('path', { d: 'M0 -9.5 C5.8 -9.5 8.5 -5.6 8.5 -1.6 C8.5 1.4 7 3.3 5 4.3 L5 7.5 C5 8.6 4.2 9.3 3.2 9.3 L-3.2 9.3 C-4.2 9.3 -5 8.6 -5 7.5 L-5 4.3 C-7 3.3 -8.5 1.4 -8.5 -1.6 C-8.5 -5.6 -5.8 -9.5 0 -9.5 Z' }, s);
  el('circle', { class: 'eye', cx: -3.4, cy: -1.4, r: 2.4 }, s);
  el('circle', { class: 'eye', cx: 3.4, cy: -1.4, r: 2.4 }, s);
  el('path', { class: 'eye', d: 'M0 2 L1.3 4.4 L-1.3 4.4 Z' }, s);
}

function updateView() {
  const svg = $('map');
  const v = state.view;
  svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
  const box = svg.getBoundingClientRect();
  // Markers keep their size on screen at any zoom.
  const small = box.width && box.width < 600 ? 0.75 : 1;
  const unit = (box.width ? Math.max(v.w / box.width, v.h / box.height) : 1) * small;
  for (const g of state.markers) {
    const [x, y] = point(g._loc);
    g.setAttribute('transform', `translate(${x} ${y}) scale(${unit})`);
  }
}

// The view stays inside the picture: no zooming out past the whole map, no dragging into the dark.
function clampView(v) {
  const f = state.full, fit = state.fit || f;
  const w = Math.min(Math.max(v.w, f.w / 10), fit.w);
  const h = w * (fit.h / fit.w);
  const axis = (pos, size, start, total) => size >= total ? start + (total - size) / 2 : Math.min(Math.max(pos, start), start + total - size);
  return { x: axis(v.x, w, f.x, f.w), y: axis(v.y, h, f.y, f.h), w, h };
}

function fitView() {
  const box = $('map').getBoundingClientRect();
  const f = state.full;
  const ratio = box.width && box.height ? box.height / box.width : f.h / f.w;
  let w = f.w, h = f.w * ratio;
  if (h < f.h) { h = f.h; w = h / ratio; }
  state.view = { x: f.x + (f.w - w) / 2, y: f.y + (f.h - h) / 2, w, h };
  state.fit = { ...state.view };
  updateView();
}

function zoomAt(factor, cx, cy) {
  const v = state.view;
  state.view = clampView({ x: cx - (cx - v.x) * factor, y: cy - (cy - v.y) * factor, w: v.w * factor, h: v.h * factor });
  updateView();
}

function toMap(clientX, clientY) {
  const box = $('map').getBoundingClientRect();
  const v = state.view;
  return [v.x + (clientX - box.left) / box.width * v.w, v.y + (clientY - box.top) / box.height * v.h];
}

// Brings a location into view without changing the zoom (only when it is off the visible part).
function reveal(at) {
  const v = state.view, mx = v.w * 0.08, my = v.h * 0.08;
  if (at[0] > v.x + mx && at[0] < v.x + v.w - mx && at[1] > v.y + my && at[1] < v.y + v.h - my) return;
  state.view = clampView({ ...v, x: at[0] - v.w / 2, y: at[1] - v.h / 2 });
  updateView();
}

function setupMapInput() {
  const svg = $('map');
  const pointers = new Map();
  let drag = null, pinch = null, moved = false;

  svg.addEventListener('wheel', e => {
    if (!state.map) return;
    e.preventDefault();
    zoomAt(Math.exp(e.deltaY * 0.0015), ...toMap(e.clientX, e.clientY));
  }, { passive: false });

  svg.addEventListener('pointerdown', e => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    moved = false;
    if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, view: { ...state.view } };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), view: { ...state.view }, mid: toMap((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) };
      drag = null;
    }
  });

  svg.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) { hoverTip(e); return; }
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    const box = svg.getBoundingClientRect();
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      state.view = pinch.view;
      zoomAt(pinch.dist / Math.max(20, Math.hypot(a[0] - b[0], a[1] - b[1])), ...pinch.mid);
      moved = true;
    } else if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      svg.classList.add('drag');
      const v = drag.view;
      state.view = clampView({ ...v, x: v.x - dx / box.width * v.w, y: v.y - dy / box.height * v.h });
      updateView();
      hideTip();
    }
  });

  svg.addEventListener('pointerup', e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      svg.classList.remove('drag');
      if (!moved) {
        const m = markerAt(e);
        if (m) select(m._loc.id);
      }
      drag = null;
    }
  });
  svg.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); drag = pinch = null; svg.classList.remove('drag'); });
  svg.addEventListener('pointerleave', hideTip);

  document.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => {
    const v = state.view;
    const c = [v.x + v.w / 2, v.y + v.h / 2];
    if (b.dataset.zoom === 'in') zoomAt(0.7, ...c);
    else if (b.dataset.zoom === 'out') zoomAt(1 / 0.7, ...c);
    else fitView();
  }));
  window.addEventListener('resize', () => state.map && fitView());
}

function markerAt(e) {
  return document.elementFromPoint(e.clientX, e.clientY)?.closest('.mk');
}

function hoverTip(e) {
  const m = markerAt(e);
  if (!m) { hideTip(); return; }
  const l = m._loc;
  let tip = document.querySelector('.tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    $('map').parentElement.appendChild(tip);
  }
  tip.innerHTML = `<b>${esc(l.name)}</b><br>${esc(l.bosses.join(', '))}<br><span class="note">${esc(l.region)} · ${LOC_TEXT[l.strength].toLowerCase()}</span>`;
  const box = $('map').parentElement.getBoundingClientRect();
  tip.style.left = `${Math.max(4, Math.min(e.clientX - box.left + 14, box.width - 270))}px`;
  tip.style.top = `${e.clientY - box.top + 14}px`;
}

function hideTip() {
  document.querySelector('.tip')?.remove();
}

/* ---------- Filters and list ---------- */

function renderRegionSelect() {
  $('region').innerHTML = '<option value="">Все регионы</option>' + state.map.regions.map(r =>
    `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
}

function renderChips() {
  $('chips').innerHTML = Object.entries(EFFECTS).map(([key, label]) => {
    const mode = state.fx[key];
    const text = mode === 'with' ? `✓ ${label}` : mode === 'without' ? `✕ ${label}` : label;
    return `<button type="button" class="chip ${mode || ''}" data-fx="${key}">${esc(text)}</button>`;
  }).join('');
}

function matches(l, q, region) {
  if (region && l.region !== region) return false;
  for (const [key, mode] of Object.entries(state.fx)) {
    if (!mode) continue;
    if (!l.effects) return false;   // effects not known: neither «with» nor «without» can be promised
    if ((mode === 'with') !== l.effects.includes(key)) return false;
  }
  if (q) {
    const hay = [l.name, l.region, ...l.bosses, ...l.monsters].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function renderList() {
  const q = $('q').value.trim().toLowerCase();
  const region = $('region').value;
  const shown = state.map.locations.filter(l => matches(l, q, region));
  const visible = new Set(shown.map(l => l.id));
  $('count').textContent = `Показано ${shown.length} из ${state.map.locations.length}`;
  const filtered = Boolean(q || region || Object.values(state.fx).some(Boolean));
  document.querySelector('[data-quick="reset"]').classList.toggle('hot', filtered);
  let html = '';
  for (const r of state.map.regions) {
    const items = shown.filter(l => l.region === r.name);
    if (!items.length) continue;
    html += `<h4 class="region-head">${esc(r.name)}</h4><ul>`;
    html += items.map(l => `
      <li data-id="${l.id}" class="${state.selected === l.id ? 'on' : ''}">
        <span class="mark${l.effects == null ? ' unknown' : ''}" style="--c:${rankColor(l.rank)}" title="${rankText(l.rank)} на карте; ${LOC_TEXT[l.strength].toLowerCase()}">${l.mega ? '☠' : ARROW[l.strength] || ''}</span>
        <div>
          <div class="name">${esc(l.name)}</div>
          <div class="sub">${esc(l.bosses.join(', '))}</div>
          ${l.effects == null ? '<div class="badges"><span class="badge unknown">нет сведений</span></div>'
            : l.effects.length ? `<div class="badges">${l.effects.map(k => `<span class="badge">${EFFECTS[k]}</span>`).join('')}</div>` : ''}
        </div>
      </li>`).join('');
    html += '</ul>';
  }
  $('list').innerHTML = html || '<p class="empty">Ничего не найдено</p>';
  for (const g of state.markers) g.classList.toggle('dim', !visible.has(g._loc.id));
}

/* ---------- Detail ---------- */

function showList() {
  $('listPane').hidden = false;
  $('detailPane').hidden = true;
  document.body.classList.remove('sheet-open');
}

function highlight(id) {
  for (const g of state.markers) g.classList.toggle('on', g._loc.id === id);
  document.querySelectorAll('#list li').forEach(li => li.classList.toggle('on', li.dataset.id === id));
}

function select(id, { reveal: bring = false } = {}) {
  hideTip();
  const l = id && state.byId.get(id);
  state.selected = l ? id : null;
  highlight(state.selected);
  go(state.selected);
  if (!l) { showList(); return; }
  showDetail(l);
  if (bring) requestAnimationFrame(() => reveal(point(l)));
}

function showDetail(l) {
  // On a phone the card slides up over the page and the list stays under it.
  $('listPane').hidden = !isPhone();
  $('detailPane').hidden = false;
  document.body.classList.toggle('sheet-open', isPhone());
  const effects = l.effects == null
    ? '<p class="note">Об эффектах этой локации пока нет сведений.</p>'
    : l.effects.length
      ? `<div class="tags">${l.effects.map(k => `<span class="tag">${EFFECTS[k]}</span>`).join('')}</div>`
      : '<p class="note">Монстры не накладывают особых эффектов.</p>';
  $('detail').innerHTML = `
    <h2>${esc(l.name)}</h2>
    <div class="where">${esc(state.map.name)} · ${esc(l.region)}</div>
    ${l.mega ? '<div class="warn">☠ Эпические боссы: бой для большой группы сильных героев.</div>' : ''}
    ${l.description ? `<p class="desc">${esc(l.description)}</p>` : ''}
    <div class="stats">
      <div class="stat"><div class="k">Сила на карте</div><div class="v"><i class="sw" style="background:${rankColor(l.rank)}"></i>${rankText(l.rank)} на карте</div></div>
      <div class="stat"><div class="k">Сила в регионе «${esc(l.region)}»</div><div class="v">${ARROW[l.strength] ? ARROW[l.strength] + ' ' : ''}${LOC_TEXT[l.strength]}</div></div>
      <div class="stat"><div class="k">Бой</div><div class="v">${l.group ? 'Можно группой' : 'В одиночку'}</div></div>
    </div>
    <h3>Боссы</h3>
    <div class="tags">${l.bosses.map(b => `<span class="tag boss">${esc(b)}</span>`).join('')}</div>
    ${l.monsters.length ? `<h3>Монстры</h3><div class="tags">${l.monsters.map(m => `<span class="tag">${esc(m)}</span>`).join('')}</div>` : ''}
    <h3>Эффекты</h3>${effects}
    <button type="button" class="to-map" id="toMap">Показать на карте</button>`;
  $('detailPane').scrollTop = 0;
}

/* ---------- Start ---------- */

function setupSide() {
  $('q').addEventListener('input', renderList);
  $('region').addEventListener('change', renderList);
  document.querySelectorAll('[data-quick]').forEach(b => b.addEventListener('click', () => {
    const kind = b.dataset.quick;
    state.fx = {};
    if (kind === 'reset') {
      $('q').value = '';
      $('region').value = '';
    } else {
      for (const key of Object.keys(EFFECTS)) {
        if (kind === 'none' || key !== 'ranged') state.fx[key] = 'without';
      }
    }
    renderChips();
    renderList();
  }));
  $('chips').addEventListener('click', e => {
    const chip = e.target.closest('[data-fx]');
    if (!chip) return;
    const key = chip.dataset.fx;
    state.fx[key] = { undefined: 'with', with: 'without', without: undefined }[state.fx[key]];
    renderChips();
    renderList();
  });
  $('list').addEventListener('click', e => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    select(li.dataset.id, { reveal: true });
  });
  $('detail').addEventListener('click', e => {
    if (e.target.id !== 'toMap') return;
    const id = state.selected;
    showList();
    highlight(id);
    const top = $('map').getBoundingClientRect().top + window.scrollY - document.querySelector('.top').offsetHeight - 8;
    window.scrollTo({ top, behavior: 'smooth' });
  });
  $('back').addEventListener('click', () => {
    select(null);
    renderList();
  });
}

async function start() {
  setupMapInput();
  setupSide();
  renderChips();
  try {
    state.index = (await getJSON('data/index.json')).maps;
  } catch (err) {
    document.querySelector('main').insertAdjacentHTML('afterbegin', `<p class="warn">Не удалось загрузить данные: ${esc(err.message)}</p>`);
    return;
  }
  renderCards();
  window.addEventListener('hashchange', route);
  await route();
}

start();
