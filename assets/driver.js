/*
 * Связь с backend (REST + WebSocket) и демо-симулятор.
 * Оба драйвера имеют одинаковый интерфейс:
 *   getPos() getTemp() getLoad() -> Promise<{id: value}>
 *   move(cmd, via)                -> Promise, резолвится после завершения движения
 *   onWs(cb) connect() dispose()
 */
(function () {
  'use strict';

  /** [{"1": 2048}, {"2": 2051}] -> {1: 2048, 2: 2051} */
  function asDict(items) {
    if (!Array.isArray(items)) throw new Error('Неожиданный формат ответа');
    const out = {};
    for (const item of items) for (const [k, v] of Object.entries(item)) if (Number.isFinite(+v)) out[+k] = +v;
    return out;
  }

  /** Backend принимает только целые числа (pydantic int) */
  function normalize(c) {
    return {
      x: Math.round(c.x),
      z: Math.round(c.z),
      angel: Math.round(c.angel),
      pov_gripper: Math.round(c.pov_gripper),
      gripper_state: !!c.gripper_state,
    };
  }

  const lampBody = (s) => ({ red: !!s.red, yellow: !!s.yellow, green: !!s.green, blue: !!s.blue });

  async function request(url, init, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, Object.assign({ signal: ctrl.signal, headers: { accept: 'application/json' } }, init));
      const text = await res.text();
      let body = text;
      try { body = text ? JSON.parse(text) : null; } catch (_) { /* не JSON */ }
      if (!res.ok) {
        const d = body && body.detail ? (typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)) : res.statusText;
        if (res.status === 404 && /\/api\/motors/.test(url) && !/detail/.test(text)) {
          throw new Error('по этому адресу нет backend — запустите serve.py или укажите адрес API в настройках');
        }
        throw new Error('HTTP ' + res.status + ': ' + d);
      }
      return body;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Таймаут запроса');
      if (e instanceof TypeError) {
        const cross = /^https?:/.test(url) && !url.startsWith(location.origin + '/');
        throw new Error(cross ? 'нет ответа от ' + url.replace(/\/api\/motors.*$/, '') + ' (backend выключен или не разрешает CORS)' : 'нет связи с контроллером');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------ Реальный backend ------------------------------ */

  class RealDriver {
    constructor(api, wsUrl, lampUrl, moveTimeoutMs = 60000) {
      this.kind = 'real';
      this.api = api;
      this.lampUrl = lampUrl;
      this.wsUrl = wsUrl;
      this.moveTimeoutMs = moveTimeoutMs;
      this.ws = null;
      this.pending = []; // ответы WS приходят строго по порядку и без id → FIFO
      this.listeners = new Set();
      this.state = 'idle';
      this.retry = 0;
      this.disposed = false;
    }

    getPos() { return request(this.api + '/pos').then(asDict); }
    getTemp() { return request(this.api + '/temp').then(asDict); }
    getLoad() { return request(this.api + '/load').then(asDict); }

    /** Скорость, % (1–100). Требует метода /api/motors/speed в backend (см. backend-patch). */
    async getSpeed() {
      const r = await request(this.api + '/speed');
      return Number(r && r.speed);
    }
    async setSpeed(speed) {
      await request(this.api + '/speed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ speed: Math.round(speed) }),
      });
    }

    /** Лампа: PUT http://{ip}/api/lamp {red, yellow, green, blue} */
    async setLamp(state) {
      return request(this.lampUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(lampBody(state)),
      }, 5000);
    }

    async move(raw, via) {
      const cmd = normalize(raw);
      if (via === 'ws' && this.ws && this.ws.readyState === WebSocket.OPEN) return this._moveWs(cmd);
      await request(this.api + '/pos/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(cmd),
      }, this.moveTimeoutMs);
    }

    _moveWs(cmd) {
      return new Promise((resolve, reject) => {
        const p = { resolve, reject };
        p.timer = setTimeout(() => {
          this.pending = this.pending.filter((x) => x !== p);
          reject(new Error('Нет подтверждения завершения движения (таймаут)'));
        }, this.moveTimeoutMs);
        this.pending.push(p);
        this.ws.send(JSON.stringify(Object.assign({ command: 'exec' }, cmd)));
      });
    }

    onWs(cb) { this.listeners.add(cb); cb(this.state); }
    _emit(s) { this.state = s; this.listeners.forEach((l) => l(s)); }

    connect() {
      if (this.disposed || (this.ws && this.ws.readyState <= 1)) return;
      this._emit('connecting');
      let ws;
      try { ws = new WebSocket(this.wsUrl); } catch (_) { this._emit('closed'); return this._reconnect(); }
      this.ws = ws;
      ws.onopen = () => { this.retry = 0; this._emit('open'); };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        const p = this.pending.shift();
        if (!p) return;
        clearTimeout(p.timer);
        if (msg.status === 'ok') p.resolve();
        else p.reject(new Error(msg.message || msg.error || 'Ошибка выполнения движения'));
      };
      ws.onclose = () => {
        this.ws = null;
        this._failAll('Соединение WebSocket закрыто');
        this._emit('closed');
        this._reconnect();
      };
      ws.onerror = () => ws.close();
    }

    _failAll(reason) {
      this.pending.splice(0).forEach((p) => { clearTimeout(p.timer); p.reject(new Error(reason)); });
    }

    _reconnect() {
      if (this.disposed) return;
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    }

    dispose() {
      this.disposed = true;
      clearTimeout(this.retryTimer);
      this._failAll('Драйвер отключён');
      if (this.ws) { this.ws.onclose = null; this.ws.close(); }
      this.listeners.clear();
    }
  }

  /* ------------------------------ Демо-симулятор ------------------------------ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class DemoDriver {
    constructor() {
      this.kind = 'demo';
      this.cur = Kin.targetTicks(200, 200, 180, 150, false);
      this.anim = null;
      this.temps = [34, 38, 37, 35, 33, 36];
      this.speed = 30;
      this.chain = Promise.resolve();
    }

    _sample() {
      if (!this.anim) return this.cur;
      const { from, to, t0, dur } = this.anim;
      const k = Math.min(1, (performance.now() - t0) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const v = from.map((f, i) => Math.round(f + (to[i] - f) * e));
      if (k >= 1) { this.cur = to; this.anim = null; }
      return v;
    }

    async getPos() {
      await sleep(20);
      const v = this._sample();
      return Object.fromEntries(v.map((t, i) => [i + 1, t]));
    }

    async getTemp() {
      await sleep(15);
      const moving = !!this.anim;
      this.temps = this.temps.map((t, i) => t + (34 + i * 1.3 + (moving ? 6 : 0) - t) * 0.05 + (Math.random() - 0.5) * 0.3);
      return Object.fromEntries(this.temps.map((t, i) => [i + 1, Math.round(t)]));
    }

    async getSpeed() { await sleep(10); return this.speed; }
    async setLamp(state) { await sleep(40); this.lamp = lampBody(state); return this.lamp; }
    async setSpeed(v) { await sleep(20); this.speed = Math.max(1, Math.min(100, Math.round(v))); }

    async getLoad() {
      await sleep(15);
      const moving = !!this.anim;
      const base = [8, 96, 152, 48, 0, 56];
      return Object.fromEntries(base.map((b, i) => {
        const mag = Math.max(0, Math.round(b * (moving ? 2.2 : 1) + (Math.random() - 0.3) * 20));
        return [i + 1, i % 2 ? mag | 1024 : mag]; // бит 10 — направление
      }));
    }

    move(raw) {
      const cmd = normalize(raw);
      const run = async () => {
        const to = Kin.targetTicks(cmd.x, cmd.z, cmd.angel, cmd.pov_gripper, cmd.gripper_state);
        if (!to) throw new Error('Точка вне рабочей зоны');
        const from = this._sample();
        const delta = Math.max(...to.map((t, i) => Math.abs(t - from[i]) * (i >= 4 ? 4 : 1)));
        // скорость 30 % ≈ базовая длительность; выше — быстрее
        const dur = Math.max(150, Math.min(15000, (delta * 3.2 * 30) / this.speed));
        this.anim = { from, to, t0: performance.now(), dur };
        await sleep(dur + 20);
        this._sample();
      };
      const p = this.chain.then(run);
      this.chain = p.catch(() => {});
      return p;
    }

    onWs(cb) { cb('open'); }
    connect() {}
    dispose() {}
  }

  /* ------------------------------ Камера ------------------------------ */

  /**
   * Камера: POST /api/start, POST /api/stop, GET /api/status, GET /stream (MJPEG).
   * base — '/camera' (через прокси serve.py / nginx) или 'http://IP:порт' (напрямую).
   */
  class Camera {
    constructor(base) { this.base = base.replace(/\/+$/, ''); }
    start() { return request(this.base + '/api/start', { method: 'POST', headers: { accept: 'application/json' } }, 10000); }
    stop() { return request(this.base + '/api/stop', { method: 'POST', headers: { accept: 'application/json' } }, 10000); }
    async status() {
      const raw = await request(this.base + '/api/status', undefined, 5000);
      return { raw, running: cameraRunning(raw) };
    }
    streamUrl() { return this.base + '/stream?t=' + Date.now(); }
  }

  /** Формат ответа /api/status заранее не известен — понимаем распространённые варианты */
  function cameraRunning(r) {
    if (typeof r === 'boolean') return r;
    if (typeof r === 'string') return /run|start|on|active|stream|true|ok/i.test(r) && !/stop|off|idle|false/i.test(r);
    if (!r || typeof r !== 'object') return null;
    for (const k of ['running', 'is_running', 'active', 'streaming', 'started', 'enabled', 'on']) {
      if (typeof r[k] === 'boolean') return r[k];
    }
    for (const k of ['status', 'state']) {
      if (typeof r[k] === 'string') return cameraRunning(r[k]);
      if (typeof r[k] === 'boolean') return r[k];
    }
    return null;
  }

  window.Driver = { RealDriver, DemoDriver, Camera, cameraRunning, asDict, normalize, request, lampBody };
})();
