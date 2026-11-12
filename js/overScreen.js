import { CFG } from './config.js';
import { ui } from './ui.js';

/**
 * Экран поражения. Одна колонка сверху вниз:
 *
 *   счёт
 *   строка статуса: «Новый рекорд!» ИЛИ «Рекорд 92»
 *   достижения забега (до двух): лучшая серия, сектор
 *   задания с прогрессом за этот забег (до трёх)
 *   подсказка «Заберите награду в меню» — если что-то выполнено
 *   [ ЕЩЁ РАЗ ]  [ МЕНЮ ]
 *
 * Вся раскладка и все строки собираются ОДИН раз в show() (и заново на
 * resize): отрисовка только рисует готовые прямоугольники и строки.
 *
 * Если колонка не влезает по высоте, сокращается блок заданий: сначала текст
 * заданий сжимается до одной строки, потом задания убираются с конца. Счёт,
 * статус и кнопки не трогаются никогда.
 */
export class OverScreen {
  constructor() {
    /** @type {{view:{w:number,h:number}, safe:{top:number,bottom:number}}|null} */
    this.deps = null;
    /** Исходные данные забега — нужны, чтобы пересобрать раскладку на resize. */
    this.data = null;
    /** Сколько экран уже показан, с. По нему оживают кнопки. */
    this.t = 0;
    this.scoreText = '';
    this.statusText = '';
    /** @type {{text:string, gold:boolean}[]} */
    this.lines = [];
    /** @type {{lines:string[], count:string, countW:number, before:number, frac:number, done:boolean, y:number, barY:number}[]} */
    this.rows = [];
    /** Готовая геометрия. */
    this.L = null;
    /** Шрифт, под который собрана раскладка: сменился — пересобрать. */
    this.epoch = -1;
  }

  /** @param {NonNullable<OverScreen['deps']>} deps */
  attach(deps) {
    this.deps = deps;
  }

  /**
   * Показать экран с итогами забега.
   * @param {{score:number, best:number, newRecord:boolean, bestStreak:number,
   *   sectorText:string, missions:{text:string,count:string,before:number,frac:number,done:boolean}[],
   *   anyDone:boolean, claimable:boolean}} data
   *   best — рекорд ПОСЛЕ забега; bestStreak — 0, если показывать нечего;
   *   sectorText — пустая строка, если игрок не ушёл дальше первого сектора
   */
  show(data) {
    this.data = data;
    this.t = 0;
    this.layout();
  }

  /** Пересобрать раскладку под текущий размер экрана и шрифт. */
  layout() {
    const d = this.data;
    if (!d) return;
    const O = CFG.over;
    const { view, safe } = this.deps;
    this.epoch = ui.epoch;

    const w = Math.min(O.maxWidth, view.w - O.sideMargin * 2);
    const x = (view.w - w) / 2;

    this.scoreText = String(d.score);
    // Никогда не «Рекорд 92» при счёте 92: побитый рекорд — это событие, а не
    // справка, и повторять только что показанное число незачем.
    if (d.newRecord) this.statusText = O.text.newRecord;
    else if (d.score > 0 && d.score === d.best) this.statusText = O.text.tie;
    else this.statusText = O.text.record.replace('{n}', String(d.best));

    this.lines.length = 0;
    if (d.bestStreak > 0) {
      this.lines.push({ text: O.text.bestStreak.replace('{n}', String(d.bestStreak)), gold: true });
    }
    if (d.sectorText) this.lines.push({ text: d.sectorText, gold: false });

    const capH = ui.size('score') * CFG.type.capRatio;
    const lineH = ui.lineH('caption');
    const barH = CFG.missions.barH;
    const textW = w - O.missionPad * 2 - O.missionCountW;
    const avail = view.h - safe.top - safe.bottom - O.minMargin * 2;

    // Высота всего, кроме блока заданий.
    const fixedH = capH + O.statusGap
      + (this.lines.length ? O.blockGap + this.lines.length * O.lineH - (O.lineH - ui.size('body')) : 0)
      + O.blockGap + O.buttonH * 2 + O.buttonGap;

    // Блок заданий: подбираем, сколько строк и заданий влезает.
    let count = Math.min(d.missions.length, 3);
    let maxLines = 2;
    let blockH = 0;
    for (;;) {
      this.rows.length = 0;
      blockH = 0;
      if (count > 0) {
        blockH = O.missionPad * 2 + (count - 1) * O.missionRowGap;
        for (let i = 0; i < count; i++) {
          const m = d.missions[i];
          const lines = ui.wrap(m.text, 'caption', textW, maxLines);
          this.rows.push({
            lines, count: m.count, countW: ui.width(m.count, 'label'),
            before: m.before, frac: m.frac, done: m.done, y: 0, barY: 0,
          });
          blockH += lines.length * lineH + O.missionBarGap + barH;
        }
        blockH += O.blockGap;
        if (d.anyDone) blockH += O.hintGap + ui.size('caption');
      }
      if (fixedH + blockH <= avail || count === 0) break;
      if (maxLines > 1) maxLines = 1;
      else count--;
    }

    // Колонка стоит по центру экрана по вертикали.
    const total = fixedH + blockH;
    let y = safe.top + O.minMargin + Math.max(0, (avail - total) / 2);

    const scoreY = y + capH;
    y = scoreY + O.statusGap;
    const statusY = y;
    let linesY = 0;
    if (this.lines.length) {
      y += O.blockGap;
      linesY = y + ui.size('body') * CFG.type.capRatio;
      y += this.lines.length * O.lineH - (O.lineH - ui.size('body'));
    }

    let block = null;
    let hintY = 0;
    if (count > 0) {
      y += O.blockGap;
      const top = y;
      let ry = top + O.missionPad;
      for (const row of this.rows) {
        row.y = ry;
        ry += row.lines.length * lineH + O.missionBarGap;
        row.barY = ry;
        ry += barH + O.missionRowGap;
      }
      const h = ry - O.missionRowGap + O.missionPad - top;
      block = { x, y: top, w, h };
      y = top + h;
      if (d.anyDone) {
        y += O.hintGap + ui.size('caption');
        hintY = y;
      }
    }

    y += O.blockGap;
    const again = { x, y, w, h: O.buttonH };
    const menu = { x, y: y + O.buttonH + O.buttonGap, w, h: O.buttonH };
    this.L = { x, w, scoreY, statusY, linesY, block, hintY, again, menu, lineH };
  }

