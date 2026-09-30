/*
 * ARM·BOX — пульт манипулятора. Чистый JS, без зависимостей.
 * Зависит от window.Kin (kinematics.js) и window.Driver (driver.js).
 */
(function () {
  'use strict';

  /* ================================ утилиты ================================ */

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const timeStr = (t) => new Date(t).toLocaleTimeString('ru-RU');

  const store = {
    get(key, def) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (_) { return def; }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* приватный режим */ }
    },
  };

  function toast(text, kind) {
    const box = $('#toasts');
    if ($$('.toast', box).some((t) => t.textContent === text)) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' error' : '');
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => el.remove(), kind === 'error' ? 5000 : 2800);
  }

  function download(name, text, type = 'application/json') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* =============================== настройки =============================== */

  const DEFAULTS = {
    host: '', // IP backend; пусто — 127.0.0.1 или адрес, заданный прокси
    port: '', // порт backend; пусто — 8000
    transport: 'ws',
    demo: false,
    pollMs: 1000,
    zMin: 0,
    step: 10,
    live: false,
    gripTrue: 'open', // что означает gripper_state = true
    theme: window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    tab: 'control',
  };
  const S = Object.assign({}, DEFAULTS, store.get('armbox.settings', {}));
  // ?demo в адресе включает демо-режим
  if (/[?&]demo\b/.test(location.search)) S.demo = true;
  const saveSettings = () => store.set('armbox.settings', S);

  // миграция со старых настроек (адрес целиком → IP и порт)
  if (S.apiBase) {
    try { const u = new URL(S.apiBase); S.host = u.hostname; S.port = u.port || '80'; } catch (_) { /* ignore */ }
  }
  delete S.apiBase; delete S.wsUrl;

  /*
   * Прокси. Если страница открыта через serve.py или nginx из комплекта, запросы идут
   * на тот же адрес, а прокси пересылает их на backend (обходит отсутствие CORS).
   *   serve.py — IP и порт backend меняются из пульта (POST /__backend)
   *   nginx    — backend задан переменной BACKEND_URL
   *   none     — прямое подключение к http://IP:порт (backend должен разрешать CORS)
   */
  let proxy = { kind: 'none' };

  async function detectProxy() {
    if (!/^https?:$/.test(location.protocol)) return (proxy = { kind: 'none' });
    try {
      const r = await fetch('/__backend', { headers: { accept: 'application/json' } });
      const j = r.ok && /json/.test(r.headers.get('content-type') || '') ? await r.json() : null;
      if (j && j.proxy === 'serve.py') proxy = { kind: 'serve', host: j.host, port: j.port };
      else if (j && j.proxy === 'nginx') proxy = { kind: 'nginx', url: j.url };
      else proxy = { kind: 'none' };
    } catch (_) {
      proxy = { kind: 'none' };
    }
    return proxy;
  }

  const hostOf = () => (S.host || '').trim() || '127.0.0.1';
  const portOf = () => +S.port || 8000;

  /** Адрес backend, как его видит пользователь */
  function backendAddr() {
    if (proxy.kind === 'serve') return proxy.host + ':' + proxy.port;
    if (proxy.kind === 'nginx') return String(proxy.url || '').replace(/^https?:\/\//, '');
    return hostOf() + ':' + portOf();
  }

  function urls() {
    if (proxy.kind !== 'none') {
      return { api: '/api/motors', ws: (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws' };
    }
    const h = hostOf().includes(':') ? '[' + hostOf() + ']' : hostOf();
    return { api: 'http://' + h + ':' + portOf() + '/api/motors', ws: 'ws://' + h + ':' + portOf() + '/ws' };
  }

  /** Переключить прокси serve.py на другой backend */
  async function pushBackend(host, port) {
    const r = await fetch('/__backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || 'HTTP ' + r.status);
    proxy = { kind: 'serve', host: j.host, port: j.port };
  }

  const MOTORS = [
    { id: 1, name: 'База', ticks: 4096, deg: 360 },
    { id: 2, name: 'Плечо', ticks: 4096, deg: 360 },
    { id: 3, name: 'Локоть', ticks: 4096, deg: 360 },
    { id: 4, name: 'Кисть', ticks: 4096, deg: 360 },
    { id: 5, name: 'Поворот схвата', ticks: 1024, deg: 300 },
    { id: 6, name: 'Схват', ticks: 1024, deg: 300 },
  ];
  const LIMITS = { x: [0, 340], z: [-100, 420], angel: [0, 360], pov_gripper: [0, 300] };

  /* ================================ состояние ================================ */

  const HOME = { x: 200, z: 200, angel: 180, pov_gripper: 150, open: false };

  const st = {
    driver: null,
    link: 'unknown', // unknown | online | offline
    ws: 'idle',
    lastError: '',
    target: Object.assign({}, HOME),
    committed: null,
    busy: false,
    queued: false,
    programRunning: false,
    speed: null, // %, null — неизвестно
    speedSupported: null, // false — в backend нет /api/motors/speed
    pos: {},
    temp: {},
    load: {},
    updatedAt: 0,
    history: [],
    log: [],
  };

  function addLog(level, text) {
    st.log.unshift({ t: Date.now(), level, text });
    st.log.length = Math.min(st.log.length, 300);
    renderLog();
  }

  const toCommand = (t) => ({
    x: t.x,
    z: t.z,
    angel: t.angel,
    pov_gripper: t.pov_gripper,
    gripper_state: S.gripTrue === 'open' ? !!t.open : !t.open,
  });

  function validate(t) {
    if (t.z < S.zMin) return 'Z ниже минимальной высоты (' + S.zMin + ' мм)';
    if (t.angel < 0 || t.angel > 360) return 'Угол базы вне диапазона 0…360°';
    if (t.pov_gripper < 0 || t.pov_gripper > 300) return 'Поворот схвата вне диапазона 0…300°';
    if (!Kin.inverse(t.x, t.z, t.angel)) return 'Точка вне рабочей зоны';
    return null;
  }

  const sameTarget = (a, b) => !!a && !!b && a.x === b.x && a.z === b.z && a.angel === b.angel && a.pov_gripper === b.pov_gripper && !!a.open === !!b.open;

  function setTarget(patch, send) {
    if (st.programRunning) { toast('Идёт программа — остановите её для ручного управления'); return; }
    Object.assign(st.target, patch);
    renderControl();
    if (send === undefined ? S.live : send) execute();
  }

  /** Отправить цель. explicit — точка программы (без коалесценции). */
  async function execute(explicit) {
    if (!st.driver) return false;
    if (st.programRunning && !explicit) {
      toast('Идёт программа — остановите её для ручного управления');
      return false;
    }
    if (st.busy && !explicit) {
      st.queued = true; // пока рука едет, запоминаем только последнюю цель
      return true;
    }
    const target = Object.assign({}, explicit || st.target);
    const err = validate(target);
    if (err) { toast(err); addLog('warn', err); return false; }

    const cmd = toCommand(target);
    st.busy = true;
    st.queued = false;
    renderStatus();
    const t0 = performance.now();
    try {
      await st.driver.move(cmd, S.transport);
      st.committed = target;
      st.lastError = '';
      addLog('ok', 'Движение ' + Math.round(performance.now() - t0) + ' мс · x=' + cmd.x + ' z=' + cmd.z + ' угол=' + cmd.angel + ' схват=' + cmd.gripper_state);
      return true;
    } catch (e) {
      st.lastError = e.message;
      addLog('error', 'Ошибка движения: ' + e.message);
      toast(e.message, 'error');
      return false;
    } finally {
      st.busy = false;
      renderStatus();
      renderControl();
      if (st.queued && !explicit) { st.queued = false; execute(); }
    }
  }

  /* ============================ драйвер и опрос ============================ */

  let gen = 0;
  let pollTimer = null;

  function startDriver() {
    stopDriver();
    const u = urls();
    const d = S.demo ? new Driver.DemoDriver() : new Driver.RealDriver(u.api, u.ws);
    const my = ++gen;
    Object.assign(st, { driver: d, link: 'unknown', ws: 'idle', pos: {}, temp: {}, load: {}, history: [], busy: false, queued: false, speed: null, speedSupported: null });
    addLog('info', S.demo ? 'Демо-режим: симуляция манипулятора' : 'Подключение к ' + backendAddr() + (proxy.kind !== 'none' ? ' (через прокси ' + (proxy.kind === 'serve' ? 'serve.py' : 'nginx') + ')' : ' (напрямую)'));
    renderSpeed();

    let prev = 'idle';
    d.onWs((s) => {
      if (my !== gen) return;
      st.ws = s;
      if (!S.demo && s === 'open' && prev !== 'open') addLog('ok', 'WebSocket подключён');
      if (!S.demo && s === 'closed' && prev === 'open') addLog('warn', 'WebSocket отключён, переподключение…');
      prev = s;
      renderStatus();
    });
    if (S.transport === 'ws' || S.demo) d.connect();

    const poll = async () => {
      if (my !== gen) return;
      try {
        // шина полудуплексная — строго последовательно
        const pos = await d.getPos();
        const temp = await d.getTemp();
        const load = await d.getLoad();
        if (my !== gen) return;
        const first = st.link !== 'online';
        Object.assign(st, { pos, temp, load, link: 'online', updatedAt: Date.now() });
        st.history.push({ temp, load });
        if (st.history.length > 90) st.history.shift();
        if (first) {
          addLog('ok', 'Связь с контроллером установлена');
          loadSpeed(d, my);
          if (!st.committed) seedTarget(pos);
        }
      } catch (e) {
        if (my !== gen) return;
        if (st.link !== 'offline') addLog('error', 'Телеметрия недоступна: ' + e.message);
        st.link = 'offline';
        st.lastError = e.message;
      }
      renderStatus();
      renderTelemetry();
      const delay = S.demo ? 200 : S.pollMs * (st.link === 'offline' ? 3 : 1);
      pollTimer = setTimeout(poll, delay);
    };
    poll();
    renderStatus();
  }

  function stopDriver() {
    gen++;
    clearTimeout(pollTimer);
    if (st.driver) st.driver.dispose();
    st.driver = null;
  }

  /** При первом подключении синхронизируем цель с фактическим положением руки */
  function seedTarget(pos) {
    if (![1, 2, 3].every((i) => Number.isFinite(pos[i]))) return;
    const p = Kin.poseFromTicks(pos);
    const j = Kin.joints(p);
    const patch = { angel: Math.round(p.angle), pov_gripper: Math.round(p.pov) };
    if (Kin.isReachable(Math.round(j.t.x), Math.round(j.t.z))) { patch.x = Math.round(j.t.x); patch.z = Math.round(j.t.z); }
    if (Number.isFinite(pos[6])) {
      const isTrue = Math.abs(pos[6] - 370) < Math.abs(pos[6] - 710);
      patch.open = S.gripTrue === 'open' ? isTrue : !isTrue;
    }
    Object.assign(st.target, patch);
    renderControl();
  }

  /* ================================ статус ================================ */

  function setSt(el, cls, text) {
    el.className = 'st ' + cls;
    el.lastChild.textContent = text;
  }

  function renderStatus() {
    $('#st-busy').hidden = !st.busy;
    const wsEl = $('#st-ws');
    wsEl.hidden = S.demo || S.transport !== 'ws';
    setSt(wsEl, st.ws === 'open' ? 'ok' : st.ws === 'connecting' ? 'warn' : 'err', 'ws');
    $('#st-addr').textContent = S.demo ? '' : backendAddr();
    const link = $('#st-link');
    if (S.demo) setSt(link, 'demo', 'демо');
    else if (st.link === 'online') setSt(link, 'ok', 'на связи');
    else if (st.link === 'offline') setSt(link, 'err', 'нет связи');
    else setSt(link, 'warn', 'подключение');

    $('#banner').hidden = !(st.link === 'offline' && !S.demo);
    $('#banner-err').title = backendAddr();
    $('#banner-err').textContent = st.lastError ? '· ' + st.lastError : '';
    $('#btn-exec').disabled = st.busy || !st.driver || !!validate(st.target);
    $('#btn-exec').firstChild.textContent = st.busy ? 'Выполняется… ' : 'Выполнить ';
  }

  /* =============================== управление =============================== */

  const axes = $$('.axis').map((root) => {
    const key = root.dataset.key;
    const num = $('.num input', root);
    const range = $('input[type=range]', root);
    const [min, max] = LIMITS[key];
    range.min = min; range.max = max;

    const paintRange = () => range.style.setProperty('--p', ((range.value - range.min) / (range.max - range.min)) * 100 + '%');
    const commitNum = () => {
      const v = Number(String(num.value).replace(',', '.'));
      if (!Number.isFinite(v)) { num.value = st.target[key]; return; }
      const c = clamp(Math.round(v), min, max);
      if (c !== st.target[key]) setTarget({ [key]: c });
      else num.value = c;
    };
    num.addEventListener('focus', () => num.select());
    num.addEventListener('blur', commitNum);
    num.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') num.blur();
      if (e.key === 'Escape') { num.value = st.target[key]; num.blur(); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1);
        setTarget({ [key]: clamp(st.target[key] + d, min, max) });
      }
    });
    range.addEventListener('input', () => setTarget({ [key]: Number(range.value) }, false));
    range.addEventListener('change', () => setTarget({ [key]: Number(range.value) }));

    return {
      update() {
        if (document.activeElement !== num) num.value = st.target[key];
        if (document.activeElement !== range) range.value = st.target[key];
        paintRange();
      },
    };
  });

  function renderControl() {
    axes.forEach((a) => a.update());
    const err = validate(st.target);
    const errEl = $('#goal-error');
    errEl.hidden = !err;
    errEl.textContent = err || '';
    $('#goal-state').textContent = st.busy ? 'движение…' : sameTarget(st.target, st.committed) ? 'достигнута' : 'не отправлена';
    $('#grip').checked = !!st.target.open;
    $('#grip-title').textContent = st.target.open ? 'Схват открыт' : 'Схват закрыт';
    $('#grip-raw').textContent = String(toCommand(st.target).gripper_state);
    $('#live').checked = S.live;
    $$('#steps button').forEach((b) => b.classList.toggle('on', +b.dataset.step === S.step));
    renderStatus();
    dirty = true;
  }

  $('#grip').addEventListener('change', (e) => setTarget({ open: e.target.checked }, true));
  $('#live').addEventListener('change', (e) => { S.live = e.target.checked; saveSettings(); });
  $('#btn-exec').addEventListener('click', () => execute());
  $('#btn-home').addEventListener('click', () => setTarget(Object.assign({}, HOME), true));
  $('#steps').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.step = +b.dataset.step;
    saveSettings();
    renderControl();
  });

  const angStep = () => ({ 1: 1, 5: 2, 10: 5, 25: 15 })[S.step] || 5;

  /** Шаг ручного перемещения: сразу отправляет команду */
  function jog(dir, mult = 1) {
    if (st.programRunning) { toast('Идёт программа — остановите её для ручного управления'); return false; }
    const m = S.step * mult;
    const a = angStep() * mult;
    const t = st.target;
    const patch = {
      'x+': { x: t.x + m }, 'x-': { x: t.x - m },
      'z+': { z: t.z + m }, 'z-': { z: t.z - m },
      'a+': { angel: t.angel + a }, 'a-': { angel: t.angel - a },
      'p+': { pov_gripper: t.pov_gripper + a }, 'p-': { pov_gripper: t.pov_gripper - a },
    }[dir];
    const err = validate(Object.assign({}, t, patch));
    if (err) { toast(err); return false; }
    setTarget(patch, true);
    return true;
  }

  // Кнопки с автоповтором при удержании
  $$('[data-jog]').forEach((btn) => {
    let timer = null;
    const stop = () => { clearTimeout(timer); timer = null; btn.classList.remove('held'); };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.classList.add('held');
      if (!jog(btn.dataset.jog)) return stop();
      const loop = (d) => { timer = setTimeout(() => (jog(btn.dataset.jog) ? loop(110) : stop()), d); };
      loop(380);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jog(btn.dataset.jog); } });
  });

  // Горячие клавиши
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.shiftKey ? 5 : 1;
    const map = {
      ArrowLeft: () => jog('x-', k), ArrowRight: () => jog('x+', k),
      ArrowUp: () => jog('z+', k), ArrowDown: () => jog('z-', k),
      KeyQ: () => jog('a-', k), KeyE: () => jog('a+', k),
      KeyA: () => jog('p-', k), KeyD: () => jog('p+', k),
      KeyG: () => setTarget({ open: !st.target.open }, true),
      KeyH: () => setTarget(Object.assign({}, HOME), true),
      Enter: () => execute(),
    };
    const fn = map[e.code] || map[e.key];
    if (fn) { e.preventDefault(); fn(); }
  });

  /* ================================ скорость ================================ */

  const isNotFound = (e) => /HTTP 404|нет backend/.test(e.message);

  async function loadSpeed(d, my) {
    try {
      const v = await d.getSpeed();
      if (my !== gen) return;
      st.speed = Number.isFinite(v) ? v : null;
      st.speedSupported = true;
    } catch (e) {
      if (my !== gen) return;
      st.speedSupported = isNotFound(e) ? false : null;
      if (st.speedSupported === false) addLog('warn', 'В backend нет метода /api/motors/speed — примените патч из backend-patch');
    }
    renderSpeed();
  }

  let speedSending = false;
  async function applySpeed(v) {
    v = clamp(Math.round(v), 1, 100);
    if (!st.driver) return;
    if (st.speedSupported === false) {
      toast('Backend не поддерживает смену скорости — примените патч из папки backend-patch', 'error');
      renderSpeed();
      return;
    }
    speedSending = true;
    renderSpeed(v);
    try {
      await st.driver.setSpeed(v);
      st.speed = v;
      st.speedSupported = true;
      addLog('ok', 'Скорость: ' + v + ' %');
    } catch (e) {
      if (isNotFound(e)) {
        st.speedSupported = false;
        toast('Backend не поддерживает смену скорости — примените патч из папки backend-patch', 'error');
      } else {
        toast('Скорость не изменена: ' + e.message, 'error');
      }
      addLog('error', 'Скорость не изменена: ' + e.message);
    } finally {
      speedSending = false;
      renderSpeed();
    }
  }

  function renderSpeed(preview) {
    const range = $('#speed');
    const v = preview !== undefined ? preview : st.speed;
    range.value = v == null ? 30 : v;
    range.style.setProperty('--p', ((range.value - 1) / 99) * 100 + '%');
    $('#speed-val').textContent = v == null ? '—' : v;
    $$('#speed-presets button').forEach((b) => b.classList.toggle('on', +b.dataset.v === v));
    const stEl = $('#speed-state');
    stEl.className = '';
    if (speedSending) stEl.textContent = 'применяется…';
    else if (st.speedSupported === false) { stEl.textContent = 'нет метода в backend'; stEl.className = 'warn'; }
    else if (st.speed == null) stEl.textContent = st.link === 'online' ? 'неизвестна' : '';
    else stEl.textContent = '';
    range.disabled = !st.driver;
  }

  $('#speed').addEventListener('input', (e) => renderSpeed(+e.target.value));
  $('#speed').addEventListener('change', (e) => applySpeed(+e.target.value));
  $('#speed-presets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) applySpeed(+b.dataset.v);
  });

  /* =============================== визуализация =============================== */

  const cvSide = $('#cv-side');
  const cvTop = $('#cv-top');
  let colors = {};
  let dirty = true;
  let zoneCache = null;
  const shown = { angle: 180, shoulder: 0, elbow: 0, pov: 150, grip: 0 };
  let shownInit = false;
  const trail = [];

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    colors = { bg: v('--bg'), soft: v('--bg-soft'), line: v('--line'), strong: v('--line-strong'), text: v('--text'), muted: v('--muted'), goal: v('--goal'), zone: v('--zone'), warn: v('--warn'), err: v('--err'), mono: v('--mono') };
    zoneCache = null;
    dirty = true;
  }

  function fitCanvas(cv) {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; zoneCache = null; dirty = true; }
    return { w: r.width, h: r.height, dpr };
  }

  // Мир вида сбоку, мм
  const WX0 = -80, WX1 = 370, WZ0 = -20, WZ1 = 420;

  function sideMap(w, h) {
    const pad = 28;
    const s = Math.min((w - pad * 2) / (WX1 - WX0), (h - pad * 2) / (WZ1 - WZ0));
    const ox = (w - (WX1 - WX0) * s) / 2 - WX0 * s;
    const oz = (h + (WZ1 - WZ0) * s) / 2 + WZ0 * s;
    return { s, X: (x) => ox + x * s, Z: (z) => oz - z * s, x: (px) => (px - ox) / s, z: (py) => (oz - py) / s };
  }

  function buildZone(w, h, dpr, m) {
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = colors.zone;
    const step = 4;
    const cell = step * m.s + 0.6;
    for (let x = 0; x <= 345; x += step) {
      for (let z = 0; z <= WZ1; z += step) {
        if (Kin.isReachable(x, z)) g.fillRect(m.X(x) - cell / 2, m.Z(z) - cell / 2, cell, cell);
      }
    }
    return c;
  }

  function actualPose() {
    if ([1, 2, 3].every((i) => Number.isFinite(st.pos[i]))) {
      const p = Kin.poseFromTicks(st.pos);
      const openTick = S.gripTrue === 'open' ? 370 : 710;
      const closeTick = S.gripTrue === 'open' ? 710 : 370;
      p.grip = clamp((closeTick - p.gripTick) / (closeTick - openTick), 0, 1);
      return p;
    }
    const t = st.committed || HOME;
    const p = Kin.poseFromTarget(t.x, t.z, t.angel, t.pov_gripper);
    p.grip = t.open ? 1 : 0;
    return p;
  }

  function stepAnimation(dt) {
    const a = actualPose();
    if (!shownInit) { Object.assign(shown, a); shownInit = true; return true; }
    const k = 1 - Math.exp(-9 * dt);
    let moving = false;
    for (const key of ['angle', 'shoulder', 'elbow', 'pov', 'grip']) {
      const d = a[key] - shown[key];
      if (Math.abs(d) > 1e-4) { shown[key] += d * k; moving = true; }
    }
    return moving;
  }

  function line(g, pts, width, color, dash) {
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
    g.lineWidth = width;
    g.strokeStyle = color;
    g.setLineDash(dash || []);
    g.stroke();
    g.setLineDash([]);
  }

  function dot(g, x, y, r, fill, stroke, lw = 1.5) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.stroke(); }
  }

  function drawSide() {
    const { w, h, dpr } = fitCanvas(cvSide);
    const g = cvSide.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const m = sideMap(w, h);
    g.font = '10px ' + colors.mono;
    g.textBaseline = 'alphabetic';

    // сетка
    g.lineWidth = 1;
    for (let x = -50; x <= WX1; x += 50) {
      g.strokeStyle = x % 100 === 0 ? colors.line : colors.soft;
      g.beginPath(); g.moveTo(Math.round(m.X(x)) + 0.5, m.Z(WZ1)); g.lineTo(Math.round(m.X(x)) + 0.5, m.Z(0)); g.stroke();
      if (x % 100 === 0 && x >= 0) { g.fillStyle = colors.muted; g.fillText(String(x), m.X(x) + 3, m.Z(0) + 14); }
    }
    for (let z = 50; z <= WZ1; z += 50) {
      g.strokeStyle = z % 100 === 0 ? colors.line : colors.soft;
      g.beginPath(); g.moveTo(m.X(WX0), Math.round(m.Z(z)) + 0.5); g.lineTo(m.X(WX1), Math.round(m.Z(z)) + 0.5); g.stroke();
      if (z % 100 === 0) { g.fillStyle = colors.muted; g.fillText(String(z), m.X(WX0) + 2, m.Z(z) - 4); }
    }

    // рабочая зона
    if (!zoneCache) zoneCache = buildZone(w, h, dpr, m);
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(zoneCache, 0, 0); g.restore();

    // пол
    line(g, [[m.X(WX0), m.Z(0)], [m.X(WX1), m.Z(0)]], 1, colors.strong);
    if (S.zMin > 0) line(g, [[m.X(WX0), m.Z(S.zMin)], [m.X(WX1), m.Z(S.zMin)]], 1, colors.warn, [4, 4]);

    // основание
    const B = Kin.GEOM.BASE_HEIGHT;
    g.fillStyle = colors.bg;
    g.strokeStyle = colors.text;
    g.lineWidth = 1.5;
    g.beginPath();
    g.rect(m.X(-38), m.Z(B - 10), (76) * m.s, (B - 10) * m.s);
    g.fill(); g.stroke();
    line(g, [[m.X(-55), m.Z(0)], [m.X(55), m.Z(0)]], 3, colors.text);

    // след
    if (trail.length > 1) line(g, trail.map((p) => [m.X(p.x), m.Z(p.z)]), 1, colors.muted);

    // цель (призрак)
    const tp = Kin.poseFromTarget(st.target.x, st.target.z, st.target.angel, st.target.pov_gripper);
    if (tp) {
      const j = Kin.joints(tp);
      line(g, [j.s, j.e, j.w, j.t].map((p) => [m.X(p.x), m.Z(p.z)]), 1.5, colors.goal, [5, 4]);
    }

    // фактическая поза
    const j = Kin.joints(shown);
    const P = (p) => [m.X(p.x), m.Z(p.z)];
    line(g, [P(j.s), P(j.e), P(j.w)], Math.max(5, 16 * m.s), colors.text);
    g.lineCap = 'round';
    line(g, [P(j.w), P({ x: j.w.x, z: j.t.z + 45 })], Math.max(3, 9 * m.s), colors.text);
    g.lineCap = 'butt';
    // пальцы схвата
    const open = 8 + shown.grip * 22;
    const fz0 = j.t.z + 45, fz1 = j.t.z;
    [-1, 1].forEach((sgn) => line(g, [[m.X(j.w.x + sgn * open), m.Z(fz0)], [m.X(j.w.x + sgn * open), m.Z(fz1)]], 2, colors.text));
    line(g, [[m.X(j.w.x - open), m.Z(fz0)], [m.X(j.w.x + open), m.Z(fz0)]], 2, colors.text);
    [j.s, j.e, j.w].forEach((p) => dot(g, m.X(p.x), m.Z(p.z), Math.max(4, 10 * m.s), colors.bg, colors.text, 2));

    // точка цели
    const tx = m.X(st.target.x), tz = m.Z(st.target.z);
    const ok = !!tp && st.target.z >= S.zMin;
    const c = ok ? colors.goal : colors.err;
    line(g, [[tx - 9, tz], [tx + 9, tz]], 1, c);
    line(g, [[tx, tz - 9], [tx, tz + 9]], 1, c);
    dot(g, tx, tz, 4, c);
    g.fillStyle = c;
    g.font = '11px ' + colors.mono;
    const label = st.target.x + ', ' + st.target.z;
    g.fillText(label, Math.min(tx + 10, w - g.measureText(label).width - 4), tz - 10);
  }

  function drawTop() {
    const { w, h, dpr } = fitCanvas(cvTop);
    const g = cvTop.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) / 2 - 16;
    const k = R / 360;
    const P = (x, ang) => { const a = ((ang - 90) * Math.PI) / 180; return [cx + Math.cos(a) * x * k, cy - Math.sin(a) * x * k]; };

    g.lineWidth = 1;
    [120, 240, 360].forEach((r) => dot(g, cx, cy, r * k, null, r === 360 ? colors.strong : colors.line, 1));
    g.fillStyle = colors.zone;
    g.beginPath(); g.arc(cx, cy, 340 * k, 0, Math.PI * 2); g.fill();
    g.font = '10px ' + colors.mono;
    g.fillStyle = colors.muted;
    g.textAlign = 'center';
    for (let a = 0; a < 360; a += 30) {
      const [x1, y1] = P(345, a), [x2, y2] = P(360, a);
      line(g, [[x1, y1], [x2, y2]], 1, colors.strong);
    }
    [[180, '180'], [90, '90'], [270, '270'], [0, '0']].forEach(([a, t]) => { const [x, y] = P(360 + 0, a); g.fillText(t, x + (a === 90 ? 12 : a === 270 ? -12 : 0), y + (a === 180 ? -4 : a === 0 ? 12 : 3)); });
    g.textAlign = 'start';

    // цель
    const [gx, gy] = P(st.target.x, st.target.angel);
    line(g, [[cx, cy], [gx, gy]], 1.5, colors.goal, [5, 4]);
    dot(g, gx, gy, 4, colors.goal);

    // факт
    const j = Kin.joints(shown);
    const [ax, ay] = P(j.t.x, shown.angle);
    line(g, [[cx, cy], [ax, ay]], 5, colors.text);
    // поворот схвата — короткая перемычка на конце
    const roll = ((shown.angle - 90 + (shown.pov - 150)) * Math.PI) / 180;
    const rx = Math.cos(roll + Math.PI / 2) * 9, ry = -Math.sin(roll + Math.PI / 2) * 9;
    line(g, [[ax - rx, ay - ry], [ax + rx, ay + ry]], 3, colors.text);
    dot(g, cx, cy, 9, colors.bg, colors.text, 2);
  }

  function renderReadout() {
    const j = Kin.joints(shown);
    const has = [1, 2, 3].every((i) => Number.isFinite(st.pos[i]));
    $('#ro-x').textContent = has ? Math.round(j.t.x) : '—';
    $('#ro-z').textContent = has ? Math.round(j.t.z) : '—';
    $('#ro-a').textContent = has ? Math.round(shown.angle) + '°' : '—';
    $('#ro-g').textContent = Number.isFinite(st.pos[6]) ? (shown.grip > 0.5 ? 'откр.' : 'закр.') : '—';
  }

  let lastT = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    const moving = stepAnimation(dt);
    if (moving) {
      const t = Kin.joints(shown).t;
      const last = trail[trail.length - 1];
      if (!last || Math.hypot(last.x - t.x, last.z - t.z) > 2) { trail.push({ x: t.x, z: t.z }); if (trail.length > 300) trail.shift(); }
    }
    if (moving || dirty) {
      drawSide();
      drawTop();
      renderReadout();
      dirty = false;
    }
    requestAnimationFrame(frame);
  }

  // Клик / перетаскивание по схемам
  function bindPointer(cv, pick) {
    let drag = false;
    cv.addEventListener('pointerdown', (e) => { drag = true; cv.setPointerCapture(e.pointerId); pick(e, false); });
    cv.addEventListener('pointermove', (e) => drag && pick(e, false));
    cv.addEventListener('pointerup', (e) => { if (drag) { drag = false; pick(e, true); } });
    cv.addEventListener('pointercancel', () => { drag = false; });
  }

  bindPointer(cvSide, (e, commit) => {
    const r = cvSide.getBoundingClientRect();
    const m = sideMap(r.width, r.height);
    const x = Math.round(m.x(e.clientX - r.left));
    const z = Math.round(m.z(e.clientY - r.top));
    if (Kin.isReachable(x, z) && z >= S.zMin) setTarget({ x, z }, commit ? undefined : false);
  });

  bindPointer(cvTop, (e, commit) => {
    const r = cvTop.getBoundingClientRect();
    const dx = e.clientX - r.left - r.width / 2;
    const dy = r.height / 2 - (e.clientY - r.top);
    let a = Math.round((Math.atan2(dy, dx) * 180) / Math.PI + 90);
    if (a < 0) a += 360;
    setTarget({ angel: clamp(a, 0, 360) }, commit ? undefined : false);
  });

  window.addEventListener('resize', () => { dirty = true; });

  /* ================================ программы ================================ */

  const SAMPLE = {
    id: 'sample',
    name: 'pick_and_place',
    points: [
      [200, 200, 180, 150, true, 0], [250, 60, 140, 150, true, 0], [250, 20, 140, 150, true, 200],
      [250, 20, 140, 150, false, 300], [220, 160, 180, 150, false, 0], [250, 40, 220, 90, false, 0],
      [250, 40, 220, 90, true, 300], [200, 200, 180, 150, false, 0],
    ].map(([x, z, angel, pov_gripper, open, pauseMs]) => ({ id: uid(), x, z, angel, pov_gripper, open, pauseMs })),
  };

  const P = Object.assign({ programs: [SAMPLE], selected: 'sample' }, store.get('armbox.programs', {}));
  const run = { id: null, index: -1, loop: false, cycle: 0 };
  const saveProgs = () => store.set('armbox.programs', { programs: P.programs, selected: P.selected });
  const current = () => P.programs.find((p) => p.id === P.selected);

  function renderPrograms() {
    const list = $('#prog-list');
    list.innerHTML = P.programs.length
      ? P.programs.map((p) => '<li data-id="' + p.id + '" class="' + (p.id === P.selected ? 'on' : '') + '">' +
          '<span class="n">' + esc(p.name) + '</span>' +
          '<span class="c">' + (run.id === p.id ? '▶ ' : '') + p.points.length + '</span></li>').join('')
      : '<li class="empty">Нет программ</li>';

    const p = current();
    $('#prog-detail').hidden = !p;
    if (!p) return;
    const running = run.id === p.id;
    $('#prog-name').textContent = p.name;
    $('#prog-meta').textContent = running ? 'цикл ' + run.cycle + ' · точка ' + (run.index + 1) + '/' + p.points.length : p.points.length + ' точ.';
    const btn = $('#prog-run');
    btn.textContent = running ? 'Стоп' : 'Запустить';
    btn.disabled = !running && (!p.points.length || !!run.id);
    $('#prog-loop').checked = run.loop;
    $('#point-add').disabled = running;

    const lock = !!run.id;
    $('#points').innerHTML = p.points.map((w, i) =>
      '<li data-id="' + w.id + '" class="' + (running && run.index === i ? 'active' : '') + '">' +
        '<div><div>x ' + w.x + ' · z ' + w.z + ' · ' + w.angel + '°</div>' +
        '<div class="meta">' + (w.open ? 'открыт' : 'закрыт') + ' · ⟳' + w.pov_gripper + '° · ⏱ ' +
        '<input class="pause" value="' + w.pauseMs + '" inputmode="numeric" aria-label="Пауза, мс"> мс</div></div>' +
        '<div class="acts">' +
          '<button data-act="go" title="Перейти в точку"' + (lock ? ' disabled' : '') + '>⌖</button>' +
          '<button data-act="set" title="Перезаписать текущей целью"' + (lock ? ' disabled' : '') + '>✎</button>' +
          '<button data-act="up" title="Выше"' + (lock || i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button data-act="down" title="Ниже"' + (lock || i === p.points.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button data-act="del" title="Удалить"' + (lock ? ' disabled' : '') + '>×</button>' +
        '</div></li>').join('') || '';
    if (!p.points.length) $('#points').innerHTML = '<li class="meta" style="display:block">Пусто. Задайте цель на вкладке «Управление» и добавьте её сюда.</li>';
  }

  $('#prog-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    P.selected = li.dataset.id;
    saveProgs();
    renderPrograms();
  });

  $('#prog-new').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = e.target.elements.name;
    const p = { id: uid(), name: input.value.trim() || 'program_' + (P.programs.length + 1), points: [] };
    P.programs.push(p);
    P.selected = p.id;
    input.value = '';
    saveProgs();
    renderPrograms();
  });

  $('#points').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    const p = current();
    if (!b || !p) return;
    const id = b.closest('li').dataset.id;
    const i = p.points.findIndex((w) => w.id === id);
    const w = p.points[i];
    const act = b.dataset.act;
    if (act === 'go') setTarget({ x: w.x, z: w.z, angel: w.angel, pov_gripper: w.pov_gripper, open: w.open }, true);
    if (act === 'set') { Object.assign(w, { x: st.target.x, z: st.target.z, angel: st.target.angel, pov_gripper: st.target.pov_gripper, open: st.target.open }); toast('Точка ' + (i + 1) + ' обновлена'); }
    if (act === 'up' && i > 0) [p.points[i - 1], p.points[i]] = [p.points[i], p.points[i - 1]];
    if (act === 'down' && i < p.points.length - 1) [p.points[i + 1], p.points[i]] = [p.points[i], p.points[i + 1]];
    if (act === 'del') p.points.splice(i, 1);
    saveProgs();
    renderPrograms();
  });

  $('#points').addEventListener('change', (e) => {
    if (!e.target.classList.contains('pause')) return;
    const p = current();
    const w = p && p.points.find((x) => x.id === e.target.closest('li').dataset.id);
    if (w) { w.pauseMs = Math.max(0, Math.round(Number(e.target.value) || 0)); e.target.value = w.pauseMs; saveProgs(); }
  });
  $('#points').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('pause')) e.target.blur(); });

  $('#point-add').addEventListener('click', () => {
    const p = current();
    if (!p) return;
    const t = st.target;
    p.points.push({ id: uid(), x: t.x, z: t.z, angel: t.angel, pov_gripper: t.pov_gripper, open: !!t.open, pauseMs: 0 });
    saveProgs();
    renderPrograms();
    toast('Точка добавлена');
  });

  $('#prog-loop').addEventListener('change', (e) => { run.loop = e.target.checked; });

  $('#prog-rename').addEventListener('click', () => {
    const p = current();
    const name = p && prompt('Название программы', p.name);
    if (name && name.trim()) { p.name = name.trim(); saveProgs(); renderPrograms(); }
  });
  $('#prog-dup').addEventListener('click', () => {
    const p = current();
    if (!p) return;
    const copy = { id: uid(), name: p.name + '_copy', points: p.points.map((w) => Object.assign({}, w, { id: uid() })) };
    P.programs.push(copy);
    P.selected = copy.id;
    saveProgs();
    renderPrograms();
  });
  $('#prog-del').addEventListener('click', () => {
    const p = current();
    if (!p || !confirm('Удалить программу «' + p.name + '»?')) return;
    if (run.id === p.id) run.id = null;
    P.programs = P.programs.filter((x) => x !== p);
    P.selected = P.programs[0] ? P.programs[0].id : null;
    saveProgs();
    renderPrograms();
  });

  const exportable = (p) => ({ name: p.name, points: p.points.map(({ x, z, angel, pov_gripper, open, pauseMs }) => ({ x, z, angel, pov_gripper, open, pauseMs })) });
  $('#prog-export').addEventListener('click', () => download('programs.json', JSON.stringify(P.programs.map(exportable), null, 2)));
  $('#prog-import').addEventListener('click', () => $('#prog-file').click());
  $('#prog-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const list = (Array.isArray(data) ? data : [data]).filter((r) => r && typeof r.name === 'string' && Array.isArray(r.points));
      if (!list.length) throw new Error('в файле нет программ');
      list.forEach((r) => P.programs.push({
        id: uid(),
        name: r.name,
        points: r.points.map((w) => ({ id: uid(), x: +w.x || 0, z: +w.z || 0, angel: +w.angel || 180, pov_gripper: +w.pov_gripper || 150, open: !!w.open, pauseMs: +w.pauseMs || 0 })),
      }));
      P.selected = P.programs[P.programs.length - 1].id;
      saveProgs();
      renderPrograms();
      toast('Импортировано программ: ' + list.length);
    } catch (err) {
      toast('Не удалось импортировать: ' + err.message, 'error');
    }
  });

  $('#prog-run').addEventListener('click', () => {
    const p = current();
    if (!p) return;
    if (run.id === p.id) { run.id = null; renderPrograms(); return; }
    play(p);
  });

  async function play(p) {
    if (st.busy) return toast('Манипулятор занят');
    const bad = p.points.findIndex((w) => validate(w));
    if (bad >= 0) return toast('Точка ' + (bad + 1) + ': ' + validate(p.points[bad]), 'error');

    Object.assign(run, { id: p.id, index: 0, cycle: 1 });
    st.programRunning = true;
    addLog('info', 'Старт программы «' + p.name + '» (' + p.points.length + ' точ.)');
    renderPrograms();

    let i = 0;
    let failed = false;
    while (run.id === p.id) {
      if (i >= p.points.length) {
        if (!run.loop || !p.points.length) break;
        i = 0;
        run.cycle++;
      }
      const w = p.points[i];
      run.index = i;
      renderPrograms();
      Object.assign(st.target, { x: w.x, z: w.z, angel: w.angel, pov_gripper: w.pov_gripper, open: w.open });
      renderControl();
      if (!(await execute(w))) { failed = true; addLog('error', 'Программа остановлена на точке ' + (i + 1)); break; }
      if (w.pauseMs > 0) await new Promise((r) => setTimeout(r, w.pauseMs));
      i++;
    }
    const byUser = run.id !== p.id;
    run.id = null;
    run.index = -1;
    st.programRunning = false;
    renderPrograms();
    renderControl();
    if (byUser) addLog('warn', 'Программа «' + p.name + '» остановлена');
    else if (!failed) { addLog('ok', 'Программа «' + p.name + '» завершена'); toast('Программа завершена'); }
  }

  /* ================================ телеметрия ================================ */

  /** Протокол 1.0: биты 0–9 — величина (0..1023), бит 10 — направление */
  const loadPct = (raw) => ((raw & 1023) / 1023) * 100 * (raw & 1024 ? -1 : 1);

  function spark(svg, values, color) {
    if (values.length < 2) { svg.innerHTML = ''; return; }
    const lo = Math.min(...values), hi = Math.max(...values);
    const span = hi - lo || 1;
    const d = values.map((v, i) => (i ? 'L' : 'M') + ((i / (values.length - 1)) * 300).toFixed(1) + ',' + (56 - ((v - lo) / span) * 50).toFixed(1)).join(' ');
    svg.innerHTML = '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/>' +
      '<text x="298" y="10" text-anchor="end" font-size="10" fill="' + colors.muted + '" font-family="' + esc(colors.mono) + '">' + Math.round(values[values.length - 1]) + '</text>';
  }

  function renderTelemetry() {
    dirty = true;
    if (S.tab !== 'telemetry') return;
    $('#tele-time').textContent = st.updatedAt ? 'обновлено ' + timeStr(st.updatedAt) : 'нет данных';
    $('#tele-body').innerHTML = MOTORS.map((m) => {
      const pos = st.pos[m.id], t = st.temp[m.id], l = st.load[m.id];
      const has = Number.isFinite(pos);
      const tc = t >= 65 ? 't-crit' : t >= 55 ? 't-warn' : '';
      return '<tr><td class="id">' + m.id + '</td>' +
        '<td>' + m.name + '<span class="sub">' + (has ? ((pos / m.ticks) * m.deg).toFixed(1) + '°' : '—') + '</span></td>' +
        '<td class="r">' + (has ? pos : '—') + '</td>' +
        '<td class="r ' + tc + '">' + (Number.isFinite(t) ? t : '—') + '</td>' +
        '<td class="r">' + (Number.isFinite(l) ? Math.round(loadPct(l)) + '%' : '—') + '</td></tr>';
    }).join('');
    const maxT = st.history.map((h) => Math.max(...Object.values(h.temp)));
    const maxL = st.history.map((h) => Math.max(...Object.values(h.load).map((v) => Math.abs(loadPct(v)))));
    spark($('#spark-temp'), maxT.filter(Number.isFinite), colors.text);
    spark($('#spark-load'), maxL.filter(Number.isFinite), colors.goal);
  }

  function renderLog() {
    if (S.tab !== 'telemetry') return;
    $('#log').innerHTML = st.log.slice(0, 120).map((l) => '<li class="' + l.level + '"><span>' + timeStr(l.t) + '</span><span>' + esc(l.text) + '</span></li>').join('') ||
      '<li><span></span><span class="muted">Событий нет</span></li>';
  }

  $('#log-clear').addEventListener('click', () => { st.log = []; renderLog(); });
  $('#log-save').addEventListener('click', () => download('armbox-log.txt', st.log.slice().reverse().map((l) => new Date(l.t).toISOString() + '\t' + l.level + '\t' + l.text).join('\n'), 'text/plain'));

  /* ================================ консоль API ================================ */

  function fillApiBodies() {
    const cmd = Driver.normalize(toCommand(st.target));
    $('#api-body-set').value = JSON.stringify(cmd, null, 2);
    $('#api-body-ws').value = JSON.stringify(Object.assign({ command: 'exec' }, cmd), null, 2);
  }

  function apiPrint(title, ok, ms, body) {
    const out = $('#api-out');
    if (out.textContent === '—') out.innerHTML = '';
    const text = typeof body === 'string' ? body : Array.isArray(body) ? JSON.stringify(body) : JSON.stringify(body, null, 2);
    const block = '<span class="dim">' + timeStr(Date.now()) + '  ' + esc(title) + '  ·  ' + ms + ' мс</span>\n' +
      '<span class="' + (ok ? 'ok' : 'bad') + '">' + (ok ? '✓' : '✗') + '</span> ' + esc(text) + '\n\n';
    out.innerHTML = block + out.innerHTML;
  }

  async function apiCall(kind) {
    const u = urls();
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    try {
      if (kind === 'pos' || kind === 'temp' || kind === 'load') {
        const raw = await Driver.request(u.api + '/' + kind);
        apiPrint('GET /api/motors/' + kind + '  200', true, ms(), raw);
        // попутно обновим телеметрию в интерфейсе
        st[kind] = Driver.asDict(raw);
        dirty = true;
      } else if (kind === 'speed-get') {
        const res = await Driver.request(u.api + '/speed');
        apiPrint('GET /api/motors/speed', true, ms(), res);
        if (res && Number.isFinite(+res.speed)) { st.speed = +res.speed; st.speedSupported = true; renderSpeed(); }
      } else if (kind === 'speed-set') {
        const body = JSON.parse($('#api-body-speed').value);
        const res = await Driver.request(u.api + '/speed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        });
        apiPrint('POST /api/motors/speed', true, ms(), res);
        if (Number.isFinite(+body.speed)) { st.speed = +body.speed; st.speedSupported = true; renderSpeed(); }
      } else if (kind === 'set') {
        const body = JSON.parse($('#api-body-set').value);
        const err = validate({ x: body.x, z: body.z, angel: body.angel, pov_gripper: body.pov_gripper, open: true });
        if (err && !confirm(err + '. Всё равно отправить?')) return;
        const res = await Driver.request(u.api + '/pos/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        }, 120000);
        apiPrint('POST /api/motors/pos/set', true, ms(), res);
      } else if (kind === 'ws') {
        const payload = JSON.parse($('#api-body-ws').value);
        const err = validate({ x: payload.x, z: payload.z, angel: payload.angel, pov_gripper: payload.pov_gripper, open: true });
        if (err && !confirm(err + '. Всё равно отправить?')) return;
        const reply = await new Promise((resolve, reject) => {
          const ws = new WebSocket(u.ws);
          const timer = setTimeout(() => { ws.close(); reject(new Error('нет ответа за 60 с')); }, 60000);
          ws.onopen = () => ws.send(JSON.stringify(payload));
          ws.onmessage = (e) => { clearTimeout(timer); ws.close(); resolve(JSON.parse(e.data)); };
          ws.onerror = () => { clearTimeout(timer); reject(new Error('не удалось подключиться к ' + u.ws)); };
        });
        apiPrint('WS /ws', reply && reply.status === 'ok', ms(), reply);
      }
    } catch (e) {
      const titles = { ws: 'WS /ws', set: 'POST /api/motors/pos/set', 'speed-get': 'GET /api/motors/speed', 'speed-set': 'POST /api/motors/speed' };
      apiPrint(titles[kind] || 'GET /api/motors/' + kind, false, ms(), e.message);
    }
  }

  $$('[data-api]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    await apiCall(b.dataset.api);
    b.disabled = false;
  }));
  $('#api-fill').addEventListener('click', fillApiBodies);
  $('#api-clear').addEventListener('click', () => { $('#api-out').textContent = '—'; });

  /* ================================ настройки ================================ */

  function renderSettings() {
    $('#s-demo').checked = S.demo;
    const host = $('#s-host'), port = $('#s-port'), mode = $('#s-mode');
    if (proxy.kind === 'serve') { host.value = proxy.host; port.value = proxy.port; }
    else if (proxy.kind === 'nginx') {
      try { const u = new URL(proxy.url); host.value = u.hostname; port.value = u.port || 80; } catch (_) { host.value = proxy.url || ''; port.value = ''; }
    } else { host.value = S.host; port.value = S.port; }
    host.disabled = port.disabled = proxy.kind === 'nginx';
    mode.textContent = proxy.kind === 'serve'
      ? 'Через прокси serve.py — CORS не нужен.'
      : proxy.kind === 'nginx'
        ? 'Задаётся переменной BACKEND_URL в docker-compose (nginx).'
        : 'Прямое подключение: backend должен разрешать CORS (см. README). Проще запустить serve.py.';
    $('#s-poll').value = S.pollMs;
    $('#s-zmin').value = S.zMin;
    $$('#s-transport button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.transport));
    $$('#s-grip button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.gripTrue));
  }

  $('#s-demo').addEventListener('change', (e) => { S.demo = e.target.checked; saveSettings(); startDriver(); });
  $('#banner-demo').addEventListener('click', () => { S.demo = true; saveSettings(); renderSettings(); startDriver(); });
  $('#s-transport').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.transport = b.dataset.v;
    saveSettings();
    renderSettings();
    startDriver();
  });
  $('#s-grip').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.gripTrue = b.dataset.v;
    saveSettings();
    renderSettings();
    renderControl();
  });
  /** Прочитать и проверить IP и порт из полей */
  function readAddr() {
    const host = $('#s-host').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || '127.0.0.1';
    const port = +($('#s-port').value.trim() || 8000);
    if (!/^[\w.\-]+$/.test(host)) throw new Error('Некорректный IP-адрес');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Порт должен быть от 1 до 65535');
    return { host, port };
  }

  $('#s-apply').addEventListener('click', async () => {
    let addr;
    try { addr = readAddr(); } catch (e) { toast(e.message, 'error'); return; }
    if (proxy.kind !== 'nginx') {
      S.host = addr.host;
      S.port = String(addr.port);
      if (proxy.kind === 'serve') {
        try { await pushBackend(addr.host, addr.port); } catch (e) { toast('Прокси не принял адрес: ' + e.message, 'error'); return; }
      }
    }
    S.pollMs = clamp(Math.round(+$('#s-poll').value) || 1000, 200, 10000);
    S.zMin = clamp(Math.round(+$('#s-zmin').value) || 0, -100, 300);
    saveSettings();
    renderSettings();
    renderControl();
    startDriver();
    toast('Настройки применены');
  });
  $('#s-reset').addEventListener('click', () => {
    if (!confirm('Сбросить настройки?')) return;
    const theme = S.theme;
    Object.assign(S, DEFAULTS, { theme, tab: 'settings' });
    saveSettings();
    renderSettings();
    renderControl();
    startDriver();
  });
  $('#s-test').addEventListener('click', async () => {
    const out = $('#s-result');
    let addr;
    try { addr = readAddr(); } catch (e) { out.hidden = false; out.className = 'small error'; out.textContent = '✗ ' + e.message; return; }
    // через serve.py проверяем указанный адрес, временно переключив прокси
    const prev = proxy.kind === 'serve' ? { host: proxy.host, port: proxy.port } : null;
    const savedHost = S.host, savedPort = S.port;
    if (proxy.kind === 'none') { S.host = addr.host; S.port = String(addr.port); }
    if (prev) { try { await pushBackend(addr.host, addr.port); } catch (_) { /* покажем ошибку ниже */ } }
    const u = urls();
    S.host = savedHost; S.port = savedPort;
    out.hidden = false;
    out.className = 'small muted';
    out.textContent = 'Проверка…';
    const d = new Driver.RealDriver(u.api, u.ws);
    const t0 = performance.now();
    try {
      const pos = await d.getPos();
      const ms = Math.round(performance.now() - t0);
      const wsOk = await new Promise((res) => {
        let done = false;
        d.onWs((s) => { if (!done && (s === 'open' || s === 'closed')) { done = true; res(s === 'open'); } });
        d.connect();
        setTimeout(() => { if (!done) { done = true; res(false); } }, 4000);
      });
      out.className = 'small';
      let speedTxt = '';
      try { const sp = await d.getSpeed(); speedTxt = ' · скорость: ' + sp + ' %'; } catch (e) { speedTxt = isNotFound(e) ? ' · метода скорости нет (нужен патч)' : ''; }
      out.textContent = '✓ ' + addr.host + ':' + addr.port + ' · REST: ' + Object.keys(pos).length + ' моторов, ' + ms + ' мс · WebSocket: ' + (wsOk ? 'доступен' : 'недоступен') + speedTxt;
    } catch (e) {
      out.className = 'small error';
      out.textContent = '✗ ' + e.message;
    } finally {
      d.dispose();
      if (prev) { try { await pushBackend(prev.host, prev.port); } catch (_) { /* ignore */ } }
    }
  });

  /* ============================== вкладки и тема ============================== */

  function showTab(tab) {
    S.tab = tab;
    saveSettings();
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $$('.pane').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
    if (tab === 'programs') renderPrograms();
    if (tab === 'telemetry') { renderTelemetry(); renderLog(); }
    if (tab === 'settings') renderSettings();
    if (tab === 'api') {
      const u = urls();
      $('#api-base').textContent = backendAddr() + (u.api.startsWith('/') ? ' · через прокси' : '');
      if (!$('#api-body-set').value) fillApiBodies();
    }
  }
  $('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });

  function applyTheme() {
    document.documentElement.dataset.theme = S.theme;
    readColors();
    renderTelemetry();
  }
  $('#theme').addEventListener('click', () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; saveSettings(); applyTheme(); });

  /* ================================== старт ================================== */

  applyTheme();
  showTab(S.tab || 'control');
  renderControl();
  renderSpeed();
  requestAnimationFrame(frame);
  (async () => {
    await detectProxy();
    // адрес, сохранённый в браузере, передаём прокси serve.py
    if (proxy.kind === 'serve' && S.host && (S.host !== proxy.host || portOf() !== proxy.port)) {
      try { await pushBackend(hostOf(), portOf()); } catch (_) { /* ignore */ }
    }
    if (S.tab === 'settings') renderSettings();
    startDriver();
  })();
})();
