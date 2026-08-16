import { CFG, TRAP, theme } from './config.js';

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
    /**
     * Опутан лозой: следующий прыжок короче и медленнее. Ставится при посадке
     * в зелёный сектор и снимается любой следующей посадкой.
     */
    this.vined = false;
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
    // Штраф пересчитывается на каждой посадке: сел в лозу — опутан, сел мимо —
    // свободен, независимо от того, был ли штраф активен до этого.
    const zone = planet.lavaAtLocal(theta - planet.phase);
    this.vined = !!zone && zone.kind === TRAP.VINE;
    this.syncOrbitPosition();
  }

  /**
   * Множитель дальности И скорости текущего прыжка.
   * Скорость режется вместе с дальностью — иначе полёт обрывался бы на середине
   * траектории неестественно резко.
   * @returns {number}
   */
  jumpFactor() {
    return this.vined ? CFG.vine.jumpFactor : 1;
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

  /**
   * Пройденная дистанция текущего полёта. Вне полёта — 0.
   * @returns {number}
   */
  flightDistance() {
    if (this.state !== STATE_FLY) return 0;
    return Math.hypot(this.x - this.launchX, this.y - this.launchY);
  }

  /** Отрыв от планеты по касательной в сторону вращения. */
  jump() {
    if (this.state !== STATE_ORBIT || !this.planet) return;
    const t = this.tangent();
    const speed = CFG.player.jumpSpeed * this.jumpFactor();
    this.vx = t.x * speed;
    this.vy = t.y * speed;
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
   * @param {number} jumpDistance базовый (с поправкой на сложность) потолок дальности, px;
   *   штраф лозы применяется здесь же, чтобы укороченная траектория была видна ДО тапа
   */
  draw(ctx, jumpDistance, scale = 1) {
    const T = theme();
    // Пунктир-предсказание: куда уйдёт космонавт, если тапнуть прямо сейчас.
    // Тянется ровно до предела прыжка и краснеет на последних 15% — предел
    // должен быть виден до тапа, а не ощущаться как лотерея.
    if (this.state === STATE_ORBIT) {
      const t = this.tangent();
      const full = jumpDistance * this.jumpFactor();
      const danger = full * CFG.player.jumpDangerStart;
      ctx.save();
      ctx.setLineDash([8 / scale, 10 / scale]);
      ctx.lineWidth = 2 / scale;

      // Опутан лозой — пунктир зелёный и заметно короче: игрок видит, что
      // дальность урезана, до того как прыгнет.
      ctx.strokeStyle = this.vined ? T.vine : T.predict;
      ctx.beginPath();
      ctx.moveTo(this.x, this.y);
      ctx.lineTo(this.x + t.x * danger, this.y + t.y * danger);
      ctx.stroke();

      // Тёмная подложка под красным хвостом: предел дальности — критичный
      // сигнал, он обязан читаться и на тёмном индиго, и на тёплом закате.
      const dx0 = this.x + t.x * danger;
      const dy0 = this.y + t.y * danger;
      const dx1 = this.x + t.x * full;
      const dy1 = this.y + t.y * full;
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 5 / scale;
      ctx.beginPath();
      ctx.moveTo(dx0, dy0);
      ctx.lineTo(dx1, dy1);
      ctx.stroke();

      ctx.strokeStyle = T.danger;
      ctx.lineWidth = 2 / scale;
      ctx.beginPath();
      ctx.moveTo(dx0, dy0);
      ctx.lineTo(dx1, dy1);
      ctx.stroke();

      ctx.restore();
    }

    // Тело космонавта — пятно со свечением в цвете активной темы.
    ctx.save();
    ctx.shadowColor = T.player;
    ctx.shadowBlur = 14;
    ctx.fillStyle = T.player;
    ctx.beginPath();
    ctx.arc(this.x, this.y, CFG.player.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (this.vined) this.drawVineWrap(ctx, T, scale);
  }

  /**
   * Зелёная оплётка на космонавте — признак активного штрафа дальности.
   * @param {CanvasRenderingContext2D} ctx
   * @param {ReturnType<typeof theme>} T
   */
  drawVineWrap(ctx, T, scale = 1) {
    const V = CFG.vine;
    const r = CFG.player.radius + V.wrapOutset;

    ctx.save();
    ctx.strokeStyle = T.vine;
    ctx.shadowColor = T.vine;
    ctx.shadowBlur = 6;
    ctx.lineWidth = V.wrapWidth / scale;
    ctx.beginPath();
    ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
    ctx.stroke();

    // Короткие побеги наружу: оплётка читается даже на мелком экране.
    ctx.lineWidth = 1.5 / scale;
    for (let i = 0; i < V.wrapTendrils; i++) {
      const a = (i / V.wrapTendrils) * Math.PI * 2 + this.theta;
      ctx.beginPath();
      ctx.moveTo(this.x + Math.cos(a) * r, this.y + Math.sin(a) * r);
      ctx.lineTo(this.x + Math.cos(a) * (r + V.wrapTendrilLength), this.y + Math.sin(a) * (r + V.wrapTendrilLength));
      ctx.stroke();
    }
    ctx.restore();
  }
}
