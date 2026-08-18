import { CFG, TRAP, theme, SKINS, getSkinId } from './config.js';

/** @typedef {import('./planet.js').Planet} Planet */

export const STATE_ORBIT = 'orbit';
export const STATE_FLY = 'fly';

// ---------------------------------------------------------------------------
// Скины космонавта.
//
// Каждый скин — САМОСТОЯТЕЛЬНАЯ функция отрисовки, а не ветка в общем рендере:
// правка одного силуэта физически не может задеть остальные. Диспетчер —
// таблица SKIN_DRAW, а не цепочка if.
//
// Все три получают одинаковый контракт: (ctx, player, skin, scale).
// Направление «вперёд» берётся из касательной орбиты, поэтому вытянутые
// силуэты и хвост смотрят правильно и на орбите, и в полёте.
// ---------------------------------------------------------------------------

/**
 * Единичный вектор «куда смотрит космонавт».
 * На орбите — по касательной (туда же уйдёт прыжок), в полёте — по скорости.
 * @param {Player} p
 * @returns {{x:number,y:number}}
 */
function facing(p) {
  if (p.state === STATE_FLY) {
    const len = Math.hypot(p.vx, p.vy);
    if (len > 0) return { x: p.vx / len, y: p.vy / len };
  }
  return p.tangent();
}

/**
 * «Стандарт» — исходный космонавт: круглое пятно со свечением.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Player} p
 * @param {typeof SKINS.default} s
 * @param {number} scale
 */
