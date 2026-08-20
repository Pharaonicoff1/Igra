import { CFG, theme, skin } from './config.js';

/**
 * Индексы цветов. Частица хранит индекс, а не строку: отрисовка идёт группами
 * по цвету, и fillStyle меняется РОВНО столько раз, сколько цветов в кадре.
 */
// Цвет космонавта берётся из АКТИВНОГО СКИНА, а не из темы: искры шлейфа,
// отдача и взрыв смерти обязаны совпадать с телом. Иначе холодный хвост
// «Кометы» тонул бы в тёплых искрах — ровно тот визуальный мусор, которого
// быть не должно.
export const C_PLAYER = 0;   // цвет активного скина — космонавт и его искры
export const C_ACCENT = 1;   // акцент темы — подсказки
export const C_WARM = 2;     // тёплая ступень рампы нагрева
export const C_HOT = 3;      // горячая ступень рампы нагрева
export const C_SMOLDER = 4;  // тлеющая лава
export const C_LAVA = 5;     // раскалённая лава
// Пепел сейчас никто не излучает (это был цвет сброса множителя, а сброса
// больше нет), но индекс держим: под ним в палитре лежит T.ash, и убрать слот —
// значит перенумеровать всю палитру ради одной строки.
export const C_ASH = 6;      // пепел
export const C_SHARD = 7;    // космические осколки: фиолетовый кристалл
const COLOR_COUNT = 8;

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

/**
 * Система частиц.
 *
 * Пул фиксированного размера на типизированных массивах: ни одного `new` и ни
 * одного нового массива в игровом цикле — аллокации в hot loop дают дёрганья
 * от сборщика мусора на телефоне.
 *
 * Слоты переиспользуются кольцевым курсором: при переполнении затирается
 * слот, выданный дальше всех спавнов назад, то есть самая старая частица.
 *
 * Свечение рисуется вторым полупрозрачным кругом. ctx.shadowBlur не
 * используется нигде — это главный убийца Canvas 2D на мобильных.
 */
export class Particles {
  constructor() {
    const n = CFG.particles.max;
    this.n = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.life = new Float32Array(n);     // остаток жизни, с; <= 0 — слот свободен
    this.invLife = new Float32Array(n);  // 1 / полная жизнь: alpha без деления в цикле
    this.size = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.dragMul = new Float32Array(n);  // затухание скорости за один фикс. шаг
    this.color = new Uint8Array(n);
    this.ui = new Uint8Array(n);         // 1 — экранный слой (без камеры и зума)
    this.glow = new Uint8Array(n);
    this.cursor = 0;
    this.alive = 0;
  }

  /** Полная очистка пула — рестарт и выход в меню не должны оставлять хвостов. */
  clear() {
    this.life.fill(0);
    this.alive = 0;
    this.cursor = 0;
  }

  /**
   * Энергия частиц от множителя очков.
   *
   * Множитель постоянный (куплен в магазине), поэтому энергия неизменна весь
   * забег: прокачка читается как более живой экран, а не как реакция на
   * происходящее в моменте.
   *
   * @param {number} multiplier
   * @returns {number} 1..energyMax
   */
  static energyFor(multiplier) {
    const P = CFG.particles;
    const e = 1 + (multiplier - 1) * P.energyPerMultiplier;
    return Math.min(Math.max(e, 1), P.energyMax);
  }

  /**
   * Цвет по «нагреву» множителя: спокойный -> тёплый -> горячий.
   * @param {number} energy
   * @returns {number} индекс цвета
   */
  static heatColor(energy) {
    if (energy >= 2.2) return C_HOT;
    if (energy >= 1.5) return C_WARM;
    return C_PLAYER;
  }

  /**
   * Выдать слот под новую частицу. O(1), без поиска и без аллокаций.
   * @returns {number} индекс слота
   */
  take() {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    if (this.life[i] <= 0) this.alive++; // затирание живой частицы счётчик не меняет
    return i;
  }

