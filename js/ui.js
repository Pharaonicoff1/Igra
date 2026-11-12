import { CFG } from './config.js';

/**
 * Общий набор элементов интерфейса: шрифты по ролям, кнопки, панели,
 * полоски прогресса, иконки.
 *
 * Зачем отдельный модуль. Раньше каждый экран рисовал свои кнопки и писал
 * свои `ctx.font = '700 17px …'`, и интерфейс расползся: шесть кеглей, три
 * вида кнопок, разные скругления. Здесь один источник: размер и насыщенность
 * берутся из роли (CFG.type), форма кнопки и панели — из CFG.ui, цвета — из
 * ролей темы. Экран, которому нужна кнопка, не может нарисовать её «чуть иначе».
 *
 * Состояние одно на игру (экспортируется готовый экземпляр): канвас у игры
 * один, и шрифт загружается один раз.
 */
class Ui {
  constructor() {
    /** @type {CanvasRenderingContext2D|null} */
    this.ctx = null;
    /** @type {{w:number,h:number}|null} */
    this.view = null;
    /** Загружен ли шрифт интерфейса. Пока нет — рисуем системным. */
    this.fontReady = false;
    /**
     * Номер «поколения» шрифта. Растёт, когда шрифт подгрузился: все, кто
     * кэширует ширину текста или переносы, сверяются с ним и пересчитывают.
     */
    this.epoch = 0;
    /** Готовые строки ctx.font по ролям — собираются один раз, не в кадре. */
    this.fonts = {};
    /** Кэш ширин: роль -> (текст -> ширина). Без склейки ключей в кадре. */
    this.widths = new Map();
    /** Кэш переносов: роль -> (текст -> {maxW, epoch, lines}). */
    this.wraps = new Map();
    this.buildFonts();
  }

  /** @param {CanvasRenderingContext2D} ctx @param {{w:number,h:number}} view */
  attach(ctx, view) {
    this.ctx = ctx;
    this.view = view;
  }

  // -------------------------------------------------------------------------
  // Шрифты
  // -------------------------------------------------------------------------

  /** Пересобрать строки шрифтов под текущее состояние загрузки. */
  buildFonts() {
    const TY = CFG.type;
    const family = this.fontReady ? `"${TY.family}", ${TY.fallback}` : TY.fallback;
    for (const role of Object.keys(TY.roles)) {
      const r = TY.roles[role];
      this.fonts[role] = `${r.weight} ${TY.sizes[r.size]}px ${family}`;
    }
    this.widths.clear();
    this.wraps.clear();
    this.epoch++;
  }

  /** Шрифт загрузился: со следующего кадра весь интерфейс рисуется им. */
  setFontReady() {
    if (this.fontReady) return;
    this.fontReady = true;
    this.buildFonts();
  }

  /** @param {string} role роль из CFG.type.roles @returns {string} строка для ctx.font */
  font(role) {
    return this.fonts[role];
  }

  /** @param {string} role @returns {number} кегль роли, px */
  size(role) {
    return CFG.type.sizes[CFG.type.roles[role].size];
  }

  /** @param {string} role @returns {number} шаг строк переносимого текста, px */
  lineH(role) {
    return Math.round(this.size(role) * CFG.type.lineRatio);
  }

  /**
   * Смещение базовой линии от центра строки: текст с такой базовой линией
   * стоит по вертикали ровно посередине.
   * @param {string} role
   * @returns {number} px
   */
  midOffset(role) {
    return this.size(role) * CFG.type.capRatio / 2;
  }

  /**
   * Ширина текста в данной роли, с кэшем. Для постоянных надписей (кнопки,
   * подписи) измерение делается один раз. Меняющиеся каждый кадр числа сюда
   * носить не надо — их ширину вызывающий хранит у себя и обновляет по событию.
   * @param {string} text @param {string} role
   * @returns {number}
   */
  width(text, role) {
    let byRole = this.widths.get(role);
    if (!byRole) {
      byRole = new Map();
      this.widths.set(role, byRole);
    }
    let w = byRole.get(text);
    if (w === undefined) {
      // Кэш не должен расти без конца, если в него всё же попадут числа.
      if (byRole.size > 400) byRole.clear();
      this.ctx.font = this.fonts[role];
      w = this.ctx.measureText(text).width;
      byRole.set(text, w);
    }
    return w;
  }

