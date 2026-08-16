import { CFG, TRAP, theme } from './config.js';

const TAU = Math.PI * 2;
/** Привести угол к диапазону [0, 2PI). */
const norm = (a) => ((a % TAU) + TAU) % TAU;

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
  }

  /**
   * Шаг симуляции планеты.
   * @param {number} dt секунды фиксированного шага
   */
  update(dt) {
    this.phase += this.omega * dt;
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
   */
  draw(ctx) {
    const T = theme();
    const [hi, lo] = T.planetPalette[this.paletteIndex % T.planetPalette.length];

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

    // Ободок орбиты — подсказка, где именно пройдёт космонавт.
    ctx.strokeStyle = T.orbitRing;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.orbitRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Метка вращения: по ней глазом читается скорость и направление омеги.
    const mx = this.x + Math.cos(this.phase) * this.r * 0.72;
    const my = this.y + Math.sin(this.phase) * this.r * 0.72;
    ctx.fillStyle = T.surfaceMark;
    ctx.beginPath();
    ctx.arc(mx, my, Math.max(3, this.r * 0.11), 0, Math.PI * 2);
    ctx.fill();

    this.drawLava(ctx);
  }

  /**
   * Дуги лавы по краю планеты: слегка выступают за радиус, чтобы читались
   * силуэтом. Раскалённая пульсирует, тлеющая горит ровно.
   * @param {CanvasRenderingContext2D} ctx
   */
  drawLava(ctx) {
    if (this.lava.length === 0) return;
    const L = CFG.lava;
    const T = theme();

    if (this.fullLava) {
      this.drawFullLava(ctx, T);
      return;
    }

    ctx.save();
    ctx.lineCap = 'butt';
    for (const zone of this.lava) {
      // Локальные углы -> мировые: дуга едет вместе с поверхностью планеты.
      const from = zone.start + this.phase;
      const to = zone.end + this.phase;

      if (zone.kind === TRAP.VINE) {
        this.drawVine(ctx, from, to, T);
        continue;
      }

      ctx.lineWidth = L.thickness;
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
  drawFullLava(ctx, T) {
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
    ctx.lineWidth = F.haloWidth;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r + F.haloOutset, 0, Math.PI * 2);
    ctx.stroke();

    // Основное кольцо по всей окружности — безопасного сектора нет.
    ctx.globalAlpha = pulse;
    ctx.lineWidth = F.ringWidth;
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
  drawVine(ctx, from, to, T) {
    const V = CFG.vine;
    const radius = this.r + V.outset;

    ctx.globalAlpha = 1;
    ctx.strokeStyle = T.vine;
    ctx.shadowColor = T.vine;
    ctx.shadowBlur = 8;
    ctx.lineWidth = V.thickness;
    ctx.beginPath();
    ctx.arc(this.x, this.y, radius, from, to);
    ctx.stroke();

    // Усики: короткие штрихи наружу, слегка «дышат» вместе с возрастом планеты.
    ctx.lineWidth = 2;
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