  /**
   * Породить частицу.
   * @param {number} x @param {number} y
   * @param {number} vx @param {number} vy
   * @param {number} life секунды
   * @param {number} size радиус, px
   * @param {number} color индекс из C_*
   * @param {{ui?:boolean, glow?:boolean, drag?:number, gravity?:number}} [opts]
   */
  emit(x, y, vx, vy, life, size, color, opts) {
    const i = this.take();
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.invLife[i] = 1 / life;
    this.size[i] = size;
    this.color[i] = color;
    this.ui[i] = opts && opts.ui ? 1 : 0;
    this.glow[i] = opts && opts.glow ? 1 : 0;
    this.grav[i] = opts && opts.gravity !== undefined ? opts.gravity : 0;
    // Затухание считаем один раз при рождении: в цикле остаётся умножение.
    const drag = opts && opts.drag !== undefined ? opts.drag : 0;
    this.dragMul[i] = drag > 0 ? Math.exp(-drag * CFG.physics.step) : 1;
  }

  /**
   * Шаг симуляции. Идёт на том же фиксированном шаге, что и вся физика.
   * @param {number} dt секунды
   */
  update(dt) {
    if (this.alive === 0) return;
    const { x, y, vx, vy, life, grav, dragMul } = this;
    for (let i = 0; i < this.n; i++) {
      const l = life[i];
      if (l <= 0) continue;
      const next = l - dt;
      if (next <= 0) {
        life[i] = 0;
        this.alive--;
        continue;
      }
      life[i] = next;
      vy[i] = vy[i] * dragMul[i] + grav[i] * dt;
      vx[i] *= dragMul[i];
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
    }
  }

  /**
   * Мировой слой: рисуется внутри трансформации камеры, поэтому размер делится
   * на зум — иначе на дальнем плане частицы исчезнут.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} scale зум камеры
   */
  drawWorld(ctx, scale) {
    this.draw(ctx, 0, 1 / scale);
  }

  /**
   * Экранный слой: без камеры и без зума.
   * @param {CanvasRenderingContext2D} ctx
   */
  drawUi(ctx) {
    this.draw(ctx, 1, 1);
  }

