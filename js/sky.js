import {
  CFG, theme, getThemeId, sectorOf, sectorSlot, setSectorIndex,
} from './config.js';
import { mulberry32, mixSeed, parseHex, rgba, mixRgb } from './util.js';

const TAU = Math.PI * 2;

/**
 * Небо: фон, оттенок звёзд и декоративный слой текущего сектора и кроссфейд
 * между секторами. Надпись о входе в сектор — забота HUD (общий слот
 * уведомлений), небо о ней не знает.
 *
 * Чисто визуальная система: о спавне, сложности и очках она не знает, а игра
 * сообщает ей только «игрок вошёл в сектор N».
 *
 * Как устроен кроссфейд, чтобы в кадре не создавалось ни одной строки цвета:
 *  - фон — два ЗАРАНЕЕ собранных градиента, новый кладётся поверх старого с
 *    нарастающей прозрачностью; это точная смесь, и считать её не нужно вовсе;
 *  - декоративный слой — две готовые картинки, так же через прозрачность;
 *    чёткие детали слоя (см. ниже) — заранее собранные фигуры и спрайты;
 *  - оттенок звёзд смешивается числами (hex разобран заранее) в таблицу
 *    промежуточных цветов ОДИН раз при входе в сектор, кадр берёт готовую
 *    строку по индексу.
 *
 * ДЕКОРАТИВНЫЙ СЛОЙ СОСТОИТ ИЗ ДВУХ ЧАСТЕЙ, и это не усложнение ради
 * усложнения, а итог замера (CFG.sector.layerScale):
 *  - МЯГКАЯ часть — туманности, дымка, свечение узлов. Живёт в уменьшенном
 *    холсте и растягивается на экран: на размытом пятне укрупнённый пиксель
 *    не виден, а стоит это почти ничего;
 *  - ЧЁТКАЯ часть — крупинки пыли, линии сетки, штрихи, кольца, галактики.
 *    В уменьшенном холсте они превращались в квадраты 2x2 на ретина-экране.
 *    Теперь они рисуются в полном разрешении экрана: либо готовой фигурой
 *    (Path2D), либо спрайтом, отрисованным заранее с учётом devicePixelRatio.
 *    Таких деталей мало и они мелкие, поэтому цена — доли миллисекунды, а не
 *    проход по всем пикселям экрана, каким был бы слой в полном разрешении.
 */
export class Sky {
  constructor() {
    /** @type {{ctx:CanvasRenderingContext2D, view:{w:number,h:number}, safe:{top:number}}|null} */
    this.deps = null;
    /** Номер сектора игрока, с нуля. Растёт без потолка. */
    this.index = 0;
    /** Сектор, из которого идёт кроссфейд. */
    this.fromIndex = 0;
    /** Остаток кроссфейда, с. */
    this.fadeT = 0;
    /** Тема, под которую собраны слои: смена темы пересобирает их на месте. */
    this.themeId = '';
    /** Мягкая часть слоя, по холсту на сектор. @type {HTMLCanvasElement[]} */
    this.layers = [];
    /**
     * Чёткая часть слоя, по списку операций на сектор. Собирается в rebuild(),
     * в кадре только исполняется.
     * @type {{t:number, path?:Path2D, style?:string|CanvasGradient, width?:number,
     *   img?:HTMLCanvasElement, x?:number, y?:number, w?:number, h?:number}[][]}
     */
    this.crisp = [];
    /** Градиенты фона, по одному на сектор. @type {CanvasGradient[]} */
    this.grads = [];
    /**
     * Сборный холст: градиент и слой текущего кадра в уменьшенном разрешении.
     * На экран уходит одной операцией — см. draw().
     * @type {HTMLCanvasElement|null}
     */
    this.comp = null;
    /** @type {CanvasRenderingContext2D|null} */
    this.compCtx = null;
    /** Градиенты фона в масштабе сборного холста. @type {CanvasGradient[]} */
    this.compGrads = [];
    /** Что сейчас лежит в сборном холсте: совпало — пересобирать нечего. */
    this.compKey = { to: -1, from: -1, k: -1, offX: 0, offY: 0 };
    /** Размер тайла слоя на экране, px: больше экрана, замкнут в тор. */
    this.tileW = 0;
    this.tileH = 0;
    /** Таблица оттенков звёзд на время кроссфейда. @type {string[]} */
    this.starTable = new Array(CFG.sector.starBlendSteps + 1).fill('');
    /** Отладочный выключатель слоя — для замера его цены в кадре. */
    this.decorEnabled = true;
    /** Сколько заняла последняя пересборка слоёв, мс — для замеров. */
    this.buildMs = 0;
  }