  /** @param {number} dtReal */
  update(dtReal) {
    this.t += dtReal;
  }

  /** @returns {boolean} ожили ли кнопки */
  armed() {
    return this.t >= CFG.over.armDelay;
  }

  /**
   * Куда попал тап. Пока кнопки не ожили — никуда: тап, которым игрок
   * пытался прыгнуть в момент смерти, не должен ничего запускать.
   * @returns {'again'|'menu'|''}
   */
  hitTest(x, y) {
    if (!this.L || !this.armed()) return '';
    if (ui.hit(this.L.again, x, y)) return 'again';
    if (ui.hit(this.L.menu, x, y)) return 'menu';
    return '';
  }

  /**
   * @param {ReturnType<typeof import('./config.js').theme>} T
   * @param {number} fade прозрачность экрана
   */
  draw(T, fade) {
    if (!this.data) return;
    // Шрифт подгрузился, пока экран открыт: ширины и переносы уже не те.
    if (this.epoch !== ui.epoch) this.layout();
    const d = this.data;
    const L = this.L;
    const O = CFG.over;
    const ctx = ui.ctx;
    const cx = this.deps.view.w / 2;

    ctx.save();
    ctx.globalAlpha = fade;
    ui.overlay(T);

    ui.text(this.scoreText, cx, L.scoreY, 'score', T.accent);

    if (d.newRecord) {
      // Короткий всплеск масштаба: рекорд — событие, а не строка справки.
      const k = Math.max(0, 1 - this.t / O.recordPopTime);
      const scale = 1 + O.recordPopScale * k * k;
      ctx.save();
      ctx.translate(cx, L.statusY);
      ctx.scale(scale, scale);
      ui.text(this.statusText, 0, 0, 'strong', T.gold);
      ctx.restore();
    } else {
      ui.text(this.statusText, cx, L.statusY, 'body', T.dim);
    }

    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      ui.text(line.text, cx, L.linesY + i * O.lineH, 'body', line.gold ? T.gold : T.accent);
    }

    if (L.block) {
      const b = L.block;
      ui.card(T, b.x, b.y, b.w, b.h);
      const left = b.x + O.missionPad;
      const right = b.x + b.w - O.missionPad;
      const ascent = ui.size('caption') * 0.82;
      for (const row of this.rows) {
        for (let k = 0; k < row.lines.length; k++) {
          ui.text(row.lines[k], left, row.y + ascent + k * L.lineH, 'caption', T.accent, 'left');
        }
        const color = row.done ? T.gold : T.dim;
        ui.text(row.count, right, row.y + ascent, 'label', color, 'right');
        if (row.done) ui.check(right - row.countW - 12, row.y + ascent - 4, 5, T.gold);
        // Полоска показывает и «было», и «стало»: приглушённая часть — прогресс
        // до забега, яркая — то, что добавил этот забег.
        const bw = right - left;
        ui.bar(T, left, row.barY, bw, CFG.missions.barH, row.frac, row.done ? T.gold : T.accent);
        if (!row.done && row.before > 0) {
          ui.bar(T, left, row.barY, bw * row.before, CFG.missions.barH, 1, T.dim);
        }
      }
      if (L.hintY) ui.text(CFG.missions.text.overHint, cx, L.hintY, 'caption', T.gold);
    }

    // Кнопки проявляются вместе с тем, как оживают.
    const armK = Math.min(1, this.t / O.armDelay);
    ctx.globalAlpha = fade * (O.armedAlphaFrom + (1 - O.armedAlphaFrom) * armK);
    ui.button(T, L.again, O.text.again, 'primary');
    ui.button(T, L.menu, O.text.menu, 'secondary');
    if (d.claimable) ui.badgeDot(T, L.menu);
    ctx.restore();
  }
}
