import { CFG, TRAP, theme } from './config.js';

const TAU = Math.PI * 2;
/** Привести угол к диапазону [0, 2PI). */
const norm = (a) => ((a % TAU) + TAU) % TAU;

/**
 * Цвет палитры #rrggbb с заданной прозрачностью.
 * Палитры заданы шестнадцатеричными строками, а градиенту атмосферы нужны
 * полупрозрачные стопы того же оттенка.
 * @param {string} hex
 * @param {number} alpha 0..1
 * @returns {string} строка rgba()
 */
function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * Планета — точка притяжения космонавта.
 * Хранит только состояние и умеет себя рисовать; логика захвата живёт в Player.
 */
export class Planet {
  /**
   * @param {{x:number,y:number,r:number,omega:number,paletteIndex?:number}} opts
   */
  constructor(opts) {
    this.x = opts.x;
    this.y = opts.y;
    this.r = opts.r;
    /** Угловая скорость, rad/s. Знак задаёт направление вращения. */
    this.omega = opts.omega;
    /** Фаза поверхности — крутится вместе с планетой, нужна только для отрисовки. */
    this.phase = Math.random() * Math.PI * 2;
    /** Засчитана ли планета в счёт (чтобы не начислять дважды). */
    this.visited = false;
    this.paletteIndex = opts.paletteIndex ?? 0;
    this.alive = true;
    /**
     * Скорость дрейфа, px/s. Сейчас планеты неподвижны, но всё, что предсказывает
     * траекторию, обязано спрашивать позицию через positionAt(): иначе с
     * появлением дрейфа предсказание молча начнёт врать.
     */
    this.vx = opts.vx ?? 0;
    this.vy = opts.vy ?? 0;
    /**
     * Ловушки в ЛОКАЛЬНЫХ углах планеты (отсчёт от phase), поэтому дуга едет
     * вместе с поверхностью. Космонавт крутится с той же omega, значит его
     * локальный угол после посадки не меняется — сектор решает судьбу сразу.
     * @type {{start:number,end:number,kind:string}[]}
     */
    this.lava = [];
    /**
     * Планета целиком из тлеющей лавы. Игровая логика при этом обычная —
     * зона одна, на всю окружность, — флаг нужен для отрисовки и для правила
     * «никогда две подряд».
     */
    this.fullLava = false;
    /**
     * Возраст планеты, с. Гонит пульсацию лавы и служит доказательством, что
     * планета «пожила» до входа в кадр (см. spawn.preRoll* в конфиге).
     */
    this.age = opts.age ?? 0;

    /**
     * Ускорение вращения в ожидании окна для прыжка. Множит МОДУЛЬ omega, знак
     * сохраняется. Валидатор решаемости и бюджет оранжевой лавы намеренно
     * считают от базовой omega — буст в их расчёты не входит.
     */
    this.spinBoost = 1;
    /** Буст уже израсходован на этой посадке и больше не вернётся. */
    this.boostConsumed = false;
    /** Остаток вспышки в момент спада буста, с. */
    this.boostFlashT = 0;
    /** Накопитель времени для угольков лавы, с. */
    this.emberT = 0;
    /**
     * Доп. множитель скорости от очков игрока (CFG.scoreSpeedBonus). В
     * отличие от spinBoost — не одноразовый и не привязан к посадке, просто
     * обновляется каждый кадр снаружи на ВСЕХ активных планетах. Как и
     * spinBoost, в генерацию и валидатор не идёт — считается от базовой omega.
     */
    this.scoreBoost = 1;

    /**
     * Астероид — необязательная боковая цель, а не звено маршрута. Отличается
     * силуэтом (неровный многоугольник вместо гладкого круга) и тем, что
     * nextInChain() ведёт с него не «вперёд», а обратно на цепочку.
     */
    this.asteroid = false;
    /**
     * Планета цепочки, на которую с астероида гарантированно есть путь.
     * Проверена валидатором при спавне.
     * @type {Planet|null}
     */
    this.returnTo = null;
    /** Осколки за посадку уже начислены — повторный визит не платит. */
    this.shardsTaken = false;
    /**
     * Форма силуэта астероида: множители радиуса по вершинам. Считается один
     * раз при создании — пересчёт каждый кадр давал бы дрожащий контур.
     * @type {number[]|null}
     */
    this.shape = null;

    /**
     * Сила атмосферного ободка (0 — выключен). Светящаяся кайма по лимбу:
     * на планете-«горизонте» в меню она и делает картинку, а в игре не нужна —
     * там планеты мелкие и ободок только зашумил бы кадр.
     */
    this.atmosphere = 0;
    /**
     * Показывать ли метку вращения. На огромной планете меню она читается не
     * как индикатор скорости, а как пятно-дефект на поверхности.
     */
    this.showSurfaceMark = true;
  }