  /** @param {NonNullable<Sky['deps']>} deps */
  attach(deps) {
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // Состояние
  // -------------------------------------------------------------------------

  /** Вернуться в первый сектор мгновенно: новый забег, выход в меню. */
  reset() {
    this.jump(0);
  }

  /**
   * Встать в сектор без перехода и без надписи.
   * @param {number} index номер сектора с нуля
   */
  jump(index) {
    this.index = Math.max(0, Math.floor(index));
    this.fromIndex = this.index;
    this.fadeT = 0;
    setSectorIndex(this.index);
  }

  /**
   * Игрок вошёл в сектор: запускаем кроссфейд и надпись.
   * @param {number} index номер сектора с нуля
   */
  enter(index) {
    const S = CFG.sector;
    const T = theme();
    this.fromIndex = this.index;
    this.index = Math.max(0, Math.floor(index));
    setSectorIndex(this.index);
    this.fadeT = S.fadeTime;

    // Таблица оттенков звёзд: смесь числами, строки — один раз на переход.
    const from = parseHex(sectorOf(T, this.fromIndex).star);
    const to = parseHex(sectorOf(T, this.index).star);
    const steps = this.starTable.length - 1;
    for (let i = 0; i <= steps; i++) this.starTable[i] = rgba(mixRgb(from, to, i / steps), 1);
  }

  /**
   * Шаг по реальному времени: кроссфейд и надпись — это UI, пауза их не
   * останавливает. Здесь же ловится смена темы: слои пересобираются сразу,
   * сектор остаётся прежним — как и theme(), новая тема видна в том же кадре.
   * @param {number} dtReal
   */
  update(dtReal) {
    if (getThemeId() !== this.themeId) {
      this.rebuild();
      // Доигрывать переход между палитрами уже другой темы незачем.
      this.fromIndex = this.index;
      this.fadeT = 0;
    }
    if (this.fadeT > 0) this.fadeT = Math.max(0, this.fadeT - dtReal);
  }

  /**
   * Доля нового сектора в кадре, 0..1. Сглажена: линейный переход заметно
   * «стартует» и «останавливается», а фон должен перетекать.
   * @returns {number}
   */
  mix() {
    if (this.fadeT <= 0) return 1;
    const t = 1 - this.fadeT / CFG.sector.fadeTime;
    return t * t * (3 - 2 * t);
  }

  /** @returns {string} оттенок звёзд для текущего кадра — готовая строка */
  starColor() {
    if (this.fadeT <= 0) return sectorOf(theme(), this.index).star;
    const steps = this.starTable.length - 1;
    return this.starTable[Math.round(this.mix() * steps)];
  }

  // -------------------------------------------------------------------------
  // Сборка слоёв
  // -------------------------------------------------------------------------

  /**
   * Пересобрать градиенты и декоративные слои ВСЕХ секторов активной темы.
   *
   * Вызывается на resize и при смене темы — не в кадре и не в момент посадки:
   * слои готовы заранее, поэтому вход в сектор не стоит ни одного кадра.
   * Картинки маленькие (половина разрешения, без dpr), четыре штуки на тему.
   */
  rebuild() {
    const { ctx, view } = this.deps;
    const S = CFG.sector;
    const T = theme();
    const t0 = performance.now();
    this.themeId = getThemeId();

    const scale = S.layerScale;
    const w = Math.max(1, Math.round(view.w * CFG.stars.tileExtra * scale));
    const h = Math.max(1, Math.round(view.h * CFG.stars.tileExtra * scale));
    // Размер тайла на экране берём ОТ округлённого размера слоя, а не
    // наоборот: тогда слой ложится в сборный холст пиксель в пиксель.
    this.tileW = w / scale;
    this.tileH = h / scale;

    // Сборный холст: экран в том же половинном разрешении, непрозрачный.
    const comp = this.comp || (this.comp = document.createElement('canvas'));
    comp.width = Math.max(1, Math.ceil(view.w * scale));
    comp.height = Math.max(1, Math.ceil(view.h * scale));
    this.compCtx = comp.getContext('2d', { alpha: false });
    this.compKey.to = -1; // содержимое сброшено — собрать заново в ближайшем кадре

    this.grads.length = 0;
    this.compGrads.length = 0;
    for (let slot = 0; slot < T.sectors.length; slot++) {
      const sec = T.sectors[slot];
      const g = ctx.createLinearGradient(0, 0, 0, view.h);
      g.addColorStop(0, sec.bg);
      g.addColorStop(1, sec.bgGlow);
      this.grads.push(g);
      // Тот же градиент в масштабе сборного холста.
      const cg = this.compCtx.createLinearGradient(0, 0, 0, view.h * scale);
      cg.addColorStop(0, sec.bg);
      cg.addColorStop(1, sec.bgGlow);
      this.compGrads.push(cg);

      const canvas = this.layers[slot] || (this.layers[slot] = document.createElement('canvas'));
      canvas.width = w;   // присваивание размера заодно очищает холст
      canvas.height = h;
      // Рисунок детерминирован по теме и сектору: «Туманность» выглядит
      // одинаково при каждом визите, а не перетасовывается на каждом resize.
      const rng = mulberry32(mixSeed(hashString(this.themeId), slot, 1013));
      const soft = canvas.getContext('2d');
      // Рисуем в CSS-пикселях тайла: масштаб холста прячется в трансформации,
      // и мягкая, и чёткая часть слоя считаются в одних координатах.
      soft.setTransform(scale, 0, 0, scale, 0, 0);
      const ops = this.crisp[slot] || (this.crisp[slot] = []);
      ops.length = 0;
      paintDecor(soft, this.tileW, this.tileH, rng, sec.decor, ops, view.dpr);
    }
    this.layers.length = T.sectors.length;
    this.crisp.length = T.sectors.length;
    this.buildMs = performance.now() - t0;
  }

  // -------------------------------------------------------------------------
  // Отрисовка
  // -------------------------------------------------------------------------

  /**
   * Фон и декоративный слой. Экранные координаты, без зума камеры — как
   * звёзды: иначе при отъезде камеры менялся бы масштаб неба.
   *
   * ПОЧЕМУ ЧЕРЕЗ СБОРНЫЙ ХОЛСТ. Прямой путь — залить экран градиентом и
   * положить сверху полупрозрачный слой — стоит ДВА прохода по всем пикселям
   * экрана в полном разрешении, второй ещё и со смешиванием. Замер без GPU
   * под троттлингом x4 — в CFG.sector.layerSmoothing: слой удваивал цену
   * кадра. Здесь градиент и слой собираются в маленьком холсте (половина
   * CSS-разрешения: в 16 раз меньше пикселей при dpr 2), а на экран идёт
   * ОДНА непрозрачная операция — растянуть готовую картинку. Она заменяет
   * заливку градиентом, а не добавляется к ней. Пока камера стоит и перехода
   * нет, сборка не повторяется вовсе; кроссфейд двух секторов тоже идёт в
   * маленьком холсте и на цене кадра почти не сказывается.
   *
   * @param {number} camX @param {number} camY позиция камеры (с тряской)
   */
  draw(camX, camY) {
    const { ctx, view } = this.deps;
    const T = theme();
    const count = T.sectors.length;
    const to = sectorSlot(this.index, count);
    const from = sectorSlot(this.fromIndex, count);
    const k = from === to ? 1 : this.mix();

    if (!this.decorEnabled) {
      // Отладочный путь без слоя — прежняя заливка градиентом, для замеров.
      if (k < 1) {
        ctx.fillStyle = this.grads[from];
        ctx.fillRect(0, 0, view.w, view.h);
        ctx.globalAlpha = k;
      }
      ctx.fillStyle = this.grads[to];
      ctx.fillRect(0, 0, view.w, view.h);
      ctx.globalAlpha = 1;
      return;
    }

    const scale = CFG.sector.layerScale;
    const f = CFG.sector.layerParallax * scale;
    const comp = this.comp;
    const tw = this.layers[to].width;
    const th = this.layers[to].height;
    // Смещение слоя в пикселях сборного холста.
    const offX = ((camX * f) % tw + tw) % tw;
    const offY = ((camY * f) % th + th) % th;

    // Пересобираем, только если картинка действительно изменилась.
    const key = this.compKey;
    if (key.to !== to || key.from !== from || key.k !== k || key.offX !== offX || key.offY !== offY) {
      key.to = to; key.from = from; key.k = k; key.offX = offX; key.offY = offY;
      const g = this.compCtx;
      if (k < 1) {
        g.fillStyle = this.compGrads[from];
        g.fillRect(0, 0, comp.width, comp.height);
        g.globalAlpha = 1 - k;
        this.drawLayer(g, this.layers[from], offX, offY);
        // Новый сектор ложится поверх старого целиком — и градиент, и слой:
        // это точная смесь двух картинок, и считать цвета не нужно вовсе.
        g.globalAlpha = k;
      }
      g.fillStyle = this.compGrads[to];
      g.fillRect(0, 0, comp.width, comp.height);
      this.drawLayer(g, this.layers[to], offX, offY);
      g.globalAlpha = 1;
    }

    // Растягиваем БЕЗ сглаживания — см. CFG.sector.layerSmoothing: именно
    // билинейная выборка на каждый пиксель экрана и была дорогой частью.
    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = CFG.sector.layerSmoothing;
    ctx.drawImage(comp, 0, 0, comp.width / scale, comp.height / scale);
    ctx.imageSmoothingEnabled = smooth;

    // Чёткие детали — поверх, в полном разрешении экрана. На переходе старый
    // сектор гаснет, новый проявляется: та же смесь, что у мягкой части.
    const cssX = offX / scale;
    const cssY = offY / scale;
    if (k < 1) {
      ctx.globalAlpha = 1 - k;
      this.drawCrisp(this.crisp[from], cssX, cssY);
      ctx.globalAlpha = k;
    }
    this.drawCrisp(this.crisp[to], cssX, cssY);
    ctx.globalAlpha = 1;
  }

  /**
   * Исполнить список чётких деталей для каждой видимой копии тайла.
   *
   * Каждая копия обрезается по своему прямоугольнику: фигуры, пересекающие
   * кромку тайла, заранее продублированы с другой стороны (тор), и без
   * обрезки их выступающая часть нарисовалась бы дважды.
   *
   * @param {Sky['crisp'][number]} ops
   * @param {number} offX @param {number} offY смещение параллакса, CSS-px
   */
  drawCrisp(ops, offX, offY) {
    if (!ops || ops.length === 0) return;
    const { ctx, view } = this.deps;
    const tw = this.tileW;
    const th = this.tileH;
    for (let ix = 0; ix < 2; ix++) {
      const x = ix * tw - offX;
      if (x >= view.w || x + tw <= 0) continue;
      for (let iy = 0; iy < 2; iy++) {
        const y = iy * th - offY;
        if (y >= view.h || y + th <= 0) continue;
        ctx.save();
        ctx.translate(x, y);
        ctx.beginPath();
        ctx.rect(0, 0, tw, th);
        ctx.clip();
        for (let i = 0; i < ops.length; i++) {
          const op = ops[i];
          if (op.t === OP_FILL) {
            ctx.fillStyle = op.style;
            ctx.fill(op.path);
          } else if (op.t === OP_STROKE) {
            if (y + op.y > view.h || y + op.y + op.h < 0
                || x + op.x > view.w || x + op.x + op.w < 0) continue;
            ctx.strokeStyle = op.style;
            ctx.lineWidth = op.width;
            ctx.stroke(op.path);
          } else if (op.t === OP_RECT) {
            // Мимо экрана — не рисуем: штрихов десятки, а видна часть.
            if (y + op.y > view.h || y + op.y + op.h < 0) continue;
            ctx.fillStyle = op.style;
            ctx.fillRect(op.x, op.y, op.w, op.h);
          } else {
            if (y + op.y > view.h || y + op.y + op.h < 0
                || x + op.x > view.w || x + op.x + op.w < 0) continue;
            ctx.drawImage(op.img, op.x, op.y, op.w, op.h);
          }
        }
        ctx.restore();
      }
    }
  }

  /**
   * Один слой в сборный холст. Тайл больше экрана и замкнут в тор, поэтому
   * хватает четырёх копий 2x2 — тот же приём, что у звёзд. Размер не
   * меняется (слой и холст в одном масштабе), сдвиг дробный — параллакс
   * остаётся плавным, а не шагает по целым пикселям.
   */
  drawLayer(g, canvas, offX, offY) {
    const tw = canvas.width;
    const th = canvas.height;
    const cw = this.comp.width;
    const ch = this.comp.height;
    for (let ix = 0; ix < 2; ix++) {
      const x = ix * tw - offX;
      if (x >= cw || x + tw <= 0) continue;
      for (let iy = 0; iy < 2; iy++) {
        const y = iy * th - offY;
        if (y >= ch || y + th <= 0) continue;
        g.drawImage(canvas, x, y);
      }
    }
  }
}

/** Устойчивый хеш строки для seed. */
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  return h;
}

