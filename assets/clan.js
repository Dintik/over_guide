'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ROLES = { guest: 'гость', viewer: 'смотрит', marker: 'ставит метки', admin: 'админ', owner: 'главный админ' };
const RANK = { guest: 0, viewer: 1, marker: 2, admin: 3, owner: 4 };
const ERRORS = {
  bad_code: 'Неверный пароль', nick_taken: 'Этот ник уже занят', banned: 'Доступ заблокирован',
  bad_nick: 'Ник — от 2 до 24 символов', forbidden: 'Недостаточно прав', not_found: 'Игрок не найден',
  self: 'Нельзя применить к себе', short_password: 'Пароль — минимум 6 символов', not_signed_in: 'Нет сессии, обновите страницу',
  short_guest: 'Гостевой пароль — от 4 символов', same_as_role: 'Этот пароль уже занят другим уровнем',
};
const CODE_ROLES = { viewer: 'Смотреть', marker: 'Ставить метки', admin: 'Админ', owner: 'Главный админ' };

const state = { sb: null, me: null, data: null, map: null, marks: [], selected: null, mv: null, reloadTimer: null };

const can = need => RANK[state.me?.role] >= RANK[need];

function errorText(error) {
  const message = error?.message || String(error || '');
  const key = Object.keys(ERRORS).find(k => message.includes(k));
  return key ? ERRORS[key] : `Ошибка: ${message}`;
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86400)} дн назад`;
}
const clock = iso => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

async function rpc(name, args) {
  const { data, error } = await state.sb.rpc(name, args);
  if (error) throw error;
  return data;
}

/* ---------- Gate: sign-in and messages ---------- */

function showGate(message) {
  $('gate').hidden = false;
  $('clan').hidden = true;
  $('who').hidden = true;
  $('tabs').innerHTML = '';
  $('loginForm').hidden = Boolean(message);
  $('gateMessage').hidden = !message;
  $('gateMessage').innerHTML = message || '';
}

function showLogin(note = '') {
  showGate('');
  $('loginError').textContent = note;
  if (state.me?.nick) $('nick').value = state.me.nick;
  $('nick').focus();
}

async function login(e) {
  e.preventDefault();
  $('loginBtn').disabled = true;
  $('loginError').textContent = '';
  try {
    state.me = await rpc('clan_join', { p_code: $('code').value, p_nick: $('nick').value });
    $('code').value = '';
    await enter();
  } catch (err) {
    $('loginError').textContent = errorText(err);
  } finally {
    $('loginBtn').disabled = false;
  }
}

// Checks the caller's access now and then: a block or the end of a guest hour closes the page.
async function checkMe() {
  try {
    state.me = await rpc('clan_me');
  } catch {
    return;
  }
  if (!state.me?.role) closeFor(state.me);
  else renderWho();
}

function closeFor(me) {
  stopLive();
  const wasOpen = state.wasOpen;
  state.wasOpen = false;
  if (me?.banned) showGate('<h1>Доступ заблокирован</h1><p class="note">Обратитесь к админу клана.</p>');
  else if (me?.joined_as === 'guest') showLogin('Гостевой доступ закончился. Введите новый пароль.');
  else if (wasOpen) showLogin('Пароли снова включены. Введите пароль, чтобы продолжить.');
  else showLogin();
}

// Passwords on or off (the admins' switch): the sign-in form follows it; when they come back on,
// those who came in by the nick alone are out at once.
async function loadSettings() {
  const { data } = await state.sb.from('clan_settings').select('open').maybeSingle();
  state.open = Boolean(data?.open);
  renderLoginMode();
}

function renderLoginMode() {
  $('codeLabel').firstChild.textContent = state.open ? 'Пароль (не нужен, пароли выключены)' : 'Пароль';
  $('code').required = !state.open;
  $('openNote').hidden = !state.open;
}

function watchSettings() {
  state.sb.channel('clan-settings')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'clan_settings' }, async () => {
      await loadSettings();
      if (state.channel) await checkMe();
    })
    .subscribe();
}

/* ---------- The page ---------- */

async function enter() {
  if (!state.data) {
    const r = await fetch('data/clan.json');
    state.data = await r.json();
  }
  $('gate').hidden = true;
  $('clan').hidden = false;
  $('who').hidden = false;
  renderWho();
  renderTabs();
  await route();
  await loadMarks();
  startLive();
}

function renderWho() {
  const me = state.me;
  clearTimeout(state.guestTimer);
  if (me.role === 'guest' && me.guest_until) {
    state.guestTimer = setTimeout(checkMe, Math.max(1000, new Date(me.guest_until) - Date.now() + 1500));
  }
  const guest = me.role === 'guest' && me.guest_until ? ` до ${clock(me.guest_until)}` : me.via_open ? ', без пароля' : '';
  state.wasOpen = Boolean(me.via_open);
  $('whoText').innerHTML = `<b>${esc(me.nick)}</b> <span class="note">${ROLES[me.role]}${guest}</span>`;
  $('adminOpen').hidden = !can('admin');
  $('clearAll').hidden = !can('admin');
}

function renderTabs() {
  const current = state.map?.id;
  $('tabs').innerHTML = state.data.maps.map(m => `<a href="#${m.id}" class="${m.id === current ? 'on' : ''}">${esc(m.name)}</a>`).join('');
}

async function route() {
  const [mapId, pointId] = decodeURIComponent(location.hash.replace(/^#/, '')).split('/');
  const map = state.data.maps.find(m => m.id === mapId) || state.data.maps[0];
  if (state.map !== map) {
    state.map = map;
    state.byId = new Map(map.points.map(p => [p.id, p]));
    state.mv.set({ image: `maps/clan-${map.id}.jpg`, ratio: map.ratio, label: `Карта ${map.name}`,
                   items: map.points, draw: drawPoint });
    renderLegend();
    renderTabs();
  }
  select(pointId ? `${map.id}/${pointId}` : null, { reveal: true });
}

function marksAt(pointId) {
  return state.marks.filter(m => m.point === pointId);
}

function drawPoint(g, p) {
  const el = state.mv.el;
  const here = marksAt(p.id);
  const mine = here.some(m => m.user_id === state.me?.id);
  // Grey: nobody's there; yellow: marked, the nicks beside it.
  g.setAttribute('class', `mk pt${here.length ? ' marked' : ''}${mine ? ' mine' : ''}${state.selected === p.id ? ' on' : ''}`);
  el('circle', { class: 'ring', r: 19 }, g);
  el('circle', { class: 'dot', r: 14 }, g);
  if (here.length) {
    const names = here.map(m => m.nick);
    const label = names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
    el('text', { class: 'tag', x: 20, y: 0 }, g).textContent = label;
  }
}

function renderLegend() {
  $('legend').innerHTML = `<div class="keys"><span><i class="kd"></i>свободна</span><span><i class="kd marked"></i>отмечена</span>
    ${can('marker') ? '<span>клик по точке — поставить или снять свою метку</span>' : ''}</div>`;
}

// A click on a point: the caller's mark goes there, or off when it is already there. Shown at once,
// the database confirms (or the marks are read again).
async function toggleMark(p) {
  const me = state.me;
  const mine = state.marks.find(m => m.user_id === me.id);
  const off = mine && mine.point === p.id;
  state.marks = state.marks.filter(m => m.user_id !== me.id);
  if (!off) state.marks.push({ user_id: me.id, point: p.id, nick: me.nick, created_at: new Date().toISOString() });
  redrawPoints();
  renderPoint();
  renderMarks();
  await act(() => off ? rpc('clan_unmark', {}) : rpc('clan_mark', { p_point: p.id }));
}

function pick(p) {
  select(p.id);
  if (can('marker')) toggleMark(p);
}

function redrawPoints() {
  for (const g of state.mv.markers()) state.mv.redraw(g, drawPoint);
}

function select(id, { reveal = false } = {}) {
  const p = id && state.byId.get(id);
  state.selected = p ? id : null;
  const hash = `#${state.map.id}${p ? '/' + id.split('/')[1] : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  redrawPoints();
  renderPoint();
  if (p && reveal) requestAnimationFrame(() => state.mv.reveal(p));
}

