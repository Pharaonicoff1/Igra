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
    /**
     * Астероиды живут ОТДЕЛЬНО от цепочки: они не занимают слот в пуле планет,
     * не участвуют в nextInChain как звено маршрута и не влияют на валидацию
     * переходов планета -> планета. Это чисто побочные цели.
     * @type {Planet[]}
     */
    this.asteroids = [];
    /**
     * Всё, на что можно сесть: планеты + астероиды. Один переиспользуемый
     * массив — он пересобирается при изменении мира, а не создаётся каждый кадр.
     * @type {Planet[]}
     */
    this.landables = [];
    /** Сколько астероидов поставлено и сколько отвергнуто валидатором. */
    this.asteroidsPlaced = 0;
    this.asteroidsRejected = 0;
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
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   * @param {number} planetIndex порядковый номер планеты с рестарта
   * @returns {{start:number,end:number,kind:string}[]}
   */
  rollTraps(passed, planetIndex) {
    // Первые несколько планет после старта — всегда чистые, чтобы дать разогнаться.
    if (planetIndex < CFG.lava.safePlanets) return [];

    /** @type {{start:number,end:number,kind:string}[]} */
    const zones = [];
    let used = 0;

    if (Math.random() < lavaChance(passed)) {
      const wanted = Math.min(CFG.lava.zonesMax, Math.random() < CFG.lava.secondZoneChance ? 2 : 1);
      for (let i = 0; i < wanted; i++) {
        const kind = Math.random() < CFG.lava.hotChance ? TRAP.HOT : TRAP.SMOLDER;
        used = this.addArc(zones, used, kind, CFG.lava.arcMinDeg, CFG.lava.arcMaxDeg);
      }
    }

    if (passed >= CFG.vine.fromPassed && Math.random() < CFG.vine.chance) {
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
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   * @param {number} omega омега только что созданной планеты
   */
  logDifficulty(passed, omega) {
    if (!DEV) return;
    this.recentOmegas.push(Math.abs(omega));
    const window = CFG.difficulty.devLogEvery;
    if (this.recentOmegas.length > window) this.recentOmegas.shift();
    if (this.spawnedCount % window !== 0) return;
    const avg = this.recentOmegas.reduce((a, b) => a + b, 0) / this.recentOmegas.length;
    console.log(
      `[difficulty] passed=${passed} factor=${difficultyFactor(passed).toFixed(3)} `
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
    this.asteroids.length = 0;
    this.landables.length = 0;
    this.asteroidsPlaced = 0;
    this.asteroidsRejected = 0;
    this.paletteCursor = 0;
    this.spawnedCount = 0;
    this.fallbacks = 0;
    this.fullLavaPlaced = 0;
    this.fullLavaRejected = 0;
    this.recentOmegas.length = 0;
    const d = this.paramsForProgress(0);
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
    this.syncLandables();
    return first;
  }

  /**
   * Параметры радиуса планет для текущего прогресса (кривая сложности).
   * Omega считается отдельно, через глобальный множитель — см. rollOmega().
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   * @returns {{rMin:number,rMax:number}}
   */
  paramsForProgress(passed) {
    const D = CFG.difficulty;
    const tR = clamp01((passed - D.calmUntil) / (D.radiusToPassed - D.calmUntil));
    return {
      rMin: lerp(CFG.planet.rMin, D.radiusHardMin, tR),
      rMax: lerp(CFG.planet.rMax, D.radiusHardMax, tR),
    };
  }

  /**
   * Угловая скорость новой планеты: базовый диапазон, помноженный на глобальный
   * множитель сложности и небольшой случайный джиттер — растёт плавно у ВСЕХ
   * планет вместе с прогрессом, без скачков между соседними.
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   * @returns {number} rad/s, знак случайный
   */
  rollOmega(passed) {
    const base = rand(CFG.planet.omegaMin, CFG.planet.omegaMax);
    const factor = difficultyFactor(passed);
    const jitter = rand(1 - CFG.difficulty.omegaJitter, 1 + CFG.difficulty.omegaJitter);
    return base * factor * jitter * (Math.random() < 0.5 ? -1 : 1);
  }

  /**
   * Разложить лавовые дуги по поверхности планеты.
   * Держим два инварианта: суммарное покрытие не больше coverageMax окружности
   * и зазор между дугами не меньше gapMinDeg — безопасный сектор для посадки
   * существует всегда, тупиковую планету сгенерировать нельзя.
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   * @param {number} planetIndex порядковый номер планеты с рестарта (0-based)
   * @returns {{start:number,end:number,hot:boolean}[]} зоны в локальных углах
   */
  rollLava(passed, planetIndex) {
    // Первые несколько планет после старта — всегда чистые, чтобы дать разогнаться.
    if (planetIndex < CFG.lava.safePlanets) return [];
    if (Math.random() >= lavaChance(passed)) return [];

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
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   * @returns {{valid:number, bestRun:number, ok:boolean, total:number}}
   */
  solvability(from, to, passed) {
    const stepRad = deg(CFG.solver.angleStepDeg);
    const total = Math.round(TAU / stepRad);
    const vine = this.vineFactorFor(from);
    const maxDist = effectiveMaxJumpDistance(passed) * vine;
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
   * Следующая планета в цепочке за данной. Массив хранится в порядке спавна,
   * поэтому цепочка — это просто соседний элемент. Фолбэк на случай, если
   * планеты уже нет в пуле: ближайшая планета выше.
   * @param {Planet|null} planet
   * @returns {Planet|null}
   */
  nextInChain(planet) {
    if (!planet) return null;
    // С астероида «следующая» — это возврат на маршрут, а не движение вперёд.
    // Планета возврата зафиксирована при спавне и проверена валидатором.
    if (planet.asteroid) {
      return planet.returnTo && this.planets.includes(planet.returnTo)
        ? planet.returnTo
        : this.nearestAhead(planet);
    }
    const i = this.planets.indexOf(planet);
    if (i >= 0 && i + 1 < this.planets.length) return this.planets[i + 1];
    return this.nearestAhead(planet);
  }

  /**
   * Ближайшая планета цепочки выше данной точки. Фолбэк на случай, когда
   * объекта уже нет в пуле (или это астероид, чья планета возврата умерла).
   * @param {Planet} from
   * @returns {Planet|null}
   */
  nearestAhead(from) {
    let best = null;
    for (const p of this.planets) {
      if (p === from || p.y >= from.y) continue;
      if (!best || p.y > best.y) best = p;
    }
    return best;
  }

  /** Пересобрать список всего, на что можно приземлиться. */
  syncLandables() {
    this.landables.length = 0;
    for (const p of this.planets) this.landables.push(p);
    for (const a of this.asteroids) this.landables.push(a);
  }

  /**
   * Куда игрок прилетит этим прыжком — планета, на которую камера поведёт взгляд.
   *
   * Луч сэмплируется шагами по predictStep, а позиции планет пересчитываются на
   * момент времени соответствующей точки. Аналитическое пересечение с
   * окружностью здесь нельзя: у движущейся планеты оно даст неверную цель.
   *
   * @param {import('./player.js').Player} player уже в полёте: заданы позиция и скорость
   * @param {number} maxDist потолок дальности этого прыжка, px
   * @returns {Planet|null} null, если луч ушёл в пустоту — тогда камера ведёт космонавта
   */
  predictTarget(player, maxDist) {
    const speed = Math.hypot(player.vx, player.vy);
    if (speed <= 0 || !player.ignore) return null;
    // Отрыв уже случился: планета-источник лежит в player.ignore, а theta
    // прыжок не менял. Значит это ровно тот же луч, что и в traceJumpRay.
    return this.traceJumpRay(player.ignore, player.theta, maxDist, speed);
  }

  /**
   * Первая планета на луче прыжка с планеты from под мировым углом theta.
   *
   * ЕДИНСТВЕННАЯ реализация трассировки для всех потребителей: предсказание
   * цели камеры и проверка «окно для прыжка открылось» у буста вращения.
   * Дублировать нельзя — разъедется.
   *
   * Луч сэмплируется шагами по predictStep, позиции планет пересчитываются на
   * момент времени точки: аналитика с движущейся окружностью дала бы неверную
   * цель. maxDist и speed передаёт вызывающий — в них уже учтены и рост
   * сложности, и штраф лозы.
   *
   * @param {Planet} from планета, с которой прыгаем (исключается из поиска)
   * @param {number} theta мировой угол точки отрыва на орбите
   * @param {number} maxDist потолок дальности прыжка, px
   * @param {number} speed скорость полёта, px/s — нужна для пересчёта времени
   * @returns {Planet|null}
   */
  traceJumpRay(from, theta, maxDist, speed) {
    if (!from || speed <= 0) return null;

    const R = from.orbitRadius;
    const originX = from.x + Math.cos(theta) * R;
    const originY = from.y + Math.sin(theta) * R;

    // Направление отрыва — касательная в сторону вращения. Знак берём от
    // БАЗОВОЙ omega: буст меняет только модуль, направление прыжка от него
    // не зависит.
    const sign = Math.sign(from.omega) || 1;
    const dirX = -Math.sin(theta) * sign;
    const dirY = Math.cos(theta) * sign;

    const step = CFG.camera.predictStep;
    for (let d = 0; d <= maxDist; d += step) {
      const t = d / speed; // время от отрыва до этой точки луча
      const px = originX + dirX * d;
      const py = originY + dirY * d;

      // Астероиды тоже ловят луч: камера обязана предсказывать посадку на них,
      // иначе кадр поедет не туда, а буст вращения гаснет по «окну» в цепочку.
      for (const p of this.landables) {
        if (!p.alive || p === from) continue; // стартовую планету пропускаем
        const pos = p.positionAt(t);
        const cr = p.captureRadius;
        const dx = px - pos.x;
        const dy = py - pos.y;
        if (dx * dx + dy * dy < cr * cr) return p;
      }
    }
    return null;
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
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   * @returns {number|null} секунды, либо null если валидных углов нет вовсе
   */
  escapeTime(from, to, passed) {
    const stepRad = deg(CFG.solver.angleStepDeg);
    const total = Math.round(TAU / stepRad);
    const vine = this.vineFactorFor(from);
    const maxDist = effectiveMaxJumpDistance(passed) * vine;
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
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   * @returns {boolean}
   */
  isSolvable(from, to, passed) {
    return this.solvability(from, to, passed).ok;
  }

  /**
   * Обновить мир: докрутить планеты, удалить ушедшие вниз, добить пул новыми.
   * @param {number} dt секунды фиксированного шага
   * @param {import('./camera.js').Camera} camera
   * @param {{w:number,h:number}} view
   * @param {number} passed пройдено планет — от этого зависит сложность спавна
   * @param {Planet|null} keep планета, которую нельзя удалять (под космонавтом)
   */
  update(dt, camera, view, passed, keep) {
    for (const p of this.planets) p.update(dt);
    for (const a of this.asteroids) a.update(dt);

    // Границы жизни планеты — прямоугольник вокруг камеры (она ездит и вбок).
    // Считаем от ВИДИМОЙ области: при зуме меньше 1 она больше экрана, и от
    // размеров экрана планеты умирали бы прямо в кадре.
    // Планеты ВЫШЕ камеры не трогаем никогда: это уже построенная цепочка
    // вперёд, удалить её значит порвать маршрут.
    const vis = camera.visibleSize(view);
    const bottom = camera.y + vis.h + vis.h * CFG.spawn.despawnMarginBottom;
    const side = vis.w * CFG.spawn.despawnMarginSide;
    const left = camera.x - side;
    const right = camera.x + vis.w + side;

    this.planets = this.planets.filter((p) => {
      if (p === keep) return true;                       // планета под космонавтом
      if (!p.alive) return false;
      if (p.y + p.r < camera.y) return true;             // впереди по маршруту
      if (p.y - p.r > bottom) return false;              // ушла вниз за спину
      return p.x + p.r > left && p.x - p.r < right;      // не улетела вбок
    });

    // Астероиды — по тем же прямоугольным границам, но БЕЗ поблажки «впереди
    // по маршруту»: они не звено цепочки, и держать их выше камеры незачем.
    // Исключение — тот, на котором стоит игрок, и тот, чья планета возврата
    // ещё жива и видна: оборвать путь назад нельзя.
    this.asteroids = this.asteroids.filter((a) => {
      if (a === keep) return true;
      if (!a.alive) return false;
      if (a.y - a.r > bottom) return false;
      if (a.x + a.r < left || a.x - a.r > right) return false;
      return true;
    });

    this.fill(camera, view, passed);
    this.syncLandables();
  }

  /**
   * Догнать цепочку до нужной глубины: и по количеству планет в пуле, и по
   * высоте фронта спавна. Второе условие важнее — именно оно даёт планете
   * время пожить за кадром, прежде чем игрок её увидит.
   * @param {import('./camera.js').Camera} camera
   * @param {{w:number,h:number}} view
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   */
  fill(camera, view, passed) {
    // Фронт спавна тоже от видимой области, а не от экрана.
    const frontier = camera.y - camera.visibleSize(view).h * CFG.spawn.spawnMarginTop;
    let guard = CFG.spawn.maxPool;
    while (
      guard-- > 0
      && this.planets.length < CFG.spawn.maxPool
      && (this.planets.length < CFG.spawn.poolSize || this.top.y > frontier)
    ) {
      this.spawnNext(view, passed);
    }
  }

  /**
   * Поставить следующую планету выше текущей верхней.
   * @param {{w:number,h:number}} view
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   */
  spawnNext(view, passed) {
    const from = this.top;

    // Каждая планета проходит валидацию решаемости. Не прошла — генерируем
    // заново (другая позиция, омега, секторы), и так до maxAttempts раз.
    let planet = null;
    for (let attempt = 0; attempt < CFG.solver.maxAttempts && !planet; attempt++) {
      const candidate = this.makeCandidate(view, passed, from);
      if (this.isSolvable(from, candidate, passed)) planet = candidate;
    }

    // Откат: планета без единой ловушки, поставленная строго вверх на
    // минимальной дистанции. Такой переход решается всегда.
    if (!planet) {
      this.fallbacks++;
      planet = this.makeSafeCandidate(view, passed, from);
      if (DEV) {
        const s = this.solvability(from, planet, passed);
        console.warn(
          `[solver] откат на безопасную планету #${this.spawnedCount} `
          + `(passed=${passed}, всего откатов=${this.fallbacks}); `
          + `запасная: валидных углов=${s.valid}/${s.total}, подряд=${s.bestRun}`,
        );
      }
    }

    // Попытка сделать планету целиком лавовой. Успех возможен только вместе с
    // преемником: без него нельзя доказать, что игрок успеет уйти до сгорания.
    const successor = this.tryMakeFullLava(planet, from, view, passed);

    this.commit(planet, passed);
    if (successor) this.commit(successor, passed);

    // Астероид подвешивается к ПРЕДЫДУЩЕЙ планете: только теперь у неё есть
    // преемник, а значит есть чему быть планетой возврата. Игрок до неё ещё
    // не долетел — цепочка строится с запасом вперёд.
    this.trySpawnAsteroid(from, planet, view, passed);
  }

  /**
   * Попробовать подвесить астероид сбоку от планеты `from`.
   *
   * Вызывается ПОСЛЕ того, как у `from` появился преемник в цепочке: без него
   * нельзя доказать, что с астероида есть путь обратно на маршрут.
   *
   * Проверок четыре, и любая проваленная означает «не ставим здесь»:
   *  1) астероид достижим с `from` — тот же isSolvable, что и для цепочки;
   *  2) с астероида достижима планета возврата — так же строго;
   *  3) если на астероиде тлеющая лава, уход обязан укладываться в таймер
   *     сгорания с запасом: сесть в лаву и не успеть уйти = смерть, а бонусная
   *     цель убивать забег не должна;
   *  4) астероид не перехватывает основной маршрут — после его появления у
   *     перехода from -> next обязано остаться достаточно углов, на которых
   *     луч доходит до планеты, а не втыкается в астероид.
   *
   * @param {Planet} from планета, с которой на астероид прыгают
   * @param {Planet} back планета цепочки, на которую с астероида возвращаются
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   * @returns {Planet|null} поставленный астероид
   */
  trySpawnAsteroid(from, back, view, passed) {
    const A = CFG.asteroid;
    if (!from || !back) return null;
    if (Math.random() >= A.chance) return null;
    // На полностью лавовой планете игрок уже под таймером: крюк в сторону
    // там означает почти гарантированную смерть.
    if (from.fullLava) return null;

    const maxDist = effectiveMaxJumpDistance(passed) * this.vineFactorFor(from) * A.distMaxRatio;

    for (let attempt = 0; attempt < A.placeAttempts; attempt++) {
      const candidate = this.makeAsteroid(from, maxDist, view);
      if (!candidate) continue;
      candidate.returnTo = back;

      if (!this.isSolvable(from, candidate, passed)) continue;      // (1)
      if (!this.isSolvable(candidate, back, passed)) continue;      // (2)
      if (!this.asteroidEscapable(candidate, back, passed)) continue; // (3)
      if (this.blocksChain(candidate, from, back, passed)) continue;  // (4)

      this.asteroids.push(candidate);
      this.asteroidsPlaced++;
      this.syncLandables();
      return candidate;
    }

    this.asteroidsRejected++;
    return null;
  }

  /**
   * Собрать кандидата-астероид сбоку от планеты.
   * @param {Planet} from
   * @param {number} maxDist потолок расстояния между центрами, px
   * @param {{w:number,h:number}} view нужен, чтобы цель не улетела за кромку кадра
   * @returns {Planet|null} null, если позиция не годится
   */
  makeAsteroid(from, maxDist, view) {
    const A = CFG.asteroid;
    const r = rand(A.rMin, A.rMax);

    // Строго вбок: направление в пределах sideSpreadDeg от горизонтали, влево
    // или вправо. Так астероид не притворяется следующим звеном маршрута.
    const side = Math.random() < 0.5 ? 0 : Math.PI;
    const angle = side + deg(rand(-A.sideSpreadDeg, A.sideSpreadDeg));

    // Ближняя граница: за орбитой источника с зазором — иначе прыжок туда
    // геометрически невозможен (касательная проходит на расстоянии orbitRadius).
    const distMin = from.orbitRadius + r + A.distMinGap;

    // Дальняя граница — минимум из двух: потолок дальности прыжка и предел
    // горизонтального выноса. Второй обычно строже: прыжок достаёт дальше,
    // чем видит экран, и без него цель оказывается вечно за кромкой.
    const cos = Math.max(Math.abs(Math.cos(angle)), 0.2);
    const sideLimit = (view.w * A.maxSideOffset) / cos;
    const distMax = Math.min(maxDist, sideLimit);
    if (distMin >= distMax) return null;
    const dist = rand(distMin, distMax);

    const x = from.x + Math.cos(angle) * dist;
    const y = from.y + Math.sin(angle) * dist;

    // Не влезаем в другие объекты — ни в планеты, ни в соседние астероиды.
    for (const p of this.landables) {
      if (Math.hypot(p.x - x, p.y - y) < p.r + r + A.minGap) return null;
    }

    const asteroid = new Planet({
      x, y, r,
      omega: rand(A.omegaMin, A.omegaMax) * (Math.random() < 0.5 ? -1 : 1),
      age: rand(CFG.spawn.preRollMin, CFG.spawn.preRollMax),
    });
    asteroid.asteroid = true;
    asteroid.shape = Planet.makeShape(A.facets, A.facetJitter);
    asteroid.lava = this.rollAsteroidTrap();
    return asteroid;
  }

  /**
   * Ровно одна ловушка на астероид: тлеющая лава либо лоза, 50/50.
   * Красной лавы здесь нет намеренно — мгновенная смерть на необязательной
   * цели превратила бы бонус в наказание.
   * @returns {{start:number,end:number,kind:string}[]}
   */
  rollAsteroidTrap() {
    const A = CFG.asteroid;
    const kind = Math.random() < A.lavaChance ? TRAP.SMOLDER : TRAP.VINE;
    const width = deg(rand(A.arcMinDeg, A.arcMaxDeg));
    const start = Math.random() * TAU;
    return [{ start, end: start + width, kind }];
  }

  /**
   * Успеет ли игрок уйти с астероида до сгорания, если сел в тлеющий сектор.
   * Для астероидов без лавы условие пустое.
   * @param {Planet} asteroid
   * @param {Planet} back планета возврата
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   * @returns {boolean}
   */
  asteroidEscapable(asteroid, back, passed) {
    if (!asteroid.hasTrap(TRAP.SMOLDER)) return true;
    const budget = CFG.lava.smolderDeathTime - CFG.asteroid.escapeMargin;
    const escape = this.escapeTime(asteroid, back, passed);
    return escape !== null && escape <= budget;
  }

  /**
   * Перехватывает ли астероид основной маршрут from -> next.
   *
   * Астероид — необязательная цель, но физически он ловит луч наравне с
   * планетами. Если он встал на пути, прыжок «вперёд» уводил бы в сторону
   * против воли игрока. Считаем углы, на которых до планеты долетаешь РАНЬШЕ,
   * чем до астероида, и требуем прежний запас подряд идущих валидных углов.
   *
   * @param {Planet} asteroid
   * @param {Planet} from
   * @param {Planet} next
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   * @returns {boolean} true — мешает, ставить нельзя
   */
  blocksChain(asteroid, from, next, passed) {
    const stepRad = deg(CFG.solver.angleStepDeg);
    const total = Math.round(TAU / stepRad);
    const vine = this.vineFactorFor(from);
    const maxDist = effectiveMaxJumpDistance(passed) * vine;
    const speed = CFG.player.jumpSpeed * vine;

    const flags = new Array(total).fill(false);
    for (let i = 0; i < total; i++) {
      const local = i * stepRad;
      const startZone = from.lavaAtLocal(local);
      if (startZone && startZone.kind === TRAP.HOT) continue;

      const hit = this.traceJump(from, next, local + from.phase, maxDist);
      if (!hit) continue;

      const flightTime = hit.dist / speed;
      const landingLocal = hit.angle - (next.phase + next.omega * flightTime);
      const landZone = next.lavaAtLocal(landingLocal);
      if (landZone && landZone.kind === TRAP.HOT) continue;

      // Астероид на этом же луче ближе цели — угол «украден».
      const steal = this.traceJump(from, asteroid, local + from.phase, maxDist);
      if (steal && steal.dist < hit.dist) continue;

      flags[i] = true;
    }

    return longestRun(flags) < CFG.solver.minConsecutive;
  }

  /**
   * Зафиксировать планету в мире.
   * @param {Planet} planet
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   */
  commit(planet, passed) {
    planet.paletteIndex = this.paletteCursor++;
    this.spawnedCount++;
    this.logDifficulty(passed, planet.omega);
    this.planets.push(planet);
    this.top = planet;
    this.syncLandables();
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
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   * @returns {Planet|null} преемник, если превращение состоялось
   */
  tryMakeFullLava(planet, from, view, passed) {
    if (passed < CFG.fullLava.fromPassed) return null;
    if (from.fullLava) return null; // никогда две подряд
    if (Math.random() >= fullLavaChance(passed)) return null;

    // Примеряем: вся окружность — тлеющая лава, других ловушек нет.
    const savedLava = planet.lava;
    planet.lava = [{ start: 0, end: TAU, kind: TRAP.SMOLDER }];
    planet.fullLava = true;

    // Смена ловушек не должна сломать уже проверенный вход на планету.
    // Тлеющая лава посадку не запрещает, но проверяем явно, а не на слово.
    if (this.isSolvable(from, planet, passed)) {
      const budget = CFG.lava.smolderDeathTime - CFG.fullLava.escapeMargin;
      for (let i = 0; i < CFG.fullLava.lookaheadAttempts; i++) {
        const next = this.makeCandidate(view, passed, planet);
        if (!this.isSolvable(planet, next, passed)) continue;
        const escape = this.escapeTime(planet, next, passed);
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
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   * @param {Planet} from планета, с которой на неё придётся прыгать
   * @returns {Planet}
   */
  makeCandidate(view, passed, from) {
    const d = this.paramsForProgress(passed);
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
      omega: this.rollOmega(passed),
      age: rand(CFG.spawn.preRollMin, CFG.spawn.preRollMax),
    });
    planet.lava = this.rollTraps(passed, this.spawnedCount);
    return planet;
  }

  /**
   * Заведомо проходимый вариант. Не «ставим вверх и надеемся»: сначала находим
   * свободный от красной лавы угол отрыва на исходной планете, затем ставим
   * новую планету ПРЯМО НА его траектории. Тогда прямая проходит через центр
   * цели (промах невозможен), а на цели нет ловушек — сесть можно под любым углом.
   * @param {{w:number,h:number}} view
   * @param {number} passed пройдено планет (planetsPassed), НЕ очки
   * @param {Planet} from
   * @returns {Planet}
   */
  makeSafeCandidate(view, passed, from) {
    const d = this.paramsForProgress(passed);
    const r = rand(d.rMin, d.rMax);
    const minX = CFG.spawn.edgeMargin + r;
    const maxX = Math.max(minX, view.w - CFG.spawn.edgeMargin - r);
    const cr = r + CFG.player.captureMargin;
    const maxDist = effectiveMaxJumpDistance(passed) * this.vineFactorFor(from);

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
        omega: this.rollOmega(passed),
        age: rand(CFG.spawn.preRollMin, CFG.spawn.preRollMax),
      });
      planet.lava = []; // ловушек нет: садиться на цель безопасно под любым углом
      return planet;
    };

    // Берём первого кандидата, который реально проходит валидацию, а не первого
    // «на вид подходящего» — откат обязан быть проходимым по построению И по факту.
    for (const pos of candidates) {
      const planet = build(pos);
      if (this.isSolvable(from, planet, passed)) return planet;
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