/** Виды операций чёткой части слоя. */
const OP_FILL = 0;   // залить готовую фигуру
const OP_STROKE = 1; // обвести готовую фигуру
const OP_RECT = 2;   // прямоугольник со своей заливкой (градиент штриха)
const OP_SPRITE = 3; // готовая картинка в разрешении экрана

// ---------------------------------------------------------------------------
// Рисование декоративных слоёв. Выполняется при сборке, не в кадре, поэтому
// здесь можно и градиенты создавать, и строки цвета собирать. shadowBlur не
// используется нигде: мягкость даёт радиальный градиент.
//
// Все координаты — в CSS-пикселях тайла. Мягкое рисуется в уменьшенный холст
// g (масштаб уже в его трансформации), чёткое складывается в ops.
// ---------------------------------------------------------------------------

/**
 * @param {CanvasRenderingContext2D} g контекст мягкой части слоя
 * @param {number} W @param {number} H размер тайла, CSS-px
 * @param {() => number} rng
 * @param {{kind:string, colors:string[], strength?:number}} decor
 * @param {object[]} ops куда складывать чёткие детали
 * @param {number} dpr плотность пикселей экрана — для спрайтов
 */
function paintDecor(g, W, H, rng, decor, ops, dpr) {
  if (!decor) return;
  const P = CFG.sector.decor[decor.kind];
  if (!P) return;
  const colors = decor.colors.map(parseHex);
  const strength = decor.strength ?? 1;
  switch (decor.kind) {
    case 'nebula':
    case 'bands': paintBlobs(g, W, H, rng, P, colors, strength); break;
    case 'dust': paintDust(g, W, H, rng, P, colors, strength, ops); break;
    case 'galaxies': paintGalaxies(W, H, rng, P, colors, strength, ops, dpr); break;
    case 'grid': paintGrid(g, W, H, rng, P, colors, strength, ops); break;
    case 'streaks': paintStreaks(W, H, rng, P, colors, strength, ops, dpr); break;
    case 'rings': paintRings(W, H, rng, P, colors, strength, ops); break;
    default: break;
  }
}