function pointName(id) {
  for (const m of state.data.maps) {
    const p = m.points.find(x => x.id === id);
    if (p) return { name: p.name, map: m.name };
  }
  return { name: id, map: '' };
}

function renderPoint() {
  const p = state.selected && state.byId.get(state.selected);
  $('pointPane').hidden = !p;
  if (!p) return;
  const here = marksAt(p.id);
  const mineHere = here.some(m => m.user_id === state.me.id);
  const actions = can('marker')
    ? `<p class="note">${mineHere ? 'Ваша метка здесь. Клик по точке ещё раз — снять.' : 'Клик по точке — поставить сюда свою метку.'}</p>`
    : '';
  $('pointPane').innerHTML = `
    <div class="pane-head"><h2>${esc(p.name)}</h2><button type="button" class="x" data-act="close" aria-label="Закрыть">✕</button></div>
    <div class="note">${esc(state.map.name)}</div>
    ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
    <h3>Метки</h3>
    ${here.length ? `<ul class="marks">${here.map(markRow).join('')}</ul>` : '<p class="note">Здесь никого.</p>'}
    ${actions}`;
}

function markRow(m) {
  const mine = m.user_id === state.me.id;
  const where = pointName(m.point);
  const remove = can('marker') ? `<button type="button" class="x" data-unmark="${m.user_id}" title="Снять метку">✕</button>` : '';
  return `<li class="${mine ? 'mine' : ''}" data-point="${esc(m.point)}">
    <div><b>${esc(m.nick)}</b> <span class="note">${ago(m.created_at)}</span><br>
      <span class="where">${esc(where.name)}</span> <span class="note">· ${esc(where.map)}</span></div>${remove}</li>`;
}

