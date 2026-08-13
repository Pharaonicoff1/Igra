import { CFG, difficultyFactor, lavaChance } from './config.js';
import { Planet } from './planet.js';

const TAU = Math.PI * 2;
const deg = (d) => (d * Math.PI) / 180;
const norm = (a) => ((a % TAU) + TAU) % TAU;
const rand = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);

/**
 * Спавнер держит в пуле ~6 планет и гарантирует достижимость каждой следующей.
 *
 * Почему достижимость всегда есть: прямая по касательной от орбиты радиуса R
 * проходит на расстоянии ровно R от центра планеты, а угол theta пробегает
 * полный круг — значит, тапом можно попасть в любую точку дальше R от центра.
 * Достаточно держать дистанцию между центрами в пределах [distMin, distMax],
 * где distMax <= player.maxJumpDistance * player.reachSafety (жёсткий потолок
 * прыжка с запасом 15%). Тупик сгенерировать нельзя, а честный прыжок всегда
 * укладывается в maxJumpDistance до того, как считается «не долетел».
 */
export class Spawner {
  constructor() {
    /** @type {Planet[]} */
    this.planets = [];
    /** @type {Planet|null} Самая верхняя (последняя созданная) планета — от неё строим цепочку. */
    this.top = null;
    this.paletteCursor = 0;
    /** Сколько планет создано с момента рестарта — по нему работает «первые N без лавы». */
    this.spawnedCount = 0;
  }

  /**
   * Сбросить мир и создать стартовую планету.
   * @param {{w:number,h:number}} view размеры экрана в CSS-пикселях
   * @returns {Planet} стартовая планета
   */
  reset(view) {
    this.planets.length = 0;
    this.paletteCursor = 0;
    this.spawnedCount = 0;
    const d = this.paramsForScore(0);
    const first = new Planet({
      x: view.w / 2,
      y: view.h * (1 - CFG.spawn.firstPlanetFromBottom),
      r: rand(d.rMin, d.rMax),
      omega: this.rollOmega(0),
      paletteIndex: this.paletteCursor++,
    });
    this.spawnedCount++;
    this.planets.push(first);
    this.top = first;
    return first;
  }

  /**
   * Параметры радиуса планет для текущего счёта (кривая сложности).
   * Omega считается отдельно, через глобальный множитель — см. rollOmega().
   * @param {number} score
   * @returns {{rMin:number,rMax:number}}
   */
  paramsForScore(score) {
    const D = CFG.difficulty;
    const tR = clamp01((score - D.calmUntil) / (D.radiusToScore - D.calmUntil));
    return {
      rMin: lerp(CFG.planet.rMin, D.radiusHardMin, tR),
      rMax: lerp(CFG.planet.rMax, D.radiusHardMax, tR),
    };
  }

  /**
   * Угловая скорость новой планеты: базовый диапазон, помноженный на глобальный
   * множитель сложности и небольшой случайный джиттер — растёт плавно у ВСЕХ
   * планет вместе со счётом, без скачков между соседними.
   * @param {number} score
   * @returns {number} rad/s, знак случайный
   */
  rollOmega(score) {
    const base = rand(CFG.planet.omegaMin, CFG.planet.omegaMax);
    const factor = difficultyFactor(score);
    const jitter = rand(1 - CFG.difficulty.omegaJitter, 1 + CFG.difficulty.omegaJitter);
    return base * factor * jitter * (Math.random() < 0.5 ? -1 : 1);
  }

  /**
   * Разложить лавовые дуги по поверхности планеты.
   * Держим два инварианта: суммарное покрытие не больше coverageMax окружности
   * и зазор между дугами не меньше gapMinDeg — безопасный сектор для посадки
   * существует всегда, тупиковую планету сгенерировать нельзя.
   * @param {number} score
   * @param {number} planetIndex порядковый номер планеты с рестарта (0-based)
   * @returns {{start:number,end:number,hot:boolean}[]} зоны в локальных углах
   */
  rollLava(score, planetIndex) {
    // Первые несколько планет после старта — всегда чистые, чтобы дать разогнаться.
    if (planetIndex < CFG.lava.safePlanets) return [];
    if (Math.random() >= lavaChance(score)) return [];

    const L = CFG.lava;
    const budget = TAU * L.coverageMax;
    const gap = deg(L.gapMinDeg);
    const wanted = Math.min(L.zonesMax, Math.random() < L.secondZoneChance ? 2 : 1);

    /** @type {{start:number,end:number,hot:boolean}[]} */
    const zones = [];
    let used = 0;

    for (let i = 0; i < wanted; i++) {
      const remaining = budget - used;
      if (remaining < deg(L.arcMinDeg)) break;
      const width = Math.min(rand(deg(L.arcMinDeg), deg(L.arcMaxDeg)), remaining);

      for (let attempt = 0; attempt < L.placeAttempts; attempt++) {
        const start = Math.random() * TAU;
        if (!this.arcFits(zones, start, width, gap)) continue;
        zones.push({ start, end: start + width, hot: Math.random() < L.hotChance });
        used += width;
        break;
      }
    }
    return zones;
  }