/**
 * Вызвать fn для фигуры и всех её копий через края тайла: тайл замкнут в
 * тор, и всё, что пересекает кромку, обязано продолжиться с другой стороны —
 * иначе на стыке тайлов будет виден шов.
 * @param {number} reach радиус, за который фигура не выходит
 * @param {(cx:number, cy:number) => void} fn
 */
function wrapDraw(W, H, x, y, reach, fn) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const cx = x + dx * W;
      const cy = y + dy * H;
      if (cx + reach < 0 || cx - reach > W || cy + reach < 0 || cy - reach > H) continue;
      fn(cx, cy);
    }
  }
}

const between = (rng, a, b) => a + rng() * (b - a);

/** Мягкое пятно: радиальный градиент от цвета к прозрачности. */
function softBlob(g, r, rgb, alpha) {
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
  grad.addColorStop(0, rgba(rgb, alpha));
  grad.addColorStop(0.5, rgba(rgb, alpha * 0.45));
  grad.addColorStop(1, rgba(rgb, 0));
  g.fillStyle = grad;
  g.fillRect(-r, -r, r * 2, r * 2);
}

/** Туманность и дымка: крупные размытые пятна. Целиком мягкая часть. */
function paintBlobs(g, W, H, rng, P, colors, strength) {
  for (let i = 0; i < P.count; i++) {
    const rgb = colors[i % colors.length];
    const r = between(rng, P.rMin, P.rMax) * W;
    const sx = between(rng, P.stretchMin, P.stretchMax);
    const rot = (rng() * 2 - 1) * P.tilt;
    const x = rng() * W;
    const y = rng() * H;
    const alpha = P.alpha * strength * between(rng, 0.6, 1);
    wrapDraw(W, H, x, y, r * Math.max(sx, P.squash), (cx, cy) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(rot);
      g.scale(sx, P.squash);
      softBlob(g, r, rgb, alpha);
      g.restore();
    });
  }
}