function renderMarks() {
  const list = [...state.marks].sort((a, b) => b.created_at.localeCompare(a.created_at));
  $('marksCount').textContent = list.length ? `(${list.length})` : '';
  $('marks').innerHTML = list.map(markRow).join('') || '<li class="empty">Меток пока нет.</li>';
}

/* ---------- Marks: load, live updates, actions ---------- */

async function loadMarks() {
  const { data, error } = await state.sb.from('clan_marks').select('user_id, point, nick, created_at');
  if (error) return;
  state.marks = data || [];
  redrawPoints();
  renderPoint();
  renderMarks();
}

function scheduleReload() {
  clearTimeout(state.reloadTimer);
  state.reloadTimer = setTimeout(loadMarks, 120);
}

function startLive() {
  stopLive();
  state.channel = state.sb.channel('clan-marks')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'clan_marks' }, scheduleReload)
    .subscribe(status => $('live').classList.toggle('on', status === 'SUBSCRIBED'));
  state.poll = setInterval(() => { loadMarks(); checkMe(); }, 60000);
  state.tick = setInterval(renderMarks, 30000);   // «N мин назад»
}

function stopLive() {
  if (state.channel) state.sb.removeChannel(state.channel);
  state.channel = null;
  clearInterval(state.poll);
  clearInterval(state.tick);
}

async function act(fn) {
  try {
    await fn();
    await loadMarks();
  } catch (err) {
    alert(errorText(err));
    await checkMe();
  }
}

function confirmAsk(text) {
  return new Promise(resolve => {
    const dlg = $('confirmDlg');
    $('confirmText').textContent = text;
    dlg.onclick = e => {
      const v = e.target.value;
      if (v) { dlg.close(); resolve(v === 'yes'); }
    };
    dlg.oncancel = () => resolve(false);
    dlg.showModal();
  });
}

/* ---------- Admin ---------- */

async function openAdmin() {
  $('adminError').textContent = '';
  $('guestOut').textContent = '';
  $('codeRole').innerHTML = Object.entries(CODE_ROLES)
    .filter(([r]) => can('owner') || RANK[r] < RANK[state.me.role])
    .map(([r, label]) => `<option value="${r}">${label}</option>`).join('');
  $('guestCode').value = '';
  renderOpenSwitch();
  await guestStatus();
  await loadMembers();
  $('adminDlg').showModal();
}

function renderOpenSwitch() {
  $('openState').textContent = state.open
    ? 'Пароли выключены: любой входит по нику и ставит метки. Админы входят по паролю.'
    : 'Пароли включены.';
  $('openToggle').textContent = state.open ? 'Включить пароли' : 'Выключить пароли';
}

async function guestStatus() {
  try {
    const g = await rpc('clan_guest_status');
    $('guestOut').innerHTML = g?.expires_at
      ? `Гостевой пароль включён до ${clock(g.expires_at)}${g.by ? ` (${esc(g.by)})` : ''}`
      : 'Гостевой пароль выключен.';
    $('guestOff').hidden = !g?.expires_at;
  } catch { /* shown by the caller */ }
}

async function loadMembers() {
  const { data, error } = await state.sb.from('clan_members')
    .select('user_id, nick, role, banned, last_seen, guest_until').order('nick');
  if (error) { $('adminError').textContent = errorText(error); return; }
  $('membersCount').textContent = `(${data.length})`;
  $('members').innerHTML = data.map(m => {
    const self = m.user_id === state.me.id;
    const above = RANK[m.role] >= RANK[state.me.role];
    const tools = self || above ? '' : `
      <button type="button" data-member="${m.user_id}" data-do="${m.banned ? 'unban' : 'ban'}">${m.banned ? 'Разблок.' : 'Блок'}</button>
      <button type="button" class="danger" data-member="${m.user_id}" data-do="remove" data-nick="${esc(m.nick)}">Удалить</button>`;
    return `<tr class="${m.banned ? 'banned' : ''}">
      <td><b>${esc(m.nick)}</b>${m.banned ? ' <span class="badge danger">заблокирован</span>' : ''}</td>
      <td>${ROLES[m.role]}</td>
      <td><code title="${m.user_id}">${m.user_id.slice(0, 8)}</code></td>
      <td class="note">${ago(m.last_seen)}</td><td class="tools">${tools}</td></tr>`;
  }).join('');
}

async function adminDo(fn) {
  $('adminError').textContent = '';
  try {
    await fn();
    await loadMembers();
    await loadMarks();
  } catch (err) {
    $('adminError').textContent = errorText(err);
  }
}