  /**
   * Разбить текст на строки по ширине, с кэшем. Не влезло в maxLines —
   * последняя строка обрезается многоточием.
   * @param {string} text @param {string} role
   * @param {number} maxW @param {number} maxLines
   * @returns {string[]}
   */
  wrap(text, role, maxW, maxLines) {
    let byRole = this.wraps.get(role);
    if (!byRole) {
      byRole = new Map();
      this.wraps.set(role, byRole);
    }
    const hit = byRole.get(text);
    if (hit && hit.maxW === maxW && hit.maxLines === maxLines) return hit.lines;

    const ctx = this.ctx;
    ctx.font = this.fonts[role];
    const words = text.split(' ');
    let lines = [];
    let cur = '';
    for (const word of words) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && ctx.measureText(next).width > maxW) {
        lines.push(cur);
        cur = word;
      } else {
        cur = next;
      }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      let last = lines[maxLines - 1];
      while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
      lines[maxLines - 1] = `${last}…`;
    }
    if (byRole.size > 200) byRole.clear();
    byRole.set(text, { maxW, maxLines, lines });
    return lines;
  }

  /**
   * Написать текст: роль задаёт шрифт, цвет приходит ролью темы.
   * @param {string} text
   * @param {number} x @param {number} y базовая линия
   * @param {string} role @param {string} color
   * @param {CanvasTextAlign} [align]
   */
  text(text, x, y, role, color, align = 'center') {
    const ctx = this.ctx;
    ctx.font = this.fonts[role];
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
  }

  /** То же, но y — ЦЕНТР строки по вертикали. */
  textMid(text, x, cy, role, color, align = 'center') {
    this.text(text, x, cy + this.midOffset(role), role, color, align);
  }

  // -------------------------------------------------------------------------
  // Формы
  // -------------------------------------------------------------------------

  /**
   * Прямоугольник со скруглением. Своя реализация вместо ctx.roundRect —
   * та появилась в Safari только в 16.4, а игра должна открываться и на старых.
   */
  roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /**
   * Плотное затемнение всего экрана под оверлеем. Одно на все оверлеи:
   * настройки, задания, воскрешение, поражение.
   * @param {ReturnType<typeof import('./config.js').theme>} T
   */
  overlay(T) {
    const ctx = this.ctx;
    ctx.fillStyle = T.overlay;
    ctx.fillRect(0, 0, this.view.w, this.view.h);
  }

  /** Непрозрачная панель с тонкой рамкой. */
  panel(T, x, y, w, h) {
    const ctx = this.ctx;
    ctx.fillStyle = T.panel;
    this.roundRect(x, y, w, h, CFG.ui.panelCorner);
    ctx.fill();
    ctx.strokeStyle = T.panelEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** Карточка внутри панели. marked — рамка акцентом («сюда смотреть»). */
  card(T, x, y, w, h, edge = T.panelEdge, edgeWidth = 1) {
    const ctx = this.ctx;
    ctx.fillStyle = T.control;
    this.roundRect(x, y, w, h, CFG.ui.cardCorner);
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.lineWidth = edgeWidth;
    ctx.stroke();
  }

  /**
   * Кнопка. Три вида на весь интерфейс:
   *  primary — залита основным цветом, главное действие экрана;
   *  secondary — контурная, второстепенное действие;
   *  disabled — контурная и притушенная: нажать нельзя.
   *
   * @param {ReturnType<typeof import('./config.js').theme>} T
   * @param {{x:number,y:number,w:number,h:number}} r
   * @param {string} label
   * @param {'primary'|'secondary'|'disabled'} kind
   * @param {{dx?:number, shard?:boolean, check?:boolean, role?:string, glow?:number}} [opts]
   *   dx — сдвиг (тряска отказа); shard — кристалл после надписи («КУПИТЬ ЗА 80 ◆»);
   *   check — галочка перед надписью; role — роль шрифта (по умолчанию button);
   *   glow — свечение главной кнопки меню, px
   */
  button(T, r, label, kind, opts) {
    const ctx = this.ctx;
    const dx = opts && opts.dx ? opts.dx : 0;
    const role = opts && opts.role ? opts.role : 'button';
    const primary = kind === 'primary';
    const x = r.x + dx;

    ctx.save();
    if (kind === 'disabled') ctx.globalAlpha *= CFG.ui.disabledAlpha;
    if (primary && opts && opts.glow) {
      ctx.shadowColor = T.accent;
      ctx.shadowBlur = opts.glow;
    }
    ctx.fillStyle = primary ? T.accent : T.control;
    this.roundRect(x, r.y, r.w, r.h, CFG.ui.buttonCorner);
    ctx.fill();
    ctx.shadowBlur = 0;
    if (!primary) {
      ctx.strokeStyle = T.panelEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    const color = primary ? T.panel : T.accent;
    const cy = r.y + r.h / 2;
    const textW = this.width(label, role);
    const iconR = CFG.shop.priceIconR;
    const shardW = opts && opts.shard ? iconR * 1.4 + 7 : 0;
    const checkW = opts && opts.check ? 18 : 0;
    let left = x + (r.w - (checkW + textW + shardW)) / 2;
    if (checkW) {
      this.check(left + 6, cy, 6, color);
      left += checkW;
    }
    this.textMid(label, left, cy, role, color, 'left');
    if (shardW) this.shardIcon(left + textW + 7 + iconR * 0.7, cy, iconR, T, primary);
    ctx.restore();
  }

  /**
   * Иконка-кристалл: ромб с холодным свечением. Один рисовальщик на весь
   * интерфейс — иначе валюта выглядела бы разными предметами.
   * @param {boolean} [flat] без свечения — на светлой заливке кнопки оно грязнит
   */
  shardIcon(cx, cy, r, T, flat = false) {
    const ctx = this.ctx;
    if (!flat) {
      // Свечение — отдельный полупрозрачный ромб побольше, без shadowBlur.
      ctx.fillStyle = T.shardGlow;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 1.6);
      ctx.lineTo(cx + r * 1.1, cy);
      ctx.lineTo(cx, cy + r * 1.6);
      ctx.lineTo(cx - r * 1.1, cy);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = T.shard;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r * 0.66, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r * 0.66, cy);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * «+20 ◆»: награда с кристаллом. Фиолетовый — только про осколки.
   * @param {'left'|'right'} align к какому краю прижат блок
   * @returns {number} ширина блока, px
   */
  reward(text, x, cy, T, align = 'right') {
    const iconR = CFG.shop.priceIconR;
    const w = this.width(text, 'label');
    const total = w + 7 + iconR * 1.4;
    const left = align === 'right' ? x - total : x;
    this.textMid(text, left, cy, 'label', T.shard, 'left');
    this.shardIcon(left + w + 7 + iconR * 0.7, cy, iconR, T);
    return total;
  }

  /** Галочка — рисуется линией, а не символом: в шрифте её может не быть. */
  check(cx, cy, s, color) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, s * 0.36);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - s, cy);
    ctx.lineTo(cx - s * 0.3, cy + s * 0.7);
    ctx.lineTo(cx + s, cy - s * 0.7);
    ctx.stroke();
    ctx.restore();
  }

  /** Иконка замены ↻: дуга со стрелкой, тоже линией. */
  reroll(cx, cy, s, color) {
    const ctx = this.ctx;
    const r = s / 2;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI * 0.35, Math.PI * 1.25);
    ctx.stroke();
    // Наконечник на верхнем конце дуги.
    const a = -Math.PI * 0.35;
    const ex = cx + Math.cos(a) * r;
    const ey = cy + Math.sin(a) * r;
    ctx.beginPath();
    ctx.moveTo(ex + 1, ey - 6);
    ctx.lineTo(ex + 5, ey + 2);
    ctx.lineTo(ex - 4, ey + 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * Полоска прогресса.
   * @param {number} frac 0..1
   * @param {string} color цвет заполнения
   */
  bar(T, x, y, w, h, frac, color) {
    const ctx = this.ctx;
    ctx.fillStyle = T.panelEdge;
    this.roundRect(x, y, w, h, h / 2);
    ctx.fill();
    const f = Math.min(Math.max(frac, 0), 1);
    if (f <= 0) return;
    ctx.fillStyle = color;
    this.roundRect(x, y, Math.max(h, w * f), h, h / 2);
    ctx.fill();
  }

  /** Точка-бейдж «есть награда» в правом верхнем углу кнопки. */
  badgeDot(T, r) {
    const M = CFG.missions;
    const ctx = this.ctx;
    ctx.fillStyle = T.gold;
    ctx.beginPath();
    ctx.arc(r.x + r.w - M.dotInset, r.y + M.dotInset, M.dotR, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Попал ли тап в прямоугольник. Зона расширяется до CFG.ui.minTap по каждой
   * стороне, если сам элемент меньше: палец не обязан целиться в 30 пикселей.
   * @param {{x:number,y:number,w:number,h:number}} r
   */
  hit(r, x, y) {
    const min = CFG.ui.minTap;
    const padX = Math.max(0, (min - r.w) / 2);
    const padY = Math.max(0, (min - r.h) / 2);
    return x >= r.x - padX && x <= r.x + r.w + padX && y >= r.y - padY && y <= r.y + r.h + padY;
  }
}

export const ui = new Ui();