/**
 * Пылевой пояс: волнистая полоса крупинок поперёк слоя и дымка под ней.
 * Дымка мягкая; крупинки — чёткие, по готовой фигуре на каждую пару
 * «цвет x яркость» (их девять), чтобы в кадре было девять заливок, а не
 * пять сотен прямоугольников.
 */
function paintDust(g, W, H, rng, P, colors, strength, ops) {
  const phase = rng() * TAU;
  const bandY = (x) => H * (0.5 + P.wave * Math.sin((x / W) * TAU + phase));

  for (let i = 0; i < P.hazeCount; i++) {
    const x = ((i + rng()) / P.hazeCount) * W;
    const r = P.hazeR * W;
    const rgb = colors[colors.length - 1];
    wrapDraw(W, H, x, bandY(x), r * 1.6, (cx, cy) => {
      g.save();
      g.translate(cx, cy);
      g.scale(1.6, P.hazeSquash);
      softBlob(g, r, rgb, P.hazeAlpha * strength);
      g.restore();
    });
  }

  const levels = P.alphaLevels;
  const paths = [];
  for (let i = 0; i < colors.length * levels; i++) paths.push(new Path2D());
  const total = P.specks + P.scatter;
  for (let i = 0; i < total; i++) {
    const x = rng() * W;
    // Сумма трёх равномерных — дешёвое приближение колокола: гуще к середине
    // пояса, редеет к краям. Последние scatter крупинок раскиданы по всему
    // тайлу, чтобы пояс не выглядел вырезанным по линейке.
    const spread = (rng() + rng() + rng() - 1.5) * 1.3;
    let y = i < P.specks ? bandY(x) + spread * P.band * H : rng() * H;
    y = ((y % H) + H) % H;
    const level = Math.min(levels - 1, Math.floor(rng() * levels));
    const sz = between(rng, P.sizeMin, P.sizeMax);
    // Кружок, а не квадрат: на ретина-экране углы крупинки уже различимы.
    const path = paths[(i % colors.length) * levels + level];
    path.moveTo(x + sz / 2, y);
    path.arc(x, y, sz / 2, 0, TAU);
  }
  for (let c = 0; c < colors.length; c++) {
    for (let l = 0; l < levels; l++) {
      const alpha = P.alphaMin + (P.alphaMax - P.alphaMin) * (levels > 1 ? l / (levels - 1) : 1);
      ops.push({ t: OP_FILL, path: paths[c * levels + l], style: rgba(colors[c], alpha * strength) });
    }
  }
}

