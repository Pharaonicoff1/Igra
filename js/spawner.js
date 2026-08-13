import { CFG } from './config.js';
import { Planet } from './planet.js';

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
  }

  /**
   * Сбросить мир и создать стартовую планету.
   * @param {{w:number,h:number}} view размеры экрана в CSS-пикселях
   * @returns {Planet} стартовая планета
   */
  reset(view) {
    this.planets.length = 0;
    this.paletteCursor = 0;
    const d = this.paramsForScore(0);
    const first = new Planet({
      x: view.w / 2,
      y: view.h * (1 - CFG.spawn.firstPlanetFromBottom),
      r: rand(d.rMin, d.rMax),
      omega: rand(d.omegaMin, d.omegaMax) * (Math.random() < 0.5 ? -1 : 1),
      paletteIndex: this.paletteCursor++,
    });
    this.planets.push(first);
    this.top = first;
    return first;
  }

  /**
   * Параметры планет для текущего счёта (кривая сложности).
   * @param {number} score
   * @returns {{rMin:number,rMax:number,omegaMin:number,omegaMax:number}}
   */
  paramsForScore(score) {
    const D = CFG.difficulty;
    const tR = clamp01((score - D.calmUntil) / (D.radiusToScore - D.calmUntil));
    const tW = clamp01((score - D.calmUntil) / (D.omegaToScore - D.calmUntil));
    return {
      rMin: lerp(CFG.planet.rMin, D.radiusHardMin, tR),
      rMax: lerp(CFG.planet.rMax, D.radiusHardMax, tR),
      omegaMin: lerp(CFG.planet.omegaMin, D.omegaHardMin, tW),
      omegaMax: lerp(CFG.planet.omegaMax, D.omegaHardMax, tW),
    };
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
      omega: rand(d.omegaMin, d.omegaMax) * (Math.random() < 0.5 ? -1 : 1),
      paletteIndex: this.paletteCursor++,
    });
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