  /**
   * Один проход по цветовым группам: fillStyle переключается только на смене
   * цвета, а не на каждой частице.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} layer 0 — мир, 1 — экран
   * @param {number} sizeMul компенсация зума
   */
  draw(ctx, layer, sizeMul) {
    if (this.alive === 0) return;
    const P = CFG.particles;
    const T = theme();
    const palette = Particles.palette(T);
    const { x, y, life, invLife, size, color, ui, glow } = this;

    ctx.save();
    for (let c = 0; c < COLOR_COUNT; c++) {
      let opened = false;
      for (let i = 0; i < this.n; i++) {
        if (life[i] <= 0 || color[i] !== c || ui[i] !== layer) continue;
        if (!opened) {
          ctx.fillStyle = palette[c];
          opened = true;
        }
        const k = life[i] * invLife[i];            // 1 -> 0
        const a = Math.pow(k, P.fadePower);
        const r = size[i] * sizeMul;

        if (glow[i]) {
          ctx.globalAlpha = a * P.glowAlpha;
          ctx.beginPath();
          ctx.arc(x[i], y[i], r * P.glowScale, 0, TAU);
          ctx.fill();
        }
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(x[i], y[i], r, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * Палитра активной темы по индексам цветов.
   * @param {ReturnType<typeof theme>} T
   * @returns {string[]}
   */
  static palette(T) {
    const tint = T.multiplierTint;
    return [skin().body, T.accent, tint[1], tint[2], T.lavaSmolder, T.lavaHot, T.ash, T.shard];
  }

  // -------------------------------------------------------------------------
  // Источники частиц
  // -------------------------------------------------------------------------

  /**
   * Отрыв от планеты: отдача конусом ПРОТИВ направления прыжка.
   * @param {number} px @param {number} py точка отрыва
   * @param {number} dirX @param {number} dirY направление прыжка (единичное)
   * @param {number} energy
   */
  jumpRecoil(px, py, dirX, dirY, energy) {
    const S = CFG.particles.jump;
    const P = CFG.particles;
    const count = Math.round(rand(S.countMin, S.countMax) * (1 + (energy - 1) * P.countEnergy));
    const spread = (S.spreadDeg * Math.PI) / 180 * (1 + (energy - 1) * P.spreadEnergy);
    const base = Math.atan2(-dirY, -dirX); // строго назад
    const lifeMul = 1 + (energy - 1) * P.lifeEnergy;
    const color = Particles.heatColor(energy);

    for (let i = 0; i < count; i++) {
      const a = base + rand(-spread, spread);
      const sp = rand(S.speedMin, S.speedMax) * energy;
      this.emit(px, py, Math.cos(a) * sp, Math.sin(a) * sp,
        S.life * lifeMul * rand(0.8, 1.2), rand(S.sizeMin, S.sizeMax),
        color, { drag: S.drag, glow: true });
    }
  }

  /**
   * Приземление: пыль разлетается ВДОЛЬ поверхности планеты, а не во все
   * стороны — так читается удар о грунт, а не взрыв.
   * @param {import('./planet.js').Planet} planet
   * @param {number} px @param {number} py точка касания
   * @param {number} energy
   */
  landingDust(planet, px, py, energy) {
    const S = CFG.particles.landing;
    const P = CFG.particles;
    const count = Math.round(S.count * (1 + (energy - 1) * P.countEnergy));
    const spread = (S.spreadDeg * Math.PI) / 180 * (1 + (energy - 1) * P.spreadEnergy);
    const lifeMul = 1 + (energy - 1) * P.lifeEnergy;
    const color = Particles.heatColor(energy);

    // Нормаль к поверхности и касательная в точке касания.
    let nx = px - planet.x;
    let ny = py - planet.y;
    const d = Math.hypot(nx, ny) || 1;
    nx /= d;
    ny /= d;
    const tx = -ny;
    const ty = nx;

    for (let i = 0; i < count; i++) {
      const side = i % 2 === 0 ? 1 : -1;         // веером в обе стороны вдоль грунта
      const a = rand(-spread, spread);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // Касательная, слегка приподнятая от поверхности.
      const dx = (tx * ca - ny * sa) * side + nx * S.outward;
      const dy = (ty * ca + nx * sa) * side + ny * S.outward;
      const len = Math.hypot(dx, dy) || 1;
      const sp = rand(S.speedMin, S.speedMax) * energy;
      this.emit(px, py, (dx / len) * sp, (dy / len) * sp,
        S.life * lifeMul * rand(0.8, 1.2), rand(S.sizeMin, S.sizeMax),
        color, { drag: S.drag, glow: true });
    }
  }

  /**
   * Редкая искра, отваливающаяся от космонавта в полёте.
   * @param {number} px @param {number} py
   * @param {number} vx @param {number} vy скорость космонавта
   * @param {number} energy
   */
  trailSpark(px, py, vx, vy, energy) {
    const S = CFG.particles.trail;
    const P = CFG.particles;
    const spread = (S.spreadDeg * Math.PI) / 180 * (1 + (energy - 1) * P.spreadEnergy);
    const speed = Math.hypot(vx, vy) || 1;
    const base = Math.atan2(-vy / speed, -vx / speed); // назад по курсу
    const a = base + rand(-spread, spread);
    const sp = S.speed * energy;
    this.emit(px, py, Math.cos(a) * sp, Math.sin(a) * sp,
      S.life * (1 + (energy - 1) * P.lifeEnergy), rand(S.sizeMin, S.sizeMax),
      Particles.heatColor(energy), { drag: S.drag, glow: true });
  }

  /**
   * Получены осколки: всплеск фиолетовых кристаллов из точки посадки В СТОРОНУ
   * счётчика в HUD. Обе точки — экранные: частицы летят по UI-слою, иначе они
   * остались бы в мире и «не долетели» бы до интерфейса.
   *
   * Скорость подобрана так, чтобы частица прошла путь до счётчика примерно за
   * свою жизнь: летит именно туда, а не просто рассыпается в ту сторону.
   *
   * @param {number} sx @param {number} sy точка посадки в ЭКРАННЫХ координатах
   * @param {number} tx @param {number} ty счётчик осколков в HUD, экранные
   */
  shardGain(sx, sy, tx, ty) {
    const S = CFG.particles.shard;
    const dx = tx - sx;
    const dy = ty - sy;
    const dist = Math.hypot(dx, dy) || 1;
    const dirX = dx / dist;
    const dirY = dy / dist;
    // Базовая скорость «долететь за время жизни» плюс разброс: часть частиц
    // отстаёт, часть обгоняет — иначе всплеск выглядит как один жёсткий отрезок.
    const base = dist / S.life;

    for (let i = 0; i < S.count; i++) {
      const spread = rand(-S.spreadDeg, S.spreadDeg) * Math.PI / 180;
      const cos = Math.cos(spread);
      const sin = Math.sin(spread);
      const vx = (dirX * cos - dirY * sin) * base * rand(S.speedMin, S.speedMax);
      const vy = (dirX * sin + dirY * cos) * base * rand(S.speedMin, S.speedMax);
      this.emit(sx, sy, vx, vy, S.life * rand(S.lifeJitter, 1),
        rand(S.sizeMin, S.sizeMax), C_SHARD, { ui: true, drag: S.drag, glow: true });
    }
  }

  /**
   * Спад буста вращения: тонкое кольцо по орбите планеты — «окно открылось».
   * @param {import('./planet.js').Planet} planet
   */
  boostRing(planet) {
    const S = CFG.particles.boostRing;
    const r = planet.orbitRadius;
    for (let i = 0; i < S.count; i++) {
      const a = (i / S.count) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      this.emit(planet.x + ca * r, planet.y + sa * r, ca * S.speed, sa * S.speed,
        S.life * rand(0.85, 1.15), rand(S.sizeMin, S.sizeMax),
        C_ACCENT, { drag: S.drag });
    }
  }

  /**
   * Смерть: разлёт во все стороны. Чем выше был множитель, тем эффектнее.
   * @param {number} px @param {number} py
   * @param {number} energy
   */
  deathBurst(px, py, energy) {
    const S = CFG.particles.death;
    const P = CFG.particles;
    const count = Math.round(S.count * (1 + (energy - 1) * P.countEnergy));
    const color = Particles.heatColor(energy);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + rand(-0.15, 0.15);
      const sp = rand(S.speedMin, S.speedMax) * energy;
      this.emit(px, py, Math.cos(a) * sp, Math.sin(a) * sp,
        S.life * (1 + (energy - 1) * P.lifeEnergy) * rand(0.8, 1.2),
        rand(S.sizeMin, S.sizeMax), color, { drag: S.drag, glow: true });
    }
  }

  /**
   * Уголёк от сектора лавы. Точка берётся из АКТУАЛЬНОГО положения дуги:
   * сектор вращается вместе с планетой, поэтому угол складывается с фазой.
   * @param {import('./planet.js').Planet} planet
   * @param {{start:number,end:number,kind:string}} zone
   * @param {boolean} hot раскалённая ли зона
   */
  lavaEmber(planet, zone, hot) {
    const S = CFG.particles.lava;
    const local = rand(zone.start, zone.end);
    const a = local + planet.phase;         // локальный угол -> мировой
    const r = planet.r + CFG.lava.outset;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const rise = rand(S.riseMin, S.riseMax);
    this.emit(
      planet.x + ca * r, planet.y + sa * r,
      ca * rise + rand(-S.drift, S.drift),
      sa * rise + rand(-S.drift, S.drift),
      S.life * rand(0.8, 1.2), rand(S.sizeMin, S.sizeMax),
      hot ? C_LAVA : C_SMOLDER, { drag: S.drag, gravity: S.gravity, glow: true },
    );
  }
}