/**
 * Далёкие галактики: наклонённый эллипс-ореол, яркое ядро, два рукава.
 * Каждая — спрайт, отрисованный с учётом плотности пикселей экрана: галактика
 * маленькая, и картинка в полном разрешении стоит копейки.
 */
function paintGalaxies(W, H, rng, P, colors, strength, ops, dpr) {
  for (let i = 0; i < P.count; i++) {
    // По одной на горизонтальную полосу тайла: случайные координаты склеивали
    // бы их в кучу, а «редкие далёкие» обязаны быть именно редкими.
    const x = rng() * W;
    const y = ((i + between(rng, 0.2, 0.8)) / P.count) * H;
    const r = between(rng, P.rMin, P.rMax) * W;
    const rot = rng() * Math.PI;
    const rgb = colors[i % colors.length];
    const core = mixRgb(rgb, 0xffffff, 0.5);

    const side = Math.ceil(r * 2) + 2;
    const img = document.createElement('canvas');
    img.width = Math.ceil(side * dpr);
    img.height = Math.ceil(side * dpr);
    const g = img.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.translate(side / 2, side / 2);
    g.rotate(rot);
    g.scale(1, P.squash);
    softBlob(g, r, rgb, P.haloAlpha * strength);
    softBlob(g, r * 0.3, core, P.coreAlpha * strength);
    g.fillStyle = rgba(core, 1);
    for (let j = 0; j < P.armSpecks; j++) {
      const t = j / P.armSpecks;
      const a = t * 3.4 + (j % 2) * Math.PI;
      const d = r * (0.18 + 0.72 * t);
      g.globalAlpha = P.speckAlpha * strength * (1 - t * 0.7);
      g.fillRect(Math.cos(a) * d - P.speckSize / 2, Math.sin(a) * d - P.speckSize / 2,
        P.speckSize, P.speckSize);
    }

    wrapDraw(W, H, x, y, side / 2, (cx, cy) => {
      ops.push({ t: OP_SPRITE, img, x: cx - side / 2, y: cy - side / 2, w: side, h: side });
    });
  }
}

