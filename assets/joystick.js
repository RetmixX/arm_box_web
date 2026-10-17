/*
 * Джойстики: экранные (мышь / палец) и физический геймпад (Gamepad API).
 * Без зависимостей. Используется и в презентационной, и в отладочной версии.
 *
 *   const stick = Joy.stick(element, { labels: { up, down, left, right } });
 *   stick.value  -> { x: -1..1, y: -1..1 }  (y > 0 — вверх)
 *
 *   Joy.gamepad() -> { left: {x, y}, right: {x, y}, buttons: [...] } | null
 *
 *   Joy.loop({ read, apply, isBusy, interval })
 *     каждые interval мс: если рука не занята и есть отклонение — вызывает apply(axes)
 */
(function () {
  'use strict';

  const DEAD = 0.12;

  /** Мёртвая зона + квадратичная кривая: точное движение у центра, быстрое у края */
  function shape(v) {
    const a = Math.abs(v);
    if (a < DEAD) return 0;
    const k = (a - DEAD) / (1 - DEAD);
    return Math.sign(v) * k * k;
  }

  function stick(root, opts = {}) {
    const labels = opts.labels || {};
    root.classList.add('joy');
    root.setAttribute('role', 'application');
    root.setAttribute('aria-label', opts.ariaLabel || 'Джойстик');
    root.tabIndex = 0;
    root.innerHTML =
      '<div class="joy-plate">' +
      '<span class="joy-lab joy-up">' + (labels.up || '') + '</span>' +
      '<span class="joy-lab joy-down">' + (labels.down || '') + '</span>' +
      '<span class="joy-lab joy-left">' + (labels.left || '') + '</span>' +
      '<span class="joy-lab joy-right">' + (labels.right || '') + '</span>' +
      '<div class="joy-thumb"></div>' +
      '</div>';
    const plate = root.querySelector('.joy-plate');
    const thumb = root.querySelector('.joy-thumb');
    const api = { value: { x: 0, y: 0 }, active: false };
    const keys = { x: 0, y: 0 };

    function set(x, y) {
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      api.value = { x, y };
      const r = plate.clientWidth / 2 - thumb.clientWidth / 2;
      thumb.style.transform = 'translate(' + (x * r).toFixed(1) + 'px,' + (-y * r).toFixed(1) + 'px)';
      root.classList.toggle('is-active', Math.abs(x) > DEAD || Math.abs(y) > DEAD);
    }

    let pid = null;
    function fromEvent(e) {
      const rect = plate.getBoundingClientRect();
      const r = rect.width / 2 - thumb.clientWidth / 4;
      set((e.clientX - rect.left - rect.width / 2) / r, -(e.clientY - rect.top - rect.height / 2) / r);
    }
    plate.addEventListener('pointerdown', (e) => {
      if (pid !== null) return;
      pid = e.pointerId;
      plate.setPointerCapture(pid);
      api.active = true;
      root.classList.add('is-held');
      fromEvent(e);
      e.preventDefault();
    });
    plate.addEventListener('pointermove', (e) => { if (e.pointerId === pid) fromEvent(e); });
    const release = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      api.active = false;
      root.classList.remove('is-held');
      set(0, 0);
    };
    plate.addEventListener('pointerup', release);
    plate.addEventListener('pointercancel', release);

    // клавиатура, когда джойстик в фокусе: стрелки
    root.addEventListener('keydown', (e) => {
      const m = { ArrowUp: ['y', 1], ArrowDown: ['y', -1], ArrowLeft: ['x', -1], ArrowRight: ['x', 1] }[e.key];
      if (!m) return;
      e.preventDefault();
      e.stopPropagation();
      keys[m[0]] = m[1];
      set(keys.x * 0.8, keys.y * 0.8);
    });
    root.addEventListener('keyup', (e) => {
      const m = { ArrowUp: 'y', ArrowDown: 'y', ArrowLeft: 'x', ArrowRight: 'x' }[e.key];
      if (!m) return;
      keys[m] = 0;
      set(keys.x * 0.8, keys.y * 0.8);
    });
    root.addEventListener('blur', () => { keys.x = keys.y = 0; if (pid === null) set(0, 0); });

    api.reset = () => set(0, 0);
    api.setDisabled = (v) => root.classList.toggle('is-disabled', !!v);
    set(0, 0);
    return api;
  }

  /* --------------------------- физический геймпад --------------------------- */

  let padName = null;
  const listeners = new Set();
  window.addEventListener('gamepadconnected', (e) => { padName = e.gamepad.id; listeners.forEach((l) => l(padName)); });
  window.addEventListener('gamepaddisconnected', () => { padName = null; listeners.forEach((l) => l(null)); });

  function gamepad() {
    const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
    const p = pads[0];
    if (!p) return null;
    const ax = (i) => p.axes[i] || 0;
    return {
      id: p.id,
      left: { x: ax(0), y: -ax(1) },
      right: { x: ax(2), y: -ax(3) },
      buttons: p.buttons.map((b) => b.pressed),
    };
  }

  /** Срабатывание кнопок геймпада по нажатию (а не пока удерживается) */
  function buttonEdges() {
    let prev = [];
    return (buttons) => {
      const down = buttons.map((b, i) => b && !prev[i]);
      prev = buttons.slice();
      return down;
    };
  }

  /* ------------------------------- цикл ------------------------------- */

  function loop({ read, apply, isBusy, interval = 70 }) {
    let timer = null;
    const tick = () => {
      timer = setTimeout(tick, interval);
      const axes = read();
      if (!axes) return;
      const shaped = {
        lx: shape(axes.lx || 0), ly: shape(axes.ly || 0),
        rx: shape(axes.rx || 0), ry: shape(axes.ry || 0),
      };
      if (!shaped.lx && !shaped.ly && !shaped.rx && !shaped.ry) return;
      if (isBusy()) return; // следующую команду шлём только после завершения движения
      apply(shaped);
    };
    tick();
    return () => clearTimeout(timer);
  }

  window.Joy = {
    stick,
    gamepad,
    buttonEdges,
    loop,
    shape,
    onGamepad: (cb) => { listeners.add(cb); cb(padName); },
  };
})();