/* ---------- Start ---------- */

function setup() {
  $('loginForm').addEventListener('submit', login);
  window.addEventListener('hashchange', () => state.map && route());
  state.mv = createMapView($('map'), { onPick: pick, buttons: $('clan') });

  document.addEventListener('click', async e => {
    const t = e.target.closest('button, li[data-point]');
    if (!t) return;
    if (t.dataset.act === 'close') select(null);
    else if (t.dataset.unmark) {
      e.stopPropagation();
      act(() => rpc('clan_unmark', { p_user: t.dataset.unmark }));
    } else if (t.dataset.point) {
      const [mapId, pointId] = t.dataset.point.split('/');
      location.hash = `#${mapId}/${pointId}`;
    } else if (t.dataset.member) {
      const id = t.dataset.member;
      if (t.dataset.do === 'remove') {
        if (!await confirmAsk(`Удалить игрока ${t.dataset.nick}? Его ник освободится.`)) return;
        adminDo(() => rpc('clan_remove', { p_target: id }));
      } else {
        adminDo(() => rpc('clan_ban', { p_target: id, p_banned: t.dataset.do === 'ban' }));
      }
    } else if (t.hasAttribute('data-close')) {
      t.closest('dialog').close();
    }
  });

  $('clearAll').addEventListener('click', async () => {
    if (!await confirmAsk('Сбросить все метки у всех игроков?')) return;
    act(() => rpc('clan_clear_marks'));
  });
  $('adminOpen').addEventListener('click', openAdmin);
  $('banForm').addEventListener('submit', e => {
    e.preventDefault();
    const ban = e.submitter?.dataset.ban !== '0';
    adminDo(async () => {
      await rpc('clan_ban', { p_target: $('banTarget').value, p_banned: ban });
      $('banTarget').value = '';
    });
  });
  $('codeForm').addEventListener('submit', e => {
    e.preventDefault();
    adminDo(async () => {
      await rpc('clan_set_code', { p_role: $('codeRole').value, p_password: $('codePass').value });
      $('codePass').value = '';
      $('adminError').textContent = 'Пароль сменён.';
    });
  });
  $('guestForm').addEventListener('submit', e => {
    e.preventDefault();
    adminDo(async () => {
      const g = await rpc('clan_guest_code', { p_code: $('guestCode').value || null });
      $('guestCode').value = '';
      $('guestOut').innerHTML = `Пароль <b class="code">${esc(g.code)}</b> действует до ${clock(g.expires_at)}`;
    });
  });
  $('openToggle').addEventListener('click', async () => {
    const turnOn = state.open;
    const ask = turnOn
      ? 'Включить пароли? Все, кто вошёл без пароля, сразу будут выкинуты, их метки снимутся.'
      : 'Выключить пароли? Любой, кто знает адрес страницы, сможет войти по одному нику и ставить метки.';
    if (!await confirmAsk(ask)) return;
    adminDo(async () => {
      const r = await rpc('clan_set_open', { p_open: !turnOn });
      await loadSettings();
      renderOpenSwitch();
      if (turnOn && r?.removed) $('adminError').textContent = `Выкинуто вошедших без пароля: ${r.removed}.`;
    });
  });
  $('guestOff').addEventListener('click', () => adminDo(async () => {
    await rpc('clan_guest_off');
    await guestStatus();
  }));
  $('logout').addEventListener('click', async () => {
    if (!await confirmAsk('Выйти? Ваша метка снимется, а ник освободится.')) return;
    try { await rpc('clan_leave'); } catch { /* blocked players stay */ }
    stopLive();
    await state.sb.auth.signOut();
    location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.channel) { loadMarks(); checkMe(); }
  });
}

async function start() {
  setup();
  const cfg = window.CLAN_CONFIG || {};
  if (!cfg.url || !cfg.key || !window.supabase) {
    showGate('<h1>Страница ещё не настроена</h1><p class="note">Нет подключения к базе клана.</p>');
    return;
  }
  state.sb = window.supabase.createClient(cfg.url, cfg.key);
  let { data: { session } } = await state.sb.auth.getSession();
  if (!session) {
    const { error } = await state.sb.auth.signInAnonymously();
    if (error) {
      const off = /anonymous sign-ins are disabled/i.test(error.message);
      showGate(`<h1>Не удалось подключиться</h1><p class="note">${off
        ? 'В настройках базы клана выключен анонимный вход. Сообщите админу клана.' : esc(error.message)}</p>`);
      return;
    }
  }
  try {
    state.me = await rpc('clan_me');
  } catch (err) {
    showGate(`<h1>Не удалось подключиться</h1><p class="note">${esc(errorText(err))}</p>`);
    return;
  }
  await loadSettings();
  watchSettings();
  if (state.me?.role) await enter();
  else closeFor(state.me);
}

start();
