import {
  CFG, theme, getThemeId, sectorOf, sectorSlot, setSectorIndex,
} from './config.js';
import { mulberry32, mixSeed, parseHex, rgba, mixRgb } from './util.js';

const TAU = Math.PI * 2;

/**
 * Небо: фон, оттенок звёзд и декоративный слой текущего сектора, кроссфейд
 * между секторами и надпись при входе.
 *
 * Чисто визуальная система: о спавне, сложности и очках она не знает, а игра
 * сообщает ей только «игрок вошёл в сектор N».
 *
 * Как устроен кроссфейд, чтобы в кадре не создавалось ни одной строки цвета:
 *  - фон — два ЗАРАНЕЕ собранных градиента, новый кладётся поверх старого с
 *    нарастающей прозрачностью; это точная смесь, и считать её не нужно вовсе;
 *  - декоративный слой — две готовые картинки, так же через прозрачность;
 *  - оттенок звёзд смешивается числами (hex разобран заранее) в таблицу
 *    промежуточных цветов ОДИН раз при входе в сектор, кадр берёт готовую
 *    строку по индексу.
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
    /** Декоративные слои темы, по одному на сектор. @type {HTMLCanvasElement[]} */
    this.layers = [];
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
    /** Надпись при входе в сектор: остаток жизни и готовые строки. */
    this.banner = { t: 0, title: '', name: '', index: 0 };
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
    this.banner.t = 0;
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

    this.banner.t = S.bannerTime;
    this.banner.index = this.index;
    this.banner.title = S.text.banner.replace('{n}', String(this.index + 1));
    this.banner.name = sectorOf(T, this.index).name.toUpperCase();
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
      // Сменили тему посреди надписи — имя сектора меняется вместе с небом.
      // Строка пересобирается здесь, а не в отрисовке: в кадре строк не создаём.
      this.banner.name = sectorOf(theme(), this.banner.index).name.toUpperCase();
    }
    if (this.fadeT > 0) this.fadeT = Math.max(0, this.fadeT - dtReal);
    if (this.banner.t > 0) this.banner.t = Math.max(0, this.banner.t - dtReal);
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
      paintDecor(canvas.getContext('2d'), w, h, rng, sec.decor);
    }
    this.layers.length = T.sectors.length;
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

  /**
   * Надпись при входе в сектор: «СЕКТОР N» и название помельче.
   * Игру не останавливает и ничего из HUD не перекрывает — см. bannerY.
   * @param {ReturnType<typeof theme>} T
   * @param {number} fade прозрачность экрана
   */
  drawBanner(T, fade) {
    const S = CFG.sector;
    const b = this.banner;
    if (b.t <= 0) return;
    const { ctx, view, safe } = this.deps;
    const age = S.bannerTime - b.t;
    const k = Math.min(1, age / S.bannerIn, b.t / S.bannerOut);
    const rise = (1 - Math.min(1, age / S.bannerIn)) * S.bannerRise;
    const y = safe.top + S.bannerY + rise;

    ctx.save();
    ctx.globalAlpha = k * fade;
    ctx.textAlign = 'center';
    ctx.fillStyle = T.accent;
    ctx.font = `700 ${S.bannerFont}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(b.title, view.w / 2, y);
    ctx.globalAlpha *= 0.8;
    ctx.font = `600 ${S.bannerNameFont}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(b.name, view.w / 2, y + S.bannerNameGap);
    ctx.restore();
  }
}

/** Устойчивый хеш строки для seed. */
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  return h;
}

// ---------------------------------------------------------------------------
// Рисование декоративных слоёв. Выполняется при сборке, не в кадре, поэтому
// здесь можно и градиенты создавать, и строки цвета собирать. shadowBlur не
// используется нигде: мягкость даёт радиальный градиент.
// ---------------------------------------------------------------------------

/**
 * @param {CanvasRenderingContext2D} g контекст слоя
 * @param {number} W @param {number} H размер слоя, px
 * @param {() => number} rng
 * @param {{kind:string, colors:string[], strength?:number}} decor
 */
function paintDecor(g, W, H, rng, decor) {
  if (!decor) return;
  const P = CFG.sector.decor[decor.kind];
  if (!P) return;
  const colors = decor.colors.map(parseHex);
  const strength = decor.strength ?? 1;
  switch (decor.kind) {
    case 'nebula':
    case 'bands': paintBlobs(g, W, H, rng, P, colors, strength); break;
    case 'dust': paintDust(g, W, H, rng, P, colors, strength); break;
    case 'galaxies': paintGalaxies(g, W, H, rng, P, colors, strength); break;
    case 'grid': paintGrid(g, W, H, rng, P, colors, strength); break;
    case 'streaks': paintStreaks(g, W, H, rng, P, colors, strength); break;
    case 'rings': paintRings(g, W, H, rng, P, colors, strength); break;
    default: break;
  }
}

/**
 * Нарисовать фигуру со всеми её копиями через края слоя: тайл замкнут в тор,
 * и всё, что пересекает кромку, обязано продолжиться с другой стороны —
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

/** Туманность и дымка: крупные размытые пятна. */
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