  /**
   * Эффективная угловая скорость с учётом бустов. Всё, что реально крутится
   * (фаза планеты и theta космонавта), обязано идти отсюда, иначе космонавт
   * отстанет от поверхности.
   * @returns {number} rad/s
   */
  get effectiveOmega() {
    return this.omega * this.spinBoost * this.scoreBoost;
  }

  /**
   * Обновить бонус скорости от очков. Вызывается снаружи каждый кадр —
   * сама планета ничего не знает про game.score.
   * @param {number} value
   */
  setScoreBoost(value) {
    this.scoreBoost = value;
  }

  /**
   * Переключить множитель вращения. Мгновенно, без интерполяции: смена темпа
   * должна читаться щелчком.
   *
   * Позиция при этом не прыгает: и фаза планеты, и theta космонавта
   * ИНТЕГРИРУЮТСЯ по скорости (`+= omega * dt`), а не пересчитываются из
   * абсолютного времени. Меняется только темп, накопленный угол сохраняется.
   *
   * @param {number} value
   */
  setSpinBoost(value) {
    this.spinBoost = value;
  }

  /** Активен ли буст прямо сейчас — для мгновенного включения подсветки. */
  get boosted() {
    return this.spinBoost > 1;
  }

  /**
   * Шаг симуляции планеты.
   * @param {number} dt секунды фиксированного шага
   */
  update(dt) {
    if (this.boostFlashT > 0) this.boostFlashT = Math.max(0, this.boostFlashT - dt);
    this.phase += this.effectiveOmega * dt;
    this.age += dt;
  }

  /**
   * Найти ловушку под заданным мировым углом на орбите.
   * @param {number} worldTheta мировой угол точки на орбите, rad
   * @returns {{start:number,end:number,kind:string}|null}
   */
  lavaAt(worldTheta) {
    return this.lavaAtLocal(norm(worldTheta - this.phase));
  }

  /**
   * Найти ловушку по ЛОКАЛЬНОМУ углу поверхности. Валидатор решаемости работает
   * именно в локальных углах: космонавт вращается вместе с планетой, поэтому
   * его локальный угол после посадки постоянен.
   * @param {number} local локальный угол, rad
   * @returns {{start:number,end:number,kind:string}|null}
   */
  lavaAtLocal(local) {
    if (this.lava.length === 0) return null;
    const a = norm(local);
    for (const zone of this.lava) {
      // Сдвигаем в систему начала дуги — так корректно ловится переход через 0.
      if (norm(a - zone.start) <= zone.end - zone.start) return zone;
    }
    return null;
  }

  /**
   * Есть ли на планете ловушка данного типа.
   * @param {string} kind значение из TRAP
   * @returns {boolean}
   */
  hasTrap(kind) {
    return this.lava.some((z) => z.kind === kind);
  }

  /**
   * Где планета окажется через t секунд.
   * @param {number} t секунды от текущего момента
   * @returns {{x:number,y:number}}
   */
  positionAt(t) {
    return { x: this.x + this.vx * t, y: this.y + this.vy * t };
  }

  /**
   * Радиус орбиты космонавта над этой планетой.
   * @returns {number}
   */
  get orbitRadius() {
    return this.r + CFG.player.orbitOffset;
  }

