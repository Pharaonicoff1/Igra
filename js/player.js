import { CFG } from './config.js';

/** @typedef {import('./planet.js').Planet} Planet */

export const STATE_ORBIT = 'orbit';
export const STATE_FLY = 'fly';

/**
 * Космонавт: либо вращается вместе с планетой, либо летит по прямой.
 * Гравитации в полёте нет — траектория читается глазом до тапа.
 */
export class Player {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.theta = 0;
    this.state = STATE_ORBIT;
    /** @type {Planet|null} */
    this.planet = null;
    /** Планета, с которой только что стартовали: игнорим её захват, пока не выйдем из радиуса. */
    this.ignore = null;
    /** Точка старта текущего полёта — нужна для расчёта дальности (комбо). */
    this.launchX = 0;
    this.launchY = 0;
    /** @type {(planet: Planet, dist: number) => void} */
    this.onLand = () => {};
    /** @type {() => void} */
    this.onJump = () => {};
  }

  /**
   * Привязать космонавта к планете под углом theta.
   * @param {Planet} planet
   * @param {number} theta угол на орбите, rad
   */
  attach(planet, theta) {
    this.planet = planet;
    this.theta = theta;
    this.state = STATE_ORBIT;
    this.vx = 0;
    this.vy = 0;
    this.ignore = null;
    this.syncOrbitPosition();
  }

  /** Пересчитать позицию из угла на орбите. */
  syncOrbitPosition() {
    const p = this.planet;
    if (!p) return;
    const R = p.orbitRadius;
    this.x = p.x + Math.cos(this.theta) * R;
    this.y = p.y + Math.sin(this.theta) * R;
  }

  /**
   * Единичный вектор касательной в текущей точке орбиты (направление будущего прыжка).
   * @returns {{x:number,y:number}}
   */
  tangent() {
    const sign = Math.sign(this.planet ? this.planet.omega : 1) || 1;
    return { x: -Math.sin(this.theta) * sign, y: Math.cos(this.theta) * sign };
  }

  /** Отрыв от планеты по касательной в сторону вращения. */
  jump() {
    if (this.state !== STATE_ORBIT || !this.planet) return;
    const t = this.tangent();
    this.vx = t.x * CFG.player.jumpSpeed;
    this.vy = t.y * CFG.player.jumpSpeed;
    this.ignore = this.planet;
    this.planet = null;
    this.state = STATE_FLY;
    this.launchX = this.x;
    this.launchY = this.y;
    this.onJump();
  }

  /**
   * Шаг симуляции.
   * @param {number} dt секунды фиксированного шага
   * @param {Planet[]} planets активные планеты
   */
  update(dt, planets) {
    if (this.state === STATE_ORBIT) {
      if (!this.planet) return;
      this.theta += this.planet.omega * dt;
      this.syncOrbitPosition();
      return;
    }

    // Полёт: строго по прямой, без гравитации.
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Снимаем иммунитет со стартовой планеты, как только вышли из её радиуса захвата.
    if (this.ignore) {
      const d = Math.hypot(this.x - this.ignore.x, this.y - this.ignore.y);
      if (d > this.ignore.captureRadius) this.ignore = null;
    }

    for (const p of planets) {
      if (!p.alive || p === this.ignore) continue;
      const dx = this.x - p.x;
      const dy = this.y - p.y;
      if (Math.hypot(dx, dy) < p.captureRadius) {
        const flightDist = Math.hypot(this.x - this.launchX, this.y - this.launchY);
        this.attach(p, Math.atan2(dy, dx));
        this.onLand(p, flightDist);
        return;
      }
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(ctx) {
    // Пунктир-предсказание: куда уйдёт космонавт, если тапнуть прямо сейчас.
    if (this.state === STATE_ORBIT) {
      const t = this.tangent();
      ctx.save();
      ctx.setLineDash([8, 10]);
      ctx.strokeStyle = 'rgba(255,244,226,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(this.x, this.y);
      ctx.lineTo(this.x + t.x * CFG.player.predictLength, this.y + t.y * CFG.player.predictLength);
      ctx.stroke();
      ctx.restore();
    }

    // Тело космонавта — тёплое белое пятно со свечением.
    ctx.save();
    ctx.shadowColor = CFG.colors.warmWhite;
    ctx.shadowBlur = 14;
    ctx.fillStyle = CFG.colors.warmWhite;
    ctx.beginPath();
    ctx.arc(this.x, this.y, CFG.player.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
