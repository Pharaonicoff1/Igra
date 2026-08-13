import {
  CFG, DEV, TRAP, difficultyFactor, effectiveMaxJumpDistance, fullLavaChance, lavaChance,
} from './config.js';
import { Planet } from './planet.js';

const TAU = Math.PI * 2;
const deg = (d) => (d * Math.PI) / 180;
const norm = (a) => ((a % TAU) + TAU) % TAU;
const rand = (a, b) => a + Math.random() * (b - a);

/**
 * Длина самой длинной цепочки true подряд в КОЛЬЦЕВОМ массиве.
 * Кольцевой — потому что углы замкнуты: валидная дуга может пересекать ноль.
 * @param {boolean[]} flags
 * @returns {number}
 */
function longestRun(flags) {
  const n = flags.length;
  if (flags.every(Boolean)) return n;
  let best = 0;
  let run = 0;
  // Два прохода подряд эмулируют замыкание кольца.
  for (let i = 0; i < n * 2; i++) {
    if (flags[i % n]) {
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return Math.min(best, n);
}
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
    /** Хвост омег последних планет — только для dev-диагностики роста сложности. */
    this.recentOmegas = [];
    /** Сколько раз валидатор не смог собрать проходимую планету и откатился. */
    this.fallbacks = 0;
    /** Статистика полностью лавовых планет: поставлено и отклонено по времени побега. */
    this.fullLavaPlaced = 0;
    this.fullLavaRejected = 0;
  }

  /**
   * Разложить все ловушки планеты: лава и лоза делят ОДИН бюджет покрытия,
   * поэтому суммарно ловушки не занимают больше coverageMax окружности.
   * @param {number} score
   * @param {number} planetIndex порядковый номер планеты с рестарта
   * @returns {{start:number,end:number,kind:string}[]}
   */
  rollTraps(score, planetIndex) {
    // Первые несколько планет после старта — всегда чистые, чтобы дать разогнаться.
    if (planetIndex < CFG.lava.safePlanets) return [];

    /** @type {{start:number,end:number,kind:string}[]} */
    const zones = [];
    let used = 0;

    if (Math.random() < lavaChance(score)) {
      const wanted = Math.min(CFG.lava.zonesMax, Math.random() < CFG.lava.secondZoneChance ? 2 : 1);
      for (let i = 0; i < wanted; i++) {
        const kind = Math.random() < CFG.lava.hotChance ? TRAP.HOT : TRAP.SMOLDER;
        used = this.addArc(zones, used, kind, CFG.lava.arcMinDeg, CFG.lava.arcMaxDeg);
      }
    }

    if (score >= CFG.vine.fromScore && Math.random() < CFG.vine.chance) {
      used = this.addArc(zones, used, TRAP.VINE, CFG.vine.arcMinDeg, CFG.vine.arcMaxDeg);
    }

    return zones;
  }

  /**
   * Добавить одну дугу заданного типа, не нарушая бюджет покрытия и зазоры.
   * @param {{start:number,end:number,kind:string}[]} zones уже размещённые дуги
   * @param {number} used занятая часть окружности, rad
   * @param {string} kind значение из TRAP
   * @param {number} minDeg минимальная ширина дуги, градусы
   * @param {number} maxDeg максимальная ширина дуги, градусы
   * @returns {number} новое значение used
   */
  addArc(zones, used, kind, minDeg, maxDeg) {
    const L = CFG.lava;
    const budget = TAU * L.coverageMax;
    const gap = deg(L.gapMinDeg);
    const remaining = budget - used;
    if (remaining < deg(minDeg)) return used;

    const width = Math.min(rand(deg(minDeg), deg(maxDeg)), remaining);
    for (let attempt = 0; attempt < L.placeAttempts; attempt++) {
      const start = Math.random() * TAU;
      if (!this.arcFits(zones, start, width, gap)) continue;
      zones.push({ start, end: start + width, kind });
      return used + width;
    }
    return used;
  }

  /**
   * Dev-диагностика: печатает текущий множитель сложности и среднюю |omega|
   * последних планет, чтобы рост было видно глазами, а не на слово.
   * @param {number} score
   * @param {number} omega омега только что созданной планеты
   */
  logDifficulty(score, omega) {
    if (!DEV) return;
    this.recentOmegas.push(Math.abs(omega));
    const window = CFG.difficulty.devLogEvery;
    if (this.recentOmegas.length > window) this.recentOmegas.shift();
    if (this.spawnedCount % window !== 0) return;
    const avg = this.recentOmegas.reduce((a, b) => a + b, 0) / this.recentOmegas.length;
    console.log(
      `[difficulty] score=${score} factor=${difficultyFactor(score).toFixed(3)} `
      + `avg|omega| последних ${this.recentOmegas.length}=${avg.toFixed(3)} rad/s`,
    );
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
    this.fallbacks = 0;
    this.fullLavaPlaced = 0;
    this.fullLavaRejected = 0;
    this.recentOmegas.length = 0;
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
    const wanted = Math.min(L.zonesMax, Math.random() < L.secondZoneChance ? 2 : 1);

    /** @type {{start:number,end:number,kind:string}[]} */
    const zones = [];
    let used = 0;
    for (let i = 0; i < wanted; i++) {
      const kind = Math.random() < L.hotChance ? TRAP.HOT : TRAP.SMOLDER;
      used = this.addArc(zones, used, kind, L.arcMinDeg, L.arcMaxDeg);
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
   * Множитель дальности/скорости для прыжка С этой планеты.
   * Консервативно: если на планете вообще есть лоза, считаем, что игрок сел
   * именно в неё — иначе валидатор одобрит переход, невозможный для опутанного.
   * @param {Planet} from
   * @returns {number} 1 или CFG.vine.jumpFactor
   */
  vineFactorFor(from) {
    return from.hasTrap(TRAP.VINE) ? CFG.vine.jumpFactor : 1;
  }

  /**
   * Трассировка одного прыжка: от точки орбиты по касательной до захвата целью.
   * @param {Planet} from
   * @param {Planet} to
   * @param {number} worldTheta мировой угол точки отрыва на орбите from
   * @param {number} maxDist потолок дальности для этого прыжка, px
   * @returns {{dist:number, angle:number}|null} длина траектории и МИРОВОЙ угол посадки
   */
  traceJump(from, to, worldTheta, maxDist) {
    const R = from.orbitRadius;
    const px = from.x + Math.cos(worldTheta) * R;
    const py = from.y + Math.sin(worldTheta) * R;

    const sign = Math.sign(from.omega) || 1;
    const dx = -Math.sin(worldTheta) * sign;
    const dy = Math.cos(worldTheta) * sign;

    const relX = to.x - px;
    const relY = to.y - py;
    const along = relX * dx + relY * dy;
    if (along <= 0) return null; // цель позади направления отрыва

    const perp = Math.abs(relX * dy - relY * dx);
    const cr = to.captureRadius;
    if (perp >= cr) return null; // прямая проходит мимо радиуса захвата

    // Первое пересечение с окружностью захвата — именно там сработает посадка.
    const dist = along - Math.sqrt(cr * cr - perp * perp);
    if (dist <= 0 || dist > maxDist) return null;

    const lx = px + dx * dist;
    const ly = py + dy * dist;
    return { dist, angle: Math.atan2(ly - to.y, lx - to.x) };
  }

  /**
   * Подробный разбор решаемости перехода from -> to.
   * @param {Planet} from
   * @param {Planet} to
   * @param {number} score
   * @returns {{valid:number, bestRun:number, ok:boolean, total:number}}
   */
  solvability(from, to, score) {
    const stepRad = deg(CFG.solver.angleStepDeg);
    const total = Math.round(TAU / stepRad);
    const vine = this.vineFactorFor(from);
    const maxDist = effectiveMaxJumpDistance(score) * vine;
    const speed = CFG.player.jumpSpeed * vine;

    const flags = new Array(total).fill(false);
    let valid = 0;

    for (let i = 0; i < total; i++) {
      const local = i * stepRad;

      // С красного сектора стартовать нельзя: игрок там мгновенно погибает,
      // то есть физически не может оказаться в этой точке орбиты.
      const startZone = from.lavaAtLocal(local);
      if (startZone && startZone.kind === TRAP.HOT) continue;

      const hit = this.traceJump(from, to, local + from.phase, maxDist);
      if (!hit) continue;

      // Цель успевает провернуться за время полёта — считаем угол посадки
      // в её локальной системе на МОМЕНТ касания, а не на момент отрыва.
      const flightTime = hit.dist / speed;
      const landingLocal = hit.angle - (to.phase + to.omega * flightTime);
      const landZone = to.lavaAtLocal(landingLocal);
      if (landZone && landZone.kind === TRAP.HOT) continue;

      flags[i] = true;
      valid++;
    }

    return { valid, bestRun: longestRun(flags), ok: longestRun(flags) >= CFG.solver.minConsecutive, total };
  }

  /**
   * Худшее время побега с планеты from на планету to, в секундах.
   *
   * Складывается из двух частей:
   *  - ожидание нужного угла отрыва: планета вращается, и в худшем случае игрок
   *    только что упустил валидное окно, то есть ждёт полный оборот 2PI/omega;
   *  - полёт: берём САМУЮ ДЛИННУЮ из валидных траекторий, потому что игрок
   *    вынужден лететь тем окном, которое подошло первым.
   * Время считается от АКТУАЛЬНОЙ omega планеты, а не от базовой: с ростом
   * сложности вращение ускоряется и ожидание сокращается.
   *
   * @param {Planet} from
   * @param {Planet} to
   * @param {number} score
   * @returns {number|null} секунды, либо null если валидных углов нет вовсе
   */
  escapeTime(from, to, score) {
    const stepRad = deg(CFG.solver.angleStepDeg);
    const total = Math.round(TAU / stepRad);
    const vine = this.vineFactorFor(from);
    const maxDist = effectiveMaxJumpDistance(score) * vine;
    const speed = CFG.player.jumpSpeed * vine;

    let worstDist = -1;
    for (let i = 0; i < total; i++) {
      const local = i * stepRad;
      const startZone = from.lavaAtLocal(local);
      if (startZone && startZone.kind === TRAP.HOT) continue;

      const hit = this.traceJump(from, to, local + from.phase, maxDist);
      if (!hit) continue;

      const flightTime = hit.dist / speed;
      const landingLocal = hit.angle - (to.phase + to.omega * flightTime);
      const landZone = to.lavaAtLocal(landingLocal);
      if (landZone && landZone.kind === TRAP.HOT) continue;

      if (hit.dist > worstDist) worstDist = hit.dist;
    }

    if (worstDist < 0) return null;
    const wait = TAU / Math.abs(from.omega);
    return wait + worstDist / speed;
  }

  /**
   * Можно ли вообще улететь с from и живым сесть на to.
   * Требуем не один валидный угол, а минимум CFG.solver.minConsecutive подряд:
   * единственный пиксельно точный угол игрок физически не поймает.
   * @param {Planet} from
   * @param {Planet} to
   * @param {number} score
   * @returns {boolean}
   */
  isSolvable(from, to, score) {
    return this.solvability(from, to, score).ok;
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

    const cullY = camera.y + view.h + view.h * CFG.spawn.despawnMarginBottom;
    this.planets = this.planets.filter((p) => p === keep || (p.alive && p.y - p.r < cullY));

    this.fill(camera, view, score);
  }

  /**
   * Догнать цепочку до нужной глубины: и по количеству планет в пуле, и по
   * высоте фронта спавна. Второе условие важнее — именно оно даёт планете
   * время пожить за кадром, прежде чем игрок её увидит.
   * @param {import('./camera.js').Camera} camera
   * @param {{w:number,h:number}} view
   * @param {number} score
   */
  fill(camera, view, score) {
    const frontier = camera.y - view.h * CFG.spawn.spawnMarginTop;
    let guard = CFG.spawn.maxPool;
    while (
      guard-- > 0
      && this.planets.length < CFG.spawn.maxPool
      && (this.planets.length < CFG.spawn.poolSize || this.top.y > frontier)
    ) {
      this.spawnNext(view, score);
    }
  }

  /**
   * Поставить следующую планету выше текущей верхней.
   * @param {{w:number,h:number}} view
   * @param {number} score
   */
  spawnNext(view, score) {
    const from = this.top;

    // Каждая планета проходит валидацию решаемости. Не прошла — генерируем
    // заново (другая позиция, омега, секторы), и так до maxAttempts раз.
    let planet = null;
    for (let attempt = 0; attempt < CFG.solver.maxAttempts && !planet; attempt++) {
      const candidate = this.makeCandidate(view, score, from);
      if (this.isSolvable(from, candidate, score)) planet = candidate;
    }

    // Откат: планета без единой ловушки, поставленная строго вверх на
    // минимальной дистанции. Такой переход решается всегда.
    if (!planet) {
      this.fallbacks++;
      planet = this.makeSafeCandidate(view, score, from);
      if (DEV) {
        const s = this.solvability(from, planet, score);
        console.warn(
          `[solver] откат на безопасную планету #${this.spawnedCount} `
          + `(score=${score}, всего откатов=${this.fallbacks}); `
          + `запасная: валидных углов=${s.valid}/${s.total}, подряд=${s.bestRun}`,
        );
      }
    }

    // Попытка сделать планету целиком лавовой. Успех возможен только вместе с
    // преемником: без него нельзя доказать, что игрок успеет уйти до сгорания.
    const successor = this.tryMakeFullLava(planet, from, view, score);

    this.commit(planet, score);
    if (successor) this.commit(successor, score);
  }

  /**
   * Зафиксировать планету в мире.
   * @param {Planet} planet
   * @param {number} score
   */
  commit(planet, score) {
    planet.paletteIndex = this.paletteCursor++;
    this.spawnedCount++;
    this.logDifficulty(score, planet.omega);
    this.planets.push(planet);
    this.top = planet;
  }

  /**
   * Попробовать превратить планету в полностью лавовую.
   *
   * ЖЁСТКОЕ ТРЕБОВАНИЕ пункта: ставить такую планету можно, только если уже
   * доказано, что следующая достижима заметно быстрее таймера сгорания. Но на
   * момент спавна следующей планеты ещё нет — поэтому здесь же генерируется и
   * возвращается преемник, который будет зафиксирован вместе с ней. Не удалось
   * подобрать преемника с нужным запасом — планета остаётся обычной.
   *
   * @param {Planet} planet кандидат на превращение
   * @param {Planet} from планета, с которой на неё прыгают
   * @param {{w:number,h:number}} view
   * @param {number} score
   * @returns {Planet|null} преемник, если превращение состоялось
   */
  tryMakeFullLava(planet, from, view, score) {
    if (score < CFG.fullLava.fromScore) return null;
    if (from.fullLava) return null; // никогда две подряд
    if (Math.random() >= fullLavaChance(score)) return null;

    // Примеряем: вся окружность — тлеющая лава, других ловушек нет.
    const savedLava = planet.lava;
    planet.lava = [{ start: 0, end: TAU, kind: TRAP.SMOLDER }];
    planet.fullLava = true;

    // Смена ловушек не должна сломать уже проверенный вход на планету.
    // Тлеющая лава посадку не запрещает, но проверяем явно, а не на слово.
    if (this.isSolvable(from, planet, score)) {
      const budget = CFG.lava.smolderDeathTime - CFG.fullLava.escapeMargin;
      for (let i = 0; i < CFG.fullLava.lookaheadAttempts; i++) {
        const next = this.makeCandidate(view, score, planet);
        if (!this.isSolvable(planet, next, score)) continue;
        const escape = this.escapeTime(planet, next, score);
        if (escape !== null && escape <= budget) {
          this.fullLavaPlaced++;
          return next;
        }
      }
    }

    // Не доказали побег — откатываем превращение.
    planet.lava = savedLava;
    planet.fullLava = false;
    this.fullLavaRejected++;
    return null;
  }

  /**
   * Собрать кандидата на следующую планету: позиция, радиус, омега, ловушки.
   * @param {{w:number,h:number}} view
   * @param {number} score
   * @param {Planet} from планета, с которой на неё придётся прыгать
   * @returns {Planet}
   */
  makeCandidate(view, score, from) {
    const d = this.paramsForScore(score);
    const r = rand(d.rMin, d.rMax);
    const minX = CFG.spawn.edgeMargin + r;
    const maxX = Math.max(minX, view.w - CFG.spawn.edgeMargin - r);

    let pos = null;
    for (let i = 0; i < CFG.spawn.placeAttempts && !pos; i++) {
      const candidate = this.tryPlace(from, r, minX, maxX);
      if (candidate && this.isClear(candidate, r)) pos = candidate;
    }
    // Фолбэк по позиции: строго вверх на минимальной дистанции.
    if (!pos) pos = { x: clamp(from.x, minX, maxX), y: from.y - CFG.spawn.distMin };

    const planet = new Planet({
      x: pos.x,
      y: pos.y,
      r,
      omega: this.rollOmega(score),
      age: rand(CFG.spawn.preRollMin, CFG.spawn.preRollMax),
    });
    planet.lava = this.rollTraps(score, this.spawnedCount);
    return planet;
  }

  /**
   * Заведомо проходимый вариант. Не «ставим вверх и надеемся»: сначала находим
   * свободный от красной лавы угол отрыва на исходной планете, затем ставим
   * новую планету ПРЯМО НА его траектории. Тогда прямая проходит через центр
   * цели (промах невозможен), а на цели нет ловушек — сесть можно под любым углом.
   * @param {{w:number,h:number}} view
   * @param {number} score
   * @param {Planet} from
   * @returns {Planet}
   */
  makeSafeCandidate(view, score, from) {
    const d = this.paramsForScore(score);
    const r = rand(d.rMin, d.rMax);
    const minX = CFG.spawn.edgeMargin + r;
    const maxX = Math.max(minX, view.w - CFG.spawn.edgeMargin - r);
    const cr = r + CFG.player.captureMargin;
    const maxDist = effectiveMaxJumpDistance(score) * this.vineFactorFor(from);

    // Длина траектории: с запасом от потолка и такая, чтобы планеты не слиплись.
    const R = from.orbitRadius;
    const needApart = from.r + r + CFG.spawn.minGap;
    const minTravel = Math.sqrt(Math.max(0, needApart * needApart - R * R));
    const travel = clamp(
      Math.max(minTravel, CFG.spawn.distMin - cr),
      0,
      maxDist * CFG.spawn.safeTravelRatio,
    );

    const stepRad = deg(CFG.solver.angleStepDeg);
    const total = Math.round(TAU / stepRad);
    const need = CFG.solver.minConsecutive;

    // Кандидаты: свободный угол отрыва × несколько длин траектории.
    // Разные длины нужны, чтобы уместить планету в границы экрана, когда
    // единственное свободное окно смотрит вбок.
    const candidates = [];
    for (let i = 0; i < total; i++) {
      // Требуем не один свободный угол, а целое окно вокруг него: игрок должен
      // иметь возможность промахнуться по времени и всё равно улететь живым.
      let windowClear = true;
      for (let k = -Math.floor(need / 2); k <= Math.floor(need / 2); k++) {
        const a = ((i + k) % total + total) % total;
        const z = from.lavaAtLocal(a * stepRad);
        if (z && z.kind === TRAP.HOT) { windowClear = false; break; }
      }
      if (!windowClear) continue;

      const theta = i * stepRad + from.phase;
      const px = from.x + Math.cos(theta) * R;
      const py = from.y + Math.sin(theta) * R;
      const sign = Math.sign(from.omega) || 1;
      const dx = -Math.sin(theta) * sign;
      const dy = Math.cos(theta) * sign;

      for (let f = 1; f >= 0.45; f -= 0.15) {
        const t = Math.max(minTravel, travel * f);
        const cx = px + dx * (t + cr);
        const cy = py + dy * (t + cr);
        if (cx < minX || cx > maxX) continue;
        candidates.push({ x: cx, y: cy, rises: cy <= from.y - CFG.spawn.safeMinRise });
      }
    }

    // Сначала те, что ведут вверх (камера должна продолжать подъём), внутри
    // группы — самые высокие.
    candidates.sort((a, b) => (a.rises === b.rises ? a.y - b.y : (a.rises ? -1 : 1)));

    const build = (pos) => {
      const planet = new Planet({
        x: pos.x,
        y: pos.y,
        r,
        omega: this.rollOmega(score),
        age: rand(CFG.spawn.preRollMin, CFG.spawn.preRollMax),
      });
      planet.lava = []; // ловушек нет: садиться на цель безопасно под любым углом
      return planet;
    };

    // Берём первого кандидата, который реально проходит валидацию, а не первого
    // «на вид подходящего» — откат обязан быть проходимым по построению И по факту.
    for (const pos of candidates) {
      const planet = build(pos);
      if (this.isSolvable(from, planet, score)) return planet;
    }

    // Патология: свободных окон нет вообще. Возвращаем лучшее из возможного.
    return build(candidates[0] ?? { x: clamp(from.x, minX, maxX), y: from.y - CFG.spawn.distMin });
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
