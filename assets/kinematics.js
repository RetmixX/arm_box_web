/*
 * Кинематика манипулятора — порт ik.py из backend + прямая кинематика.
 *   x     — вылет схвата от оси базы, мм
 *   z     — высота кончика схвата над полом, мм
 *   angel — поворот базы, градусы (180 = центр, 2048 тиков)
 */
(function () {
  'use strict';

  const GEOM = {
    BASE_HEIGHT: 163.5,
    L1A: 195.81,
    L1B: 67.36,
    L1: 207.07,
    L2: 134.1,
    L3: 170.0,
    POSITION_OFFSET_DXL4: 30,
  };

  const ALPHA = Math.atan(GEOM.L1B / GEOM.L1A);
  const OFF2 = ALPHA + Math.PI / 2;
  const OFF3 = -ALPHA + Math.PI + Math.PI / 2;
  const OFF4 = Math.PI / 2;
  const angleToPos = (a) => Math.trunc((2048 * a) / Math.PI);

  /** Обратная кинематика. Возвращает null, если точка недостижима. */
  function inverse(x, z, angle) {
    const { L1, L2, L3, BASE_HEIGHT } = GEOM;
    const zc = z - BASE_HEIGHT + L3;
    const D = (x * x + zc * zc - L1 * L1 - L2 * L2) / (2 * L1 * L2);
    if (D < -1 || D > 1) return null;
    const q3 = -Math.acos(D);
    const q2 = Math.atan2(zc, x) - Math.atan2(L2 * Math.sin(q3), L1 + L2 * Math.cos(q3));
    const sinQ4 = (L1 * Math.sin(q2) - zc) / L2;
    if (sinQ4 < -1 || sinQ4 > 1) return null;
    const q4 = Math.asin(sinQ4);
    const ticks = [
      Math.trunc((angle * 4096) / 360),
      angleToPos(q2 + OFF2),
      angleToPos(q3 + OFF3),
      angleToPos(q4 + OFF4) + GEOM.POSITION_OFFSET_DXL4,
    ];
    // моторы 1–4 работают в диапазоне 0..4095
    if (ticks.some((t) => t < 0 || t > 4095)) return null;
    return { q2, q3, q4, ticks };
  }

  const isReachable = (x, z, angle = 180) => inverse(x, z, angle) !== null;

  /** Целевые тики всех 6 моторов — как в RobotARM.move_arm */
  function targetTicks(x, z, angle, pov, gripperState) {
    const ik = inverse(x, z, angle);
    if (!ik) return null;
    return [...ik.ticks, Math.ceil(pov * 3.41), gripperState ? 370 : 710];
  }

  /** Поза (углы звеньев) из тиков моторов */
  function poseFromTicks(t) {
    const g = (id, d) => (Number.isFinite(t[id]) ? t[id] : d);
    return {
      angle: (g(1, 2048) * 360) / 4096,
      shoulder: (g(2, 2048) * Math.PI) / 2048 - OFF2,
      elbow: (g(3, 2048) * Math.PI) / 2048 - OFF3,
      pov: g(5, 512) / 3.41,
      gripTick: g(6, 710),
    };
  }

  /** Поза из целевых координат */
  function poseFromTarget(x, z, angle, pov) {
    const ik = inverse(x, z, angle);
    if (!ik) return null;
    return { angle, shoulder: ik.q2, elbow: ik.q3, pov };
  }

  /** Точки суставов в плоскости руки (мм) */
  function joints(p) {
    const { L1, L2, L3, BASE_HEIGHT } = GEOM;
    const s = { x: 0, z: BASE_HEIGHT };
    const e = { x: L1 * Math.cos(p.shoulder), z: BASE_HEIGHT + L1 * Math.sin(p.shoulder) };
    const w = { x: e.x + L2 * Math.cos(p.shoulder + p.elbow), z: e.z + L2 * Math.sin(p.shoulder + p.elbow) };
    const t = { x: w.x, z: w.z - L3 };
    return { s, e, w, t };
  }

  window.Kin = { GEOM, inverse, isReachable, targetTicks, poseFromTicks, poseFromTarget, joints };
})();