  /**
   * Влезает ли дуга [start, start+width] с зазором gap от уже размещённых.
   * @param {{start:number,end:number}[]} zones уже размещённые дуги
   * @param {number} start
   * @param {number} width
   * @param {number} gap минимальный зазор, rad
   * @returns {boolean}
   */
  arcFits(zones, start, width, gap) {
    for (const z of zones) {
      const zWidth = z.end - z.start;
      // Расширяем существующую дугу на gap с обеих сторон и проверяем пересечение.
      const from = norm(start - (z.start - gap));
      if (from <= zWidth + gap * 2) return false;
      const back = norm(z.start - (start - gap));
      if (back <= width + gap * 2) return false;
    }
    return true;
  }

  /**
   * Обновить мир: докрутить планеты, удалить ушедшие вниз, добить пул новыми.
   * @param {number} dt секунды фиксированного шага
   * @param {import('./camera.js').Camera} camera
   * @param {{w:number,h:number}} view
   * @param {number} score текущий счёт — от него зависит сложность спавна
   * @param {Planet|null} keep планета, которую нельзя удалять (под космонавтом)
   */
  update(dt, camera, view, score, keep) {
    for (const p of this.planets) p.update(dt);

    const cullY = camera.y + view.h + CFG.spawn.cullBelow;
    this.planets = this.planets.filter((p) => p === keep || (p.alive && p.y - p.r < cullY));

    while (this.planets.length < CFG.spawn.poolSize) this.spawnNext(view, score);
  }

  /**
   * Поставить следующую планету выше текущей верхней.
   * @param {{w:number,h:number}} view
   * @param {number} score
   */
  spawnNext(view, score) {
    const d = this.paramsForScore(score);
    const r = rand(d.rMin, d.rMax);
    const from = this.top;
    const minX = CFG.spawn.edgeMargin + r;
    const maxX = Math.max(minX, view.w - CFG.spawn.edgeMargin - r);

    let pos = null;
    for (let i = 0; i < CFG.spawn.placeAttempts && !pos; i++) {
      const candidate = this.tryPlace(from, r, minX, maxX);
      if (candidate && this.isClear(candidate, r)) pos = candidate;
    }
    // Фолбэк: строго вверх на минимальной дистанции — всегда достижимо.
    if (!pos) pos = { x: clamp(from.x, minX, maxX), y: from.y - CFG.spawn.distMin };

    const planet = new Planet({
      x: pos.x,
      y: pos.y,
      r,
      omega: this.rollOmega(score),
      paletteIndex: this.paletteCursor++,
    });
    planet.lava = this.rollLava(score, this.spawnedCount);
    this.spawnedCount++;
    this.planets.push(planet);
    this.top = planet;
  }

  /**
   * Подобрать позицию в конусе «вверх» на валидной дистанции.
   * @param {Planet} from
   * @param {number} r радиус новой планеты
   * @param {number} minX
   * @param {number} maxX
   * @returns {{x:number,y:number}|null}
   */
  tryPlace(from, r, minX, maxX) {
    const dist = rand(CFG.spawn.distMin, CFG.spawn.distMax);
    const cone = (CFG.spawn.coneDeg * Math.PI) / 180;
    const angle = -Math.PI / 2 + rand(-cone, cone); // -PI/2 — строго вверх
    let x = clamp(from.x + Math.cos(angle) * dist, minX, maxX);

    // После клампа по X держим ту же дистанцию, доводя её вертикалью:
    // так перелёт остаётся в пределах [distMin, distMax] и достижим.
    const dx = x - from.x;
    if (Math.abs(dx) > dist) return null;
    const y = from.y - Math.sqrt(dist * dist - dx * dx);
    return { x, y };
  }

  /**
   * Проверить, что новая планета не липнет к существующим.
   * @param {{x:number,y:number}} pos
   * @param {number} r
   * @returns {boolean}
   */
  isClear(pos, r) {
    for (const p of this.planets) {
      if (Math.hypot(pos.x - p.x, pos.y - p.y) < p.r + r + CFG.spawn.minGap) return false;
    }
    return true;
  }
}
