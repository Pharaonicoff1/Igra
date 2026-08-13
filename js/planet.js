import { CFG, theme } from './config.js';

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
     * Лавовые зоны в ЛОКАЛЬНЫХ углах планеты (отсчёт от phase), поэтому дуга
     * едет вместе с поверхностью. Космонавт крутится с той же omega, значит
     * его локальный угол после посадки не меняется — сектор решает судьбу сразу.
     * @type {{start:number,end:number,hot:boolean}[]}
     */
    this.lava = [];
    /** Возраст планеты, с — нужен только для пульсации раскалённой лавы. */
    this.age = 0;
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
   * Найти лавовую зону под заданным мировым углом на орбите.
   * @param {number} worldTheta мировой угол точки на орбите, rad
   * @returns {{start:number,end:number,hot:boolean}|null}
   */
  lavaAt(worldTheta) {
    if (this.lava.length === 0) return null;
    const local = norm(worldTheta - this.phase);
    for (const zone of this.lava) {
      // Сдвигаем в систему начала дуги — так корректно ловится переход через 0.
      if (norm(local - zone.start) <= zone.end - zone.start) return zone;
    }
    return null;
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
    const radius = this.r + L.outset;

    ctx.save();
    ctx.lineWidth = L.thickness;
    ctx.lineCap = 'butt';
    for (const zone of this.lava) {
      // Локальные углы -> мировые: дуга едет вместе с поверхностью планеты.
      const from = zone.start + this.phase;
      const to = zone.end + this.phase;

      if (zone.hot) {
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
      ctx.arc(this.x, this.y, radius, from, to);
      ctx.stroke();
    }
    ctx.restore();
  }
}