  /**
   * Радиус захвата: попадание внутрь него означает приземление.
   * @returns {number}
   */
  get captureRadius() {
    return this.r + CFG.player.captureMargin;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} [scale=1] зум камеры: толщины линий делятся на него,
   *   иначе при отъезде камеры они визуально истончаются
   */
  draw(ctx, scale = 1) {
    const T = theme();
    if (this.asteroid) {
      this.drawAsteroid(ctx, T, scale);
      return;
    }
    const [hi, lo] = T.planetPalette[this.paletteIndex % T.planetPalette.length];

    // Атмосфера идёт ПЕРВОЙ: она обязана уходить наружу за лимб, а тело
    // потом закрывает её внутреннюю половину — так кайма выглядит свечением
    // над поверхностью, а не кольцом поверх планеты.
    if (this.atmosphere > 0) this.drawAtmosphere(ctx, hi);

    // Тело планеты: холодный градиент со смещённым «источником света».
    const g = ctx.createRadialGradient(
      this.x - this.r * 0.35, this.y - this.r * 0.35, this.r * 0.1,
      this.x, this.y, this.r,
    );
    g.addColorStop(0, hi);
    g.addColorStop(1, lo);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
    ctx.fill();

    // Ободок орбиты — подсказка, где именно пройдёт космонавт. Пока активен
    // буст, он подсвечен: ненавязчивый признак «планета разогналась».
    this.drawOrbitRing(ctx, T, scale);

    // Метка вращения: по ней глазом читается скорость и направление омеги.
    if (this.showSurfaceMark) {
      const mx = this.x + Math.cos(this.phase) * this.r * 0.72;
      const my = this.y + Math.sin(this.phase) * this.r * 0.72;
      ctx.fillStyle = T.surfaceMark;
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(3, this.r * 0.11), 0, Math.PI * 2);
      ctx.fill();
    }