/** Пылевой пояс: волнистая полоса крупинок поперёк слоя и дымка под ней. */
function paintDust(g, W, H, rng, P, colors, strength) {
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

  const total = P.specks + P.scatter;
  for (let i = 0; i < total; i++) {
    const x = rng() * W;
    // Сумма трёх равномерных — дешёвое приближение колокола: гуще к середине
    // пояса, редеет к краям. Последние scatter крупинок раскиданы по всему
    // слою, чтобы пояс не выглядел вырезанным по линейке.
    const spread = (rng() + rng() + rng() - 1.5) * 1.3;
    let y = i < P.specks ? bandY(x) + spread * P.band * H : rng() * H;
    y = ((y % H) + H) % H;
    g.globalAlpha = between(rng, P.alphaMin, P.alphaMax) * strength;
    g.fillStyle = rgba(colors[i % colors.length], 1);
    const s = between(rng, P.sizeMin, P.sizeMax);
    g.fillRect(x - s / 2, y - s / 2, s, s);
  }
  g.globalAlpha = 1;
}

/** Далёкие галактики: наклонённый эллипс-ореол, яркое ядро, два рукава. */
function paintGalaxies(g, W, H, rng, P, colors, strength) {
  for (let i = 0; i < P.count; i++) {
    // По одной на горизонтальную полосу слоя: случайные координаты склеивали
    // бы их в кучу, а «редкие далёкие» обязаны быть именно редкими.
    const x = rng() * W;
    const y = ((i + between(rng, 0.2, 0.8)) / P.count) * H;
    const r = between(rng, P.rMin, P.rMax) * W;
    const rot = rng() * Math.PI;
    const rgb = colors[i % colors.length];
    const core = mixRgb(rgb, 0xffffff, 0.5);
    wrapDraw(W, H, x, y, r, (cx, cy) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(rot);
      g.scale(1, P.squash);
      softBlob(g, r, rgb, P.haloAlpha * strength);
      softBlob(g, r * 0.3, core, P.coreAlpha * strength);
      // Рукава — по формуле, без случайности: копии через край обязаны
      // совпасть с оригиналом точка в точку.
      g.fillStyle = rgba(core, 1);
      for (let j = 0; j < P.armSpecks; j++) {
        const t = j / P.armSpecks;
        const a = t * 3.4 + (j % 2) * Math.PI;
        const d = r * (0.18 + 0.72 * t);
        g.globalAlpha = P.speckAlpha * strength * (1 - t * 0.7);
        g.fillRect(Math.cos(a) * d - 0.5, Math.sin(a) * d - 0.5, 1, 1);
      }
      g.restore();
    });
  }
  g.globalAlpha = 1;
}

/** Неоновая сетка: линии с шагом, кратным размеру слоя, и редкие узлы. */
function paintGrid(g, W, H, rng, P, colors, strength) {
  const cw = W / P.cols;
  const rows = Math.max(1, Math.round(H / cw));
  const ch = H / rows;
  g.strokeStyle = rgba(colors[0], P.alpha * strength);
  g.lineWidth = P.width;
  g.beginPath();
  // Крайние линии рисуются с обеих сторон: линия на кромке наполовину
  // обрезана, вторая её половина приходит с противоположного края.
  for (let i = 0; i <= P.cols; i++) {
    g.moveTo(i * cw, 0);
    g.lineTo(i * cw, H);
  }
  for (let j = 0; j <= rows; j++) {
    g.moveTo(0, j * ch);
    g.lineTo(W, j * ch);
  }
  g.stroke();

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

/** Поток данных: вертикальные штрихи, яркие к нижнему концу. */
function paintStreaks(g, W, H, rng, P, colors, strength) {
  for (let i = 0; i < P.count; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const len = between(rng, P.lenMin, P.lenMax) * H;
    const rgb = colors[i % colors.length];
    const alpha = P.alpha * strength * between(rng, 0.5, 1);
    wrapDraw(W, H, x, y, len / 2, (cx, cy) => {
      const grad = g.createLinearGradient(0, cy - len / 2, 0, cy + len / 2);
      grad.addColorStop(0, rgba(rgb, 0));
      grad.addColorStop(0.85, rgba(rgb, alpha));
      grad.addColorStop(1, rgba(rgb, 0));
      g.fillStyle = grad;
      g.fillRect(cx - P.width / 2, cy - len / 2, P.width, len);
    });
  }
}

/** Импульс: концентрические кольца, гаснущие от центра наружу. */
function paintRings(g, W, H, rng, P, colors, strength) {
  g.lineWidth = P.width;
  for (let c = 0; c < P.centers; c++) {
    const x = rng() * W;
    const y = ((c + between(rng, 0.2, 0.8)) / P.centers) * H;
    const rgb = colors[c % colors.length];
    for (let k = 0; k < P.rings; k++) {
      const r = (P.rMin + k * P.rStep) * W;
      g.strokeStyle = rgba(rgb, P.alpha * strength * (1 - k / P.rings));
      wrapDraw(W, H, x, y, r, (cx, cy) => {
        g.beginPath();
        g.arc(cx, cy, r, 0, TAU);
        g.stroke();
      });
    }
  }
}
