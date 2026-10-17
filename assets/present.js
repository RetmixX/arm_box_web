/*
 * ARM·BOX — версия для показа: джойстики, схват, лампа, скорость.
 * Настройки подключения общие с отладочной версией (debug.html).
 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ------------------------------ настройки ------------------------------ */

  const KEY = 'armbox.settings';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) { return {}; } };
  const saveLamp = (lamp) => {
    try { const all = load(); all.lamp = lamp; localStorage.setItem(KEY, JSON.stringify(all)); } catch (_) { /* ignore */ }
  };
  const S = Object.assign(
    { theme: '', host: '', port: '', camHost: '', camPort: '', page: 'control', demo: false, transport: 'ws', gripTrue: 'open', lampHost: '', lampPort: '', lamp: { red: false, yellow: false, green: false, blue: false } },
    load(),
  );
  if (/[?&]demo\b/.test(location.search)) S.demo = true;

  const LIMITS = { x: [10, 300], z: [10, 300], angel: [1, 360], pov_gripper: [1, 300] };
  const HOME = { x: 200, z: 200, angel: 180, pov_gripper: 150, open: false };

  /* ------------------------- адреса и прокси ------------------------- */

  let proxy = { kind: 'none' };
  const hostOf = () => (S.host || '').trim() || '127.0.0.1';
  const portOf = () => +S.port || 8000;

  async function detectProxy() {
    if (!/^https?:$/.test(location.protocol)) return;
    try {
      const r = await fetch('/__backend', { headers: { accept: 'application/json' } });
      const j = r.ok && /json/.test(r.headers.get('content-type') || '') ? await r.json() : null;
      if (j && j.proxy === 'serve.py') proxy = { kind: 'serve', host: j.host, port: j.port, camHost: j.cam_host, camPort: j.cam_port };
      else if (j && j.proxy === 'nginx') proxy = { kind: 'nginx', url: j.url, camUrl: j.cam_url };
    } catch (_) { /* без прокси */ }
    // адрес, сохранённый в отладочной версии, передаём прокси serve.py
    if (proxy.kind === 'serve' && (S.host || S.lampHost || S.lampPort || S.camHost)) {
      const body = { host: S.host ? hostOf() : proxy.host, port: S.host ? portOf() : proxy.port };
      if (S.lampHost || S.lampPort) { body.lamp_host = S.lampHost || ''; body.lamp_port = +S.lampPort || 80; }
      if (S.camHost) { body.cam_host = S.camHost; body.cam_port = +S.camPort || 8080; }
      try {
        const r = await fetch('/__backend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (r.ok) proxy = { kind: 'serve', host: j.host, port: j.port, camHost: j.cam_host, camPort: j.cam_port };
      } catch (_) { /* ignore */ }
    }
  }

  function backendAddr() {
    if (proxy.kind === 'serve') return proxy.host + ':' + proxy.port;
    if (proxy.kind === 'nginx') return String(proxy.url || '').replace(/^https?:\/\//, '');
    return hostOf() + ':' + portOf();
  }

  function urls() {
    if (proxy.kind !== 'none') {
      return { api: '/api/motors', ws: (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws', lamp: '/api/lamp' };
    }
    const lh = (S.lampHost || '').trim() || hostOf();
    const lp = +S.lampPort || 80;
    return {
      api: 'http://' + hostOf() + ':' + portOf() + '/api/motors',
      ws: 'ws://' + hostOf() + ':' + portOf() + '/ws',
      lamp: 'http://' + lh + (lp === 80 ? '' : ':' + lp) + '/api/lamp',
    };
  }

  /* ------------------------------ состояние ------------------------------ */

  const st = {
    driver: null,
    link: 'unknown',
    lastError: '',
    target: Object.assign({}, HOME),
    committed: null,
    busy: false,
    queued: false,
    pos: {},
    speed: null,
    speedSupported: null,
  };

  let toastTimer = null;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  const reachable = (t) => Kin.isReachable(t.x, t.z, t.angel);
  const command = (t) => ({
    x: t.x, z: t.z, angel: t.angel, pov_gripper: t.pov_gripper,
    gripper_state: S.gripTrue === 'open' ? !!t.open : !t.open,
  });

  async function execute() {
    if (!st.driver) return;
    if (st.busy) { st.queued = true; return; }
    const target = Object.assign({}, st.target);
    if (!reachable(target)) return;
    st.busy = true;
    st.queued = false;
    try {
      await st.driver.move(command(target), S.transport);
      st.committed = target;
    } catch (e) {
      toast('Команда не выполнена: ' + e.message);
    } finally {
      st.busy = false;
      if (st.queued) execute();
      render();
    }
  }

  function setTarget(patch) {
    Object.assign(st.target, patch);
    render();
    execute();
  }

  /* ------------------------------ драйвер ------------------------------ */

  let gen = 0;
  let pollTimer = null;

  function startDriver() {
    gen++;
    clearTimeout(pollTimer);
    if (st.driver) st.driver.dispose();
    const u = urls();
    const d = S.demo ? new Driver.DemoDriver() : new Driver.RealDriver(u.api, u.ws, u.lamp);
    const my = gen;
    Object.assign(st, { driver: d, link: 'unknown', pos: {}, busy: false, queued: false, speed: null, speedSupported: null });
    if (S.transport === 'ws' || S.demo) d.connect();

    const poll = async () => {
      if (my !== gen) return;
      try {
        const pos = await d.getPos();
        if (my !== gen) return;
        const first = st.link !== 'online';
        st.pos = pos;
        st.link = 'online';
        if (first) {
          if (!st.committed) seedTarget(pos);
          loadSpeed(d, my);
        }
      } catch (e) {
        if (my !== gen) return;
        st.link = 'offline';
        st.lastError = e.message;
      }
      render();
      pollTimer = setTimeout(poll, S.demo ? 120 : st.link === 'offline' ? 3000 : 400);
    };
    poll();
    render();
  }

  function seedTarget(pos) {
    if (![1, 2, 3].every((i) => Number.isFinite(pos[i]))) return;
    const p = Kin.poseFromTicks(pos);
    const j = Kin.joints(p);
    const t = {
      x: clamp(Math.round(j.t.x), ...LIMITS.x),
      z: clamp(Math.round(j.t.z), ...LIMITS.z),
      angel: clamp(Math.round(p.angle), ...LIMITS.angel),
      pov_gripper: clamp(Math.round(p.pov), ...LIMITS.pov_gripper),
    };
    if (Number.isFinite(pos[6])) {
      const isTrue = Math.abs(pos[6] - 370) < Math.abs(pos[6] - 710);
      t.open = S.gripTrue === 'open' ? isTrue : !isTrue;
    }
    if (reachable(t)) Object.assign(st.target, t);
  }

  async function loadSpeed(d, my) {
    try {
      const v = await d.getSpeed();
      if (my !== gen) return;
      st.speed = v;
      st.speedSupported = true;
    } catch (e) {
      if (my !== gen) return;
      st.speedSupported = /HTTP 404|нет backend/.test(e.message) ? false : null;
    }
    render();
  }

  /* ------------------------------ интерфейс ------------------------------ */

  function render() {
    const status = $('#status');
    const text = status.lastElementChild;
    if (S.demo) { status.className = 'status demo'; text.textContent = 'Демо'; }
    else if (st.link === 'online') { status.className = 'status ok'; text.textContent = st.busy ? 'Рука движется' : 'Рука подключена'; }
    else if (st.link === 'offline') { status.className = 'status bad'; text.textContent = 'Нет связи'; }
    else { status.className = 'status'; text.textContent = 'Подключение…'; }

    const off = st.link === 'offline' && !S.demo;
    $('#offline').hidden = !off;
    if (off) $('#offline-text').textContent = 'Пульт ищет её по адресу ' + backendAddr() + '. Проверьте, что backend запущен и рука включена.';

    const grip = $('#grip');
    grip.setAttribute('aria-pressed', String(!!st.target.open));
    $('#grip-text').textContent = st.target.open ? 'Закрыть схват' : 'Открыть схват';

    const sp = $('#speed');
    sp.classList.toggle('is-unsupported', st.speedSupported === false);
    const nearest = st.speed == null ? null : [10, 30, 60].reduce((a, b) => (Math.abs(b - st.speed) < Math.abs(a - st.speed) ? b : a));
    $$('#speed button').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.v === nearest)));

    $$('#lamp button').forEach((b) => b.setAttribute('aria-pressed', String(!!S.lamp[b.dataset.lamp])));

    const disabled = !st.driver || off;
    joyL.setDisabled(disabled);
    joyR.setDisabled(disabled);
    dirty = true;
  }

  $('#grip').addEventListener('click', () => setTarget({ open: !st.target.open }));
  $('#home').addEventListener('click', () => setTarget(Object.assign({}, HOME)));

  $('#speed').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !st.driver) return;
    const v = +b.dataset.v;
    const prev = st.speed;
    st.speed = v;
    render();
    try { await st.driver.setSpeed(v); } catch (err) { st.speed = prev; toast('Скорость не изменена: ' + err.message); render(); }
  });

  let lampBusy = false;
  $('#lamp').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-lamp]');
    if (!b || !st.driver || lampBusy) return;
    const next = Object.assign({}, S.lamp, { [b.dataset.lamp]: !S.lamp[b.dataset.lamp] });
    lampBusy = true;
    $$('#lamp button').forEach((x) => { x.disabled = true; });
    try {
      await st.driver.setLamp(next);
      S.lamp = Driver.lampBody(next);
      saveLamp(S.lamp);
    } catch (err) {
      toast('Лампа не отвечает: ' + err.message);
    } finally {
      lampBusy = false;
      $$('#lamp button').forEach((x) => { x.disabled = false; });
      render();
    }
  });

  $('#retry').addEventListener('click', () => startDriver());
  $('#go-demo').addEventListener('click', () => { S.demo = true; startDriver(); });
  $('#go-settings').addEventListener('click', () => {
    try { const all = load(); all.tab = 'settings'; localStorage.setItem(KEY, JSON.stringify(all)); } catch (_) { /* ignore */ }
  });

  $('#fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
  });

  /* ------------------------------ джойстики ------------------------------ */

  const joyL = Joy.stick($('#stick-left'), { labels: { up: 'выше', down: 'ниже', left: 'ближе', right: 'дальше' }, ariaLabel: 'Вылет и высота' });
  const joyR = Joy.stick($('#stick-right'), { labels: { up: 'схват +', down: 'схват −', left: 'влево', right: 'вправо' }, ariaLabel: 'Поворот базы и схвата' });
  const edges = Joy.buttonEdges();

  function joyTarget(t, a) {
    const lim = (k, v) => clamp(Math.round(v), LIMITS[k][0], LIMITS[k][1]);
    const MM = 14, DEG = 9;
    const next = {
      x: lim('x', t.x + a.lx * MM),
      z: lim('z', t.z + a.ly * MM),
      angel: lim('angel', t.angel - a.rx * DEG),
      pov_gripper: lim('pov_gripper', t.pov_gripper + a.ry * DEG),
    };
    if (!Kin.isReachable(next.x, next.z, next.angel)) {
      if (Kin.isReachable(next.x, t.z, next.angel)) next.z = t.z;
      else if (Kin.isReachable(t.x, next.z, next.angel)) next.x = t.x;
      else { next.x = t.x; next.z = t.z; }
    }
    return ['x', 'z', 'angel', 'pov_gripper'].some((k) => next[k] !== t[k]) ? next : null;
  }

  Joy.loop({
    interval: 60,
    read() {
      const pad = Joy.gamepad();
      if (pad) {
        const e = edges(pad.buttons);
        if (e[0]) setTarget({ open: !st.target.open });
        if (e[1]) setTarget(Object.assign({}, HOME));
      }
      const pick = (a, b) => (Math.abs(a) >= Math.abs(b) ? a : b);
      return {
        lx: pick(joyL.value.x, pad ? pad.left.x : 0),
        ly: pick(joyL.value.y, pad ? pad.left.y : 0),
        rx: pick(joyR.value.x, pad ? pad.right.x : 0),
        ry: pick(joyR.value.y, pad ? pad.right.y : 0),
      };
    },
    isBusy: () => st.busy || !st.driver || st.link === 'offline',
    apply(a) {
      const next = joyTarget(st.target, a);
      if (next) setTarget(next);
    },
  });

  /* ------------------------------ схема руки ------------------------------ */

  const cv = $('#cv');
  let dirty = true;
  let zoneKey = '';
  const C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    for (const k of ['alu', 'plate', 'rule', 'steel', 'ink', 'signal']) C[k] = v('--' + k);
    zoneKey = '';
    dirty = true;
  }
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = theme === 'dark' ? '#16191D' : '#E4E7EA';
    readColors();
  }
  $('#theme').addEventListener('click', () => {
    S.theme = S.theme === 'dark' ? 'light' : 'dark';
    try { const all = load(); all.theme = S.theme; localStorage.setItem(KEY, JSON.stringify(all)); } catch (_) { /* ignore */ }
    applyTheme(S.theme);
  });

  const shown = { angle: 180, shoulder: 0, elbow: 0, pov: 150, grip: 0 };
  let shownInit = false;
  const trail = [];
  let zone = null;

  function actual() {
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

  function map(w, h) {
    // мир: x −110…360 мм, z −10…430 мм; слева место под показания
    const left = w > 900 ? 210 : 20;
    const right = w > 900 ? 230 : 20;
    // на узком экране сверху — показания и два циферблата, рука ниже
    const top = w > 900 ? 24 : 80 + Math.min(72, w * 0.11) * 2 + 40;
    const X0 = -110, X1 = 360, Z0 = -10, Z1 = 430;
    const s = Math.min((w - left - right) / (X1 - X0), (h - top - 20) / (Z1 - Z0));
    const ox = left + ((w - left - right) - (X1 - X0) * s) / 2 - X0 * s;
    const oz = h - 20 - ((h - top - 20) - (Z1 - Z0) * s) / 2 + Z0 * s;
    return { s, X: (x) => ox + x * s, Z: (z) => oz - z * s };
  }

  function stroke(g, pts, width, color, dash, cap) {
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
    g.lineWidth = width; g.strokeStyle = color;
    g.lineCap = cap || 'round'; g.lineJoin = 'round';
    g.setLineDash(dash || []);
    g.stroke();
    g.setLineDash([]);
  }
  function disc(g, x, y, r, fill, ring, rw) {
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (ring) { g.lineWidth = rw || 2; g.strokeStyle = ring; g.stroke(); }
  }

  function buildZone(w, h, dpr, m) {
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = C.plate;
    const step = 3, cell = step * m.s + 0.7;
    for (let x = LIMITS.x[0]; x <= LIMITS.x[1]; x += step) {
      for (let z = LIMITS.z[0]; z <= LIMITS.z[1]; z += step) {
        if (Kin.isReachable(x, z)) g.fillRect(m.X(x) - cell / 2, m.Z(z) - cell / 2, cell, cell);
      }
    }
    return c;
  }

  function draw() {
    const r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    const m = map(r.width, r.height);
    const P = (p) => [m.X(p.x), m.Z(p.z)];

    // рабочая зона — светлая «пластина»
    const key = W + 'x' + H;
    if (zoneKey !== key) { zone = buildZone(r.width, r.height, dpr, m); zoneKey = key; }
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(zone, 0, 0); g.restore();

    // пол
    stroke(g, [[m.X(-110), m.Z(0)], [m.X(360), m.Z(0)]], 1.5, C.rule, null, 'butt');
    for (let x = -100; x <= 350; x += 50) stroke(g, [[m.X(x), m.Z(0)], [m.X(x), m.Z(0) + 6]], 1, C.rule, null, 'butt');

    // основание
    const B = Kin.GEOM.BASE_HEIGHT;
    const bw = 34 * m.s;
    g.fillStyle = C.ink;
    g.beginPath();
    if (g.roundRect) g.roundRect(m.X(0) - bw, m.Z(B), bw * 2, B * m.s, [10, 10, 0, 0]);
    else g.rect(m.X(0) - bw, m.Z(B), bw * 2, B * m.s);
    g.fill();
    g.fillRect(m.X(0) - bw * 1.6, m.Z(0) - 8, bw * 3.2, 8);

    // след схвата
    if (trail.length > 1) {
      g.globalAlpha = 0.35;
      stroke(g, trail.map((p) => [m.X(p.x), m.Z(p.z)]), 2, C.signal);
      g.globalAlpha = 1;
    }

    // цель
    const tp = Kin.poseFromTarget(st.target.x, st.target.z, st.target.angel, st.target.pov_gripper);
    if (tp) {
      const j = Kin.joints(tp);
      stroke(g, [P(j.s), P(j.e), P(j.w), P(j.t)], 1.5, C.steel, [6, 6]);
      disc(g, m.X(st.target.x), m.Z(st.target.z), 9, null, C.signal, 2.5);
    }

    // рука
    const j = Kin.joints(shown);
    const thick = Math.max(12, 26 * m.s);
    stroke(g, [P(j.s), P(j.e), P(j.w)], thick, C.signal);
    stroke(g, [P(j.w), P({ x: j.w.x, z: j.t.z + 48 })], thick * 0.62, C.signal);
    // губки: при повороте схвата видимое раскрытие меняется (проекция на плоскость схемы)
    const roll = ((shown.pov - 150) * Math.PI) / 180;
    const open = 4 + (3 + shown.grip * 20) * Math.max(0.12, Math.abs(Math.cos(roll)));
    for (const sgn of [-1, 1]) {
      stroke(g, [[m.X(j.w.x + sgn * open), m.Z(j.t.z + 48)], [m.X(j.w.x + sgn * open), m.Z(j.t.z)]], Math.max(4, 7 * m.s), C.ink);
    }
    stroke(g, [[m.X(j.w.x - open), m.Z(j.t.z + 48)], [m.X(j.w.x + open), m.Z(j.t.z + 48)]], Math.max(4, 7 * m.s), C.ink, null, 'butt');
    for (const p of [j.s, j.e, j.w]) {
      disc(g, m.X(p.x), m.Z(p.z), thick * 0.62, C.ink);
      disc(g, m.X(p.x), m.Z(p.z), thick * 0.2, C.plate);
    }
    // метка-«стрелка» на запястье поворачивается вместе со схватом
    {
      const wx = m.X(j.w.x), wz = m.Z(j.w.z), rr = thick * 0.5;
      stroke(g, [[wx, wz], [wx + Math.sin(roll) * rr, wz - Math.cos(roll) * rr]], Math.max(3, thick * 0.16), C.signal);
    }

    // справа два циферблата: поворот базы (вид сверху) и поворот схвата
    const wide = r.width > 900;
    const R = Math.min(72, r.width * 0.11);
    const R2 = R * 0.78;
    let cx, cy, cx2, cy2;
    if (wide) {
      const total = R * 2 + 26 + 34 + R2 * 2 + 26;
      cx = cx2 = r.width - R - 40;
      cy = (r.height - total) / 2 + R;
      cy2 = cy + R + 26 + 34 + R2;
    } else {
      cy = cy2 = 80 + R;
      cx2 = r.width - R2 - 24;
      cx = cx2 - R2 - R - 36;
    }
    const label = (text, x, y) => {
      g.fillStyle = C.steel;
      g.font = '13px Onest, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(text, x, y);
      g.textAlign = 'start';
    };

    // 1) поворот базы
    disc(g, cx, cy, R, C.plate, C.rule, 1);
    for (let a = 0; a < 360; a += 30) {
      const t = ((a - 90) * Math.PI) / 180;
      stroke(g, [[cx + Math.cos(t) * (R - 6), cy - Math.sin(t) * (R - 6)], [cx + Math.cos(t) * R, cy - Math.sin(t) * R]], 1, C.rule, null, 'butt');
    }
    const ang = (deg, len) => { const t = ((deg - 90) * Math.PI) / 180; return [cx + Math.cos(t) * len, cy - Math.sin(t) * len]; };
    stroke(g, [[cx, cy], ang(shown.angle, R * 0.82)], 6, C.signal);
    const [gx, gy] = ang(st.target.angel, R * 0.82);
    disc(g, gx, gy, 5, null, C.signal, 2);
    disc(g, cx, cy, 9, C.ink);
    label('вид сверху', cx, cy + R + 22);

    // 2) поворот схвата: схват «снизу», губки поворачиваются вместе с ним
    disc(g, cx2, cy2, R2, C.plate, C.rule, 1);
    // шкала рабочего диапазона 1…300° (дуга), 150° — вверх
    const povAng = (p) => -Math.PI / 2 + ((p - 150) * Math.PI) / 180;
    g.beginPath();
    g.arc(cx2, cy2, R2 - 5, povAng(1), povAng(300));
    g.lineWidth = 2; g.strokeStyle = C.rule; g.stroke();
    const tgt = povAng(st.target.pov_gripper);
    disc(g, cx2 + Math.cos(tgt) * (R2 - 5), cy2 + Math.sin(tgt) * (R2 - 5), 4.5, null, C.signal, 2);
    g.save();
    g.translate(cx2, cy2);
    g.rotate(roll);
    const gap = R2 * (0.12 + shown.grip * 0.22);
    const jawW = R2 * 0.16, jawH = R2 * 0.95;
    g.fillStyle = C.ink;
    for (const sgn of [-1, 1]) g.fillRect(sgn * gap + (sgn < 0 ? -jawW : 0), -jawH / 2, jawW, jawH);
    g.fillStyle = C.signal;
    g.beginPath(); g.arc(0, -jawH / 2 - 7, 4, 0, Math.PI * 2); g.fill(); // метка «верх» схвата
    g.restore();
    label('поворот схвата', cx2, cy2 + R2 + 22);

    // показания
    const has = [1, 2, 3].every((i) => Number.isFinite(st.pos[i]));
    $('#ro-x').textContent = has ? Math.round(j.t.x) : '—';
    $('#ro-z').textContent = has ? Math.round(j.t.z) : '—';
    $('#ro-a').textContent = has ? Math.round(shown.angle) : '—';
    $('#ro-p').textContent = Number.isFinite(st.pos[5]) ? Math.round(shown.pov) : '—';
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const a = actual();
    let moving = false;
    if (!shownInit) { Object.assign(shown, a); shownInit = true; moving = true; }
    const k = 1 - Math.exp(-9 * dt);
    for (const key of ['angle', 'shoulder', 'elbow', 'pov', 'grip']) {
      const d = a[key] - shown[key];
      if (Math.abs(d) > 1e-4) { shown[key] += d * k; moving = true; }
    }
    if (moving) {
      const t = Kin.joints(shown).t;
      const p = trail[trail.length - 1];
      if (!p || Math.hypot(p.x - t.x, p.z - t.z) > 2) { trail.push({ x: t.x, z: t.z }); if (trail.length > 160) trail.shift(); }
    }
    if (moving || dirty) { draw(); dirty = false; }
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', () => { dirty = true; });
  if (document.fonts) document.fonts.ready.then(() => { dirty = true; });

  /* ------------------------------ камера ------------------------------ */

  const camHostOf = () => (S.camHost || '').trim() || '192.168.0.105';
  const camPortOf = () => +S.camPort || 8080;
  function camAddr() {
    if (proxy.kind === 'serve') return proxy.camHost + ':' + proxy.camPort;
    if (proxy.kind === 'nginx') return String(proxy.camUrl || '').replace(/^https?:\/\//, '');
    return camHostOf() + ':' + camPortOf();
  }
  const camera = () => new Driver.Camera(proxy.kind !== 'none' ? '/camera' : 'http://' + camHostOf() + ':' + camPortOf());

  const cam = { running: null, live: false, busy: false, error: '', timer: null };
  const img = $('#cam-img');
  const toggle = $('#cam-toggle');

  function renderCam() {
    $('#cam-addr').textContent = 'Камера ' + camAddr();
    toggle.checked = !!cam.running;
    toggle.disabled = cam.busy;
    $('#cam-toggle-text').textContent = cam.busy
      ? (cam.running ? 'Выключаем…' : 'Включаем…')
      : cam.running ? 'Камера включена' : 'Камера выключена';
    img.hidden = !cam.live;
    $('#cam-live').hidden = !cam.live;
    $('#cam-empty').hidden = cam.live;
    if (cam.error) {
      $('#cam-title').textContent = 'Камера не отвечает';
      $('#cam-text').textContent = cam.error + ' Проверьте, что камера включена и доступна по адресу ' + camAddr() + '.';
    } else if (cam.running) {
      $('#cam-title').textContent = 'Подключаемся к потоку…';
      $('#cam-text').textContent = 'Изображение появится через пару секунд.';
    } else {
      $('#cam-title').textContent = 'Камера выключена';
      $('#cam-text').textContent = 'Включите её переключателем сверху.';
    }
  }

  function showStream() {
    img.onload = () => { cam.live = true; cam.error = ''; renderCam(); };
    img.onerror = () => { cam.live = false; renderCam(); };
    img.src = camera().streamUrl();
  }
  function hideStream() {
    img.onload = img.onerror = null;
    img.removeAttribute('src');
    cam.live = false;
  }

  async function refreshCam() {
    if (cam.busy) return;
    try {
      const s = await camera().status();
      cam.error = '';
      // формат статуса не распознан — считаем включённой, если поток отдаётся
      cam.running = s.running === null ? cam.running !== false : s.running;
    } catch (e) {
      cam.error = e.message.replace(/\.$/, '') + '.';
    }
    if (S.page === 'camera') {
      if (cam.running && !cam.error && !img.getAttribute('src')) showStream();
      if ((!cam.running || cam.error) && img.getAttribute('src')) hideStream();
    }
    renderCam();
  }

  toggle.addEventListener('change', async () => {
    const want = toggle.checked;
    cam.busy = true;
    cam.error = '';
    renderCam();
    try {
      if (want) {
        await camera().start();
        cam.running = true;
        await new Promise((r) => setTimeout(r, 600));
        hideStream();
        showStream();
      } else {
        hideStream();
        await camera().stop();
        cam.running = false;
      }
    } catch (e) {
      cam.error = (want ? 'Не удалось включить камеру: ' : 'Не удалось выключить камеру: ') + e.message.replace(/\.$/, '') + '.';
    } finally {
      cam.busy = false;
      renderCam();
    }
  });

  /* ------------------------------ вкладки ------------------------------ */

  function setPage(page) {
    S.page = page;
    try { const all = load(); all.page = page; localStorage.setItem(KEY, JSON.stringify(all)); } catch (_) { /* ignore */ }
    const onCam = page === 'camera';
    $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.page === page)));
    document.body.classList.toggle('page-camera', onCam);
    $('#stage').hidden = onCam;
    document.querySelector('.deck').hidden = onCam;
    $('#campage').hidden = !onCam;
    clearInterval(cam.timer);
    if (onCam) {
      joyL.reset(); joyR.reset();
      refreshCam();
      cam.timer = setInterval(refreshCam, 5000);
    } else {
      hideStream(); // поток грузим только на вкладке «Камера»
      dirty = true;
    }
    renderCam();
  }
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-page]'); if (b) setPage(b.dataset.page); });

  /* ------------------------------ старт ------------------------------ */

  applyTheme(S.theme || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  render();
  requestAnimationFrame(frame);
  detectProxy().then(() => { startDriver(); setPage(S.page === 'camera' ? 'camera' : 'control'); });
})();