export function drawSkinDefault(ctx, p, s, scale) {
  ctx.save();
  ctx.shadowColor = s.glow;
  ctx.shadowBlur = s.glowBlur;
  ctx.fillStyle = s.body;
  ctx.beginPath();
  ctx.arc(p.x, p.y, CFG.player.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * «Комета» — вытянутое вдоль движения тело и хвост за спиной.
 *
 * Хвост — часть МОДЕЛИ, а не эффект полёта: он тянется и на неподвижной
 * орбите, потому что строится от касательной, а не от скорости. С искрами
 * шлейфа из particles.js не спорит — те красятся в цвет активного скина,
 * поэтому хвост и искры читаются как одно целое.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Player} p
 * @param {typeof SKINS.comet} s
 * @param {number} scale
 */
export function drawSkinComet(ctx, p, s, scale) {
  const R = CFG.player.radius;
  const f = facing(p);
  const angle = Math.atan2(f.y, f.x);
  // Лёгкое покачивание хвоста: тело живое, даже когда стоит на орбите.
  const wave = Math.sin(p.trailPhase * s.tailWaveSpeed) * s.tailWave;

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(angle);

  // Хвост: сегменты назад по оси, сужаются и гаснут.
  for (let i = s.tailSegments; i >= 1; i--) {
    const k = i / s.tailSegments;              // 1 у кончика -> ~0 у тела
    const dist = s.tailLength * k;
    const w = s.tailWidth * (1 - k) + 0.6;
    ctx.globalAlpha = (1 - k) * 0.7;
    ctx.fillStyle = i > s.tailSegments / 2 ? s.accent : s.glow;
    ctx.beginPath();
    ctx.ellipse(-dist, wave * dist, w * 0.9, w, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Тело: эллипс, вытянутый вдоль движения.
  ctx.globalAlpha = 1;
  ctx.shadowColor = s.glow;
  ctx.shadowBlur = s.glowBlur;
  ctx.fillStyle = s.body;
  ctx.beginPath();
  ctx.ellipse(0, 0, R * s.stretch, R * 0.85, 0, 0, Math.PI * 2);
  ctx.fill();

  // Холодное ядро у носа — чтобы направление читалось мгновенно.
  ctx.shadowBlur = 0;
  ctx.fillStyle = s.accent;
  ctx.beginPath();
  ctx.arc(R * 0.45, 0, R * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * «Магма» — приземистый корпус с раскалёнными трещинами.
 *
 * Пульсация та же по приёму, что у секторов лавы, но медленнее и слабее:
 * это украшение, а не сигнал опасности, и путать их нельзя.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Player} p
 * @param {typeof SKINS.magma} s
 * @param {number} scale
 */
export function drawSkinMagma(ctx, p, s, scale) {
  const R = CFG.player.radius;
  const f = facing(p);
  const angle = Math.atan2(f.y, f.x);
  const pulse = 1 - s.pulseAmp * (0.5 + 0.5 * Math.sin(p.trailPhase * s.pulseSpeed));

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(angle);

  // Корпус: приплюснутый поперёк движения, отсюда «приземистость».
  ctx.shadowColor = s.glow;
  ctx.shadowBlur = s.glowBlur * pulse;
  ctx.fillStyle = s.body;
  ctx.beginPath();
  ctx.ellipse(0, 0, R * 0.95, R * s.squash, 0, 0, Math.PI * 2);
  ctx.fill();

  // Трещины: короткие светящиеся штрихи поперёк корпуса.
  ctx.shadowBlur = s.glowBlur * 0.5 * pulse;
  ctx.strokeStyle = s.accent;
  ctx.globalAlpha = pulse;
  ctx.lineWidth = s.crackWidth / scale;
  ctx.lineCap = 'round';
  for (let i = 0; i < s.cracks; i++) {
    const t = (i + 0.5) / s.cracks;
    const cx = (t - 0.5) * R * 1.5;
    const h = R * s.squash * (0.35 + 0.35 * Math.sin(i * 2.3));
    ctx.beginPath();
    ctx.moveTo(cx, -h);
    ctx.lineTo(cx + R * 0.18, h);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Диспетчер скинов. Таблица, а не цепочка if: добавление скина не трогает
 * код остальных.
 * @type {Record<string, (ctx: CanvasRenderingContext2D, p: Player, s: object, scale: number) => void>}
 */
export const SKIN_DRAW = {
  default: drawSkinDefault,
  comet: drawSkinComet,
  magma: drawSkinMagma,
};

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
    /**
     * Угол, намотанный вокруг ТЕКУЩЕЙ планеты с момента посадки на неё
     * (по модулю эффективной omega — буст вращения учитывается). Единственный
     * критерий множителя очков: обнуляется на каждой посадке, сравнивается
     * с порогом в момент отрыва.
     */
    this.spentAngle = 0;
    /**
     * Декоративный космонавт (сцена главного меню): рисуется только тело,
     * без пунктира-прицела и дуги прогресса множителя — там нечего целить
     * и нечего копить, это фон под кнопками.
     */
    this.decorative = false;
    /**
     * Часы анимации скина, с. Хвост «Кометы» и пульсация «Магмы» идут по ним,
     * а не по абсолютному времени: так анимация не зависит от того, сколько
     * страница открыта, и переживает паузу без скачка.
     */
    this.trailPhase = 0;
    /**
     * Переопределение скина для этого экземпляра. null — берём активный из
     * config. Нужно превью в магазине: там показывается выбранная карточка,
     * которая может быть ещё не экипирована.
     * @type {string|null}
     */
    this.skinId = null;
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
    this.spentAngle = 0; // новая планета — счётчик множителя стартует заново
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
    this.trailPhase += dt;
    if (this.state === STATE_ORBIT) {
      if (!this.planet) return;
      // Строго эффективная omega: космонавт обязан крутиться вместе с бустом,
      // иначе он «отстанет» от поверхности и локальный угол поедет.
      const effOmega = this.planet.effectiveOmega;
      this.theta += effOmega * dt;
      this.spentAngle += Math.abs(effOmega) * dt;
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
    if (this.state === STATE_ORBIT && !this.decorative) {
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

      // Дуга прогресса: сколько угла уже намотано к порогу сброса множителя.
      // Порог задаётся в CFG.combo.angleThreshold — здесь только чтение.
      this.drawAngleProgress(ctx, T, scale);
    }

    // Тело космонавта рисует функция активного скина — своя у каждого.
    const id = this.skinId || getSkinId();
    const s = SKINS[id] || SKINS.default;
    (SKIN_DRAW[id] || SKIN_DRAW.default)(ctx, this, s, scale);

    if (this.vined) this.drawVineWrap(ctx, T, scale);
  }

  /**
   * Дуга прогресса вокруг орбиты: доля spentAngle от порога сброса множителя.
   * Кольцо чуть шире орбиты — не путается с подсветкой буста вращения,
   * которая рисуется прямо на orbitRadius.
   * @param {CanvasRenderingContext2D} ctx
   * @param {ReturnType<typeof theme>} T
   * @param {number} scale
   */
  drawAngleProgress(ctx, T, scale) {
    if (!this.planet) return;
    const progress = Math.min(this.spentAngle / CFG.combo.angleThreshold, 1);
    if (progress <= 0) return;

    const r = this.planet.orbitRadius + CFG.combo.progressRingOutset;
    const start = -Math.PI / 2; // дуга растёт от верхней точки, как циферблат

    ctx.save();
    ctx.strokeStyle = T.accent;
    ctx.globalAlpha = CFG.combo.progressRingAlpha;
    ctx.lineWidth = CFG.combo.progressRingWidth / scale;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(this.planet.x, this.planet.y, r, start, start + progress * Math.PI * 2);
    ctx.stroke();
    ctx.restore();
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
