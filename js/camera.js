import { CFG } from './config.js';
import { STATE_ORBIT } from './player.js';

/**
 * Камера центрируется на планете, где стоит игрок, по обеим осям.
 * x/y — мировые координаты ЛЕВОГО ВЕРХНЕГО угла экрана.
 *
 * Тряска намеренно НЕ подмешивается в x/y: она живёт отдельными shakeX/shakeY
 * и складывается с позицией только на этапе рендера. Иначе сглаживание начнёт
 * догонять смещение тряски и размажет её в вялое качание.
 */
export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    /** Аддитивное смещение тряски, применяется только при отрисовке. */
    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeT = 0;
    /** Остаток окна ослабленного сглаживания после посадки, с. */
    this.landingT = 0;
  }

  /**
   * Куда камера хочет смотреть.
   * На планете — её центр: пока космонавт крутится по орбите, цель неподвижна,
   * и кадр стоит намертво. В полёте — сам космонавт, чтобы полёт читался.
   * @param {import('./player.js').Player} player
   * @param {{w:number,h:number}} view
   * @returns {{x:number,y:number}} мировая точка, которую держим в центре экрана
   */
  targetFor(player, view) {
    const lookAhead = view.h * CFG.camera.lookAhead;
    if (player.state === STATE_ORBIT && player.planet) {
      return { x: player.planet.x, y: player.planet.y - lookAhead };
    }
    return { x: player.x, y: player.y - lookAhead };
  }

  /**
   * Поставить камеру в целевую точку мгновенно — старт и рестарт не должны
   * начинаться с подъезда камеры.
   * @param {{x:number,y:number}} target
   * @param {{w:number,h:number}} view
   */
  snapTo(target, view) {
    this.x = target.x - view.w / 2;
    this.y = target.y - view.h / 2;
    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeT = 0;
    this.landingT = 0;
  }

  /**
   * Текущий коэффициент сглаживания. Сразу после посадки он занижен и
   * возвращается к базовому по ease-out: в этот момент цель скачком
   * перепрыгивает с космонавта на центр новой планеты, и жёсткое сглаживание
   * читалось бы как рывок.
   * @returns {number}
   */
  currentSmooth() {
    const C = CFG.camera;
    if (this.landingT <= 0) return C.smooth;
    const k = 1 - this.landingT / C.landingSmoothTime; // 0 в момент посадки -> 1 в конце
    const eased = 1 - (1 - k) * (1 - k);               // ease-out
    return C.landingSmooth + (C.smooth - C.landingSmooth) * eased;
  }

  /**
   * @param {number} dt секунды фиксированного шага
   * @param {{x:number,y:number}} target мировая точка, которую держим в центре
   * @param {{w:number,h:number}} view
   */
  update(dt, target, view) {
    const wantX = target.x - view.w / 2;
    const wantY = target.y - view.h / 2;

    if (this.landingT > 0) this.landingT = Math.max(0, this.landingT - dt);

    // Экспоненциальное сглаживание, не зависящее от частоты кадров: коэффициент
    // задан для 60 FPS, на просадках камера не дёргается.
    const t = 1 - Math.pow(1 - this.currentSmooth(), dt * 60);
    let dx = (wantX - this.x) * t;
    let dy = (wantY - this.y) * t;

    // Потолок скорости: на респавне и длинных прыжках камера не телепортируется.
    const maxStep = CFG.camera.maxSpeed * dt;
    const len = Math.hypot(dx, dy);
    if (len > maxStep && len > 0) {
      dx = (dx / len) * maxStep;
      dy = (dy / len) * maxStep;
    }

    this.x += dx;
    this.y += dy;

    this.updateShake(dt);
  }

  /**
   * @param {number} dt
   */
  updateShake(dt) {
    if (this.shakeT > 0) {
      this.shakeT = Math.max(0, this.shakeT - dt);
      const amp = CFG.camera.shakeAmp * (this.shakeT / CFG.camera.shakeTime);
      this.shakeX = (Math.random() * 2 - 1) * amp;
      this.shakeY = (Math.random() * 2 - 1) * amp;
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  /** Короткий шейк при приземлении. */
  shake() {
    this.shakeT = CFG.camera.shakeTime;
  }

  /** Открыть окно ослабленного сглаживания — вызывать в момент посадки. */
  startLandingEase() {
    this.landingT = CFG.camera.landingSmoothTime;
  }
}