/**
 * Неоновая сетка: линии с шагом, кратным размеру тайла, и редкие узлы.
 * Линии чёткие (одна фигура на все), свечение узлов мягкое.
 */
function paintGrid(g, W, H, rng, P, colors, strength, ops) {
  const cw = W / P.cols;
  const rows = Math.max(1, Math.round(H / cw));
  const ch = H / rows;
  const path = new Path2D();
  // Крайние линии кладутся с обеих сторон: линия на кромке наполовину
  // обрезана, вторая её половина приходит с противоположного края.
  for (let i = 0; i <= P.cols; i++) path.rect(i * cw - P.width / 2, 0, P.width, H);
  for (let j = 0; j <= rows; j++) path.rect(0, j * ch - P.width / 2, W, P.width);
  ops.push({ t: OP_FILL, path, style: rgba(colors[0], P.alpha * strength) });

  for (let i = 0; i < P.cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (rng() >= P.nodeChance) continue;
      const rgb = colors[(i + j) % colors.length];
      const r = P.nodeR * 4;
      wrapDraw(W, H, i * cw, j * ch, r, (cx, cy) => {
        g.save();
        g.translate(cx, cy);
        softBlob(g, r, rgb, P.nodeAlpha * strength);
        g.restore();
      });
    }
  }
}

/**
 * Поток данных: вертикальные штрихи, яркие к нижнему концу. Каждый — узкий
 * спрайт в разрешении экрана. Заливка градиентом в кадре стоила заметно
 * дороже (замер: +8 мс на кадр под троттлингом x4), а готовая полоска в
 * несколько пикселей шириной — практически ничего.
 */
function paintStreaks(W, H, rng, P, colors, strength, ops, dpr) {
  for (let i = 0; i < P.count; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const len = between(rng, P.lenMin, P.lenMax) * H;
    const rgb = colors[i % colors.length];
    const alpha = P.alpha * strength * between(rng, 0.5, 1);

    const img = document.createElement('canvas');
    img.width = Math.max(1, Math.ceil(P.width * dpr));
    img.height = Math.max(1, Math.ceil(len * dpr));
    const g = img.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, img.height);
    grad.addColorStop(0, rgba(rgb, 0));
    grad.addColorStop(0.85, rgba(rgb, alpha));
    grad.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, img.width, img.height);

    wrapDraw(W, H, x, y, len / 2, (cx, cy) => {
      ops.push({ t: OP_SPRITE, img, x: cx - P.width / 2, y: cy - len / 2, w: P.width, h: len });
    });
  }
}

/**
 * Импульс: концентрические кольца, гаснущие от центра наружу. Все чёткие.
 *
 * Обводка большой окружности со сглаживанием — самое дорогое, что есть в
 * чётких деталях, поэтому каждая копия кольца — отдельная операция со своей
 * рамкой: кольцо, целиком ушедшее за экран, не рисуется вовсе.
 */
function paintRings(W, H, rng, P, colors, strength, ops) {
  for (let c = 0; c < P.centers; c++) {
    const x = rng() * W;
    const y = ((c + between(rng, 0.2, 0.8)) / P.centers) * H;
    const rgb = colors[c % colors.length];
    for (let k = 0; k < P.rings; k++) {
      const r = (P.rMin + k * P.rStep) * W;
      const style = rgba(rgb, P.alpha * strength * (1 - k / P.rings));
      wrapDraw(W, H, x, y, r, (cx, cy) => {
        const path = new Path2D();
        path.arc(cx, cy, r, 0, TAU);
        ops.push({ t: OP_STROKE, path, width: P.width, style,
          x: cx - r, y: cy - r, w: r * 2, h: r * 2 });
      });
    }
  }
}
