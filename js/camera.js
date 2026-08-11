import { CFG } from './config.js';

/**
 * Камера скроллит только вверх, следуя за космонавтом с лагом и мёртвой зоной.
 * y — мировая координата верхней кромки экрана.
 */
export class Camera {
  constructor() {
    this.y = 0;
    this.shakeT = 0;
    this.offsetX = 0;
    this.offsetY = 0;
  }

  /**
   * Мгновенно поставить камеру так, чтобы цель оказалась в якорной точке.
   * @param {number} targetY мировая Y цели
   * @param {number} viewH высота экрана, px
   */
  snapTo(targetY, viewH) {
    this.y = targetY - viewH * CFG.camera.anchor;
    this.shakeT = 0;
    this.offsetX = 0;
    this.offsetY = 0;
  }

  /**
   * @param {number} dt секунды фиксированного шага
   * @param {number} targetY мировая Y цели (космонавт)
   * @param {number} viewH высота экрана, px
   */
  update(dt, targetY, viewH) {
    const want = targetY - viewH * CFG.camera.anchor;
    const diff = want - this.y;

    // Мёртвая зона гасит дрожание камеры от вращения космонавта вокруг планеты.
    // Камера не едет вниз: провал под экран должен заканчиваться смертью.
    if (diff < -CFG.camera.deadZone) {
      // Сглаживание, не зависящее от частоты кадров: lerp задан для 60 FPS.
      const k = 1 - Math.pow(1 - CFG.camera.lerp, dt * 60);
      this.y += (want + CFG.camera.deadZone - this.y) * k;
    }

    if (this.shakeT > 0) {
      this.shakeT = Math.max(0, this.shakeT - dt);
      const power = this.shakeT / CFG.camera.shakeTime;
      const amp = CFG.camera.shakeAmp * power;
      this.offsetX = (Math.random() * 2 - 1) * amp;
      this.offsetY = (Math.random() * 2 - 1) * amp;
    } else {
      this.offsetX = 0;
      this.offsetY = 0;
    }
  }

  /** Короткий шейк при приземлении. */
  shake() {
    this.shakeT = CFG.camera.shakeTime;
  }

  /**
   * Итоговый сдвиг рендера по Y с учётом тряски.
   * @returns {number}
   */
  get renderY() {
    return this.y + this.offsetY;
  }
}