    this.drawLava(ctx, scale);
  }

  /**
   * Атмосферный ободок: свечение, обнимающее лимб планеты снаружи.
   *
   * Рисуется одним радиальным градиентом, а не размытием: shadowBlur на
   * больших радиусах — самый дорогой путь в Canvas 2D, а результат тот же.
   * Внутренние стопы прозрачные — то, что попадёт под тело планеты, всё равно
   * будет закрыто, и лишний пиксель заливки там не нужен.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} hi верхний цвет палитры планеты — им и светится атмосфера
   */
  drawAtmosphere(ctx, hi) {
    const A = CFG.planet.atmosphere;
    const outer = this.r * A.spread;
    const g = ctx.createRadialGradient(this.x, this.y, this.r * A.innerStop, this.x, this.y, outer);
    // Яркая кайма сидит ровно на лимбе и гаснет наружу по двум стопам:
    // один резкий скачок дал бы видимую «ступеньку» на градиенте.
    g.addColorStop(0, withAlpha(hi, 0));
    g.addColorStop(this.r / outer, withAlpha(hi, A.limbAlpha * this.atmosphere));
    g.addColorStop((this.r / outer + 1) / 2, withAlpha(hi, A.midAlpha * this.atmosphere));
    g.addColorStop(1, withAlpha(hi, 0));

    ctx.save();
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(this.x, this.y, outer, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Сгенерировать неровный силуэт: множители радиуса по вершинам.
   * Один раз на объект — форма обязана быть стабильной, а не дрожать в кадре.
   * @param {number} facets
   * @param {number} jitter доля радиуса
   * @returns {number[]}
   */
  static makeShape(facets, jitter) {
    const shape = [];
    for (let i = 0; i < facets; i++) shape.push(1 + (Math.random() * 2 - 1) * jitter);
    return shape;
  }

  /**
   * Астероид: угловатый камень вместо гладкого шара. Силуэт — главный
   * опознавательный признак, по нему цель читается издалека как «не планета».
   * Контур поворачивается вместе с phase: астероид вращается вокруг своей оси,
   * и вращение должно быть видно, иначе непонятно, куда едет сектор ловушки.
   * @param {CanvasRenderingContext2D} ctx
   * @param {ReturnType<typeof theme>} T
   * @param {number} scale
   */
  drawAsteroid(ctx, T, scale) {
    const A = CFG.asteroid;
    const [hi, lo] = T.asteroid;
    const shape = this.shape || (this.shape = Planet.makeShape(A.facets, A.facetJitter));
    const n = shape.length;

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = this.phase + (i / n) * Math.PI * 2;
      const r = this.r * shape[i];
      const px = this.x + Math.cos(a) * r;
      const py = this.y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();

    const g = ctx.createRadialGradient(
      this.x - this.r * A.highlightShift, this.y - this.r * A.highlightShift, this.r * 0.1,
      this.x, this.y, this.r,
    );
    g.addColorStop(0, hi);
    g.addColorStop(1, lo);
    ctx.fillStyle = g;
    ctx.fill();
    // Обводка по силуэту: на тёмном фоне грани иначе сливаются в пятно.
    ctx.strokeStyle = T.orbitRing;
    ctx.lineWidth = 1 / scale;
    ctx.stroke();

    // Кратеры: вращаются вместе с телом, поэтому ось вращения видна.
    ctx.fillStyle = lo;
    for (let i = 0; i < A.craterCount; i++) {
      const a = this.phase * -1 + (i / A.craterCount) * Math.PI * 2;
      const d = this.r * (0.28 + 0.18 * i / A.craterCount);
      ctx.beginPath();
      ctx.arc(this.x + Math.cos(a) * d, this.y + Math.sin(a) * d, this.r * A.craterR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    this.drawOrbitRing(ctx, T, scale);
    this.drawLava(ctx, scale);
  }

  /**
   * Ободок орбиты. Пока буст активен — подсвечен (включается и гаснет резко,
   * как и сам множитель). В момент спада — короткая яркая вспышка: переход
   * теперь мгновенный, и он обязан читаться как чёткое «прыгай сейчас».
   * @param {CanvasRenderingContext2D} ctx
   * @param {ReturnType<typeof theme>} T
   * @param {number} scale
   */
  drawOrbitRing(ctx, T, scale) {
    const S = CFG.spin;

    ctx.save();
    // Подсветка включается и гаснет мгновенно, вместе с самим множителем:
    // затухающий визуал спорил бы с резкой сменой темпа вращения.
    if (this.boosted) {
      ctx.strokeStyle = T.accent;
      ctx.globalAlpha = S.ringAlpha;
      ctx.lineWidth = S.ringWidth / scale;
    } else {
      ctx.strokeStyle = T.orbitRing;
      ctx.lineWidth = 1 / scale;
    }
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.orbitRadius, 0, Math.PI * 2);
    ctx.stroke();

    if (this.boostFlashT > 0) {
      const k = this.boostFlashT / S.flashTime; // 1 -> 0
      ctx.strokeStyle = T.accent;
      ctx.shadowColor = T.accent;
      ctx.shadowBlur = S.flashBlur * k;
      // Кольцо расходится и гаснет, толщина падает — короткий чёткий «щелчок».
      ctx.globalAlpha = k * S.flashAlpha;
      ctx.lineWidth = (S.flashWidth * k) / scale;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.orbitRadius + (1 - k) * S.flashRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Дуги лавы по краю планеты: слегка выступают за радиус, чтобы читались
   * силуэтом. Раскалённая пульсирует, тлеющая горит ровно.
   * @param {CanvasRenderingContext2D} ctx
   */
  drawLava(ctx, scale = 1) {
    if (this.lava.length === 0) return;
    const L = CFG.lava;
    const T = theme();

    if (this.fullLava) {
      this.drawFullLava(ctx, T, scale);
      return;
    }

    ctx.save();
    ctx.lineCap = 'butt';
    for (const zone of this.lava) {
      // Локальные углы -> мировые: дуга едет вместе с поверхностью планеты.
      const from = zone.start + this.phase;
      const to = zone.end + this.phase;

      if (zone.kind === TRAP.VINE) {
        this.drawVine(ctx, from, to, T, scale);
        continue;
      }

      ctx.lineWidth = L.thickness / scale;
      if (zone.kind === TRAP.HOT) {
        // Пульсация: яркость и свечение дышат, чтобы «смерть» бросалась в глаза.
        const pulse = 1 - L.hotPulseAmp * (0.5 + 0.5 * Math.sin(this.age * L.hotPulseSpeed));
        ctx.globalAlpha = pulse;
        ctx.shadowColor = T.lavaHot;
        ctx.shadowBlur = L.hotGlowBlur * pulse;
        ctx.strokeStyle = T.lavaHot;
      } else {
        ctx.globalAlpha = 1;
        ctx.shadowColor = T.lavaSmolder;
        ctx.shadowBlur = L.hotGlowBlur * 0.4;
        ctx.strokeStyle = T.lavaSmolder;
      }

      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r + L.outset, from, to);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Планета целиком из лавы: кольцо по всей окружности, внешний ореол и
   * подкрашенное тело. Задача — чтобы её было видно издалека и игрок строил
   * маршрут заранее, а не обнаруживал проблему после посадки.
   * @param {CanvasRenderingContext2D} ctx
   * @param {ReturnType<typeof theme>} T
   */
  drawFullLava(ctx, T, scale = 1) {
    const F = CFG.fullLava;
    const pulse = 1 - F.pulseAmp * (0.5 + 0.5 * Math.sin(this.age * F.pulseSpeed));

    ctx.save();

    // Тело планеты уходит в лавовый цвет — силуэт читается даже без кольца.
    ctx.globalAlpha = F.bodyTintAlpha * pulse;
    ctx.fillStyle = T.lavaSmolder;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
    ctx.fill();

    // Внешний ореол: то, что заметно на периферии зрения.
    ctx.globalAlpha = 0.35 * pulse;
    ctx.strokeStyle = T.lavaSmolder;
    ctx.shadowColor = T.lavaSmolder;
    ctx.shadowBlur = F.glowBlur;
    ctx.lineWidth = F.haloWidth / scale;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r + F.haloOutset, 0, Math.PI * 2);
    ctx.stroke();

    // Основное кольцо по всей окружности — безопасного сектора нет.
    ctx.globalAlpha = pulse;
    ctx.lineWidth = F.ringWidth / scale;
    ctx.shadowBlur = F.glowBlur * pulse;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r + F.outset, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Лоза: дуга с короткими усиками-побегами наружу — читается иначе, чем лава,
   * потому что и последствие другое (не смерть, а штраф к дальности).
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} from мировой угол начала дуги
   * @param {number} to мировой угол конца дуги
   * @param {ReturnType<typeof theme>} T
   */
  drawVine(ctx, from, to, T, scale = 1) {
    const V = CFG.vine;
    const radius = this.r + V.outset;

    ctx.globalAlpha = 1;
    ctx.strokeStyle = T.vine;
    ctx.shadowColor = T.vine;
    ctx.shadowBlur = 8;
    ctx.lineWidth = V.thickness / scale;
    ctx.beginPath();
    ctx.arc(this.x, this.y, radius, from, to);
    ctx.stroke();

    // Усики: короткие штрихи наружу, слегка «дышат» вместе с возрастом планеты.
    ctx.lineWidth = 2 / scale;
    ctx.shadowBlur = 4;
    for (let i = 0; i < V.tendrils; i++) {
      const a = from + ((to - from) * (i + 0.5)) / V.tendrils;
      const wave = 0.85 + 0.15 * Math.sin(this.age * 3 + i);
      const len = V.tendrilLength * wave;
      const inner = radius + V.thickness / 2;
      ctx.beginPath();
      ctx.moveTo(this.x + Math.cos(a) * inner, this.y + Math.sin(a) * inner);
      ctx.lineTo(this.x + Math.cos(a) * (inner + len), this.y + Math.sin(a) * (inner + len));
      ctx.stroke();
    }
  }
}
