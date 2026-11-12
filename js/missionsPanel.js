import { CFG, MISSION_TIERS } from './config.js';

/**
 * Панель ежедневных заданий поверх главного меню.
 *
 * Только интерфейс: состояние дня, прогресс и награды живут в Missions.
 * Тап возвращает действие, а эффекты (осколки к счётчику, звук, вибрация)
 * делает main.js — там уже живут частицы и звук, и второй экземпляр завёлся
 * бы ради одной кнопки.
 *
 * Вся панель рисуется в СВОИХ локальных координатах (0,0 — левый верхний угол
 * панели) и ставится на экран одним translate+scale. Так на коротком экране
 * её можно ужать целиком, а попадания тапа пересчитываются одной формулой.
 */
export class MissionsPanel {
  /** @param {import('./missions.js').Missions} missions */
  constructor(missions) {
    this.missions = missions;
    this.open = false;
    /** Прогресс fade, 0..1, по реальному времени. */
    this.fade = 0;
    /**
     * Внешние кисти. Инъекция, а не импорт из main.js — иначе цикл модулей.
     * @type {{ctx:CanvasRenderingContext2D, view:{w:number,h:number},
     *   safe:{top:number,bottom:number}, roundRect:Function, drawShardIcon:Function}|null}
     */
    this.deps = null;
    /** Кэш раскладки: пересобирается при смене размеров экрана или текстов. */
    this.layoutCache = null;
    this.layoutKey = '';
    /** Куда летят осколки при получении награды — счётчик в шапке, экранные px. */
    this.balanceAt = { x: 0, y: 0 };
    /** Всплывающее «+N» над нажатой кнопкой, локальные координаты панели. */
    this.popup = { t: 0, amount: 0, x: 0, y: 0 };
  }

  /** @param {NonNullable<MissionsPanel['deps']>} deps */
  attach(deps) {
    this.deps = deps;
  }

  show() {
    this.open = true;
    // День мог смениться, пока висело меню: панель обязана открыться уже с
    // актуальным набором и таймером.
    this.missions.ensureDay();
  }

  hide() {
    this.open = false;
  }

  /** @param {number} dtReal */
  updateUi(dtReal) {
    const step = dtReal / CFG.ui.panelFadeTime;
    this.fade = this.open ? Math.min(1, this.fade + step) : Math.max(0, this.fade - step);
    if (this.popup.t > 0) this.popup.t = Math.max(0, this.popup.t - dtReal);
  }

  // -------------------------------------------------------------------------
  // Раскладка
  // -------------------------------------------------------------------------

  /**
   * Разбить текст задания на строки по ширине. Слов в тексте мало, а
   * вызывается это только при пересборке раскладки, не каждый кадр.
   * @param {string} text
   * @param {number} maxW
   * @returns {string[]}
   */
  wrap(text, maxW) {
    const { ctx } = this.deps;
    const M = CFG.missions;
    ctx.font = `500 ${M.textFont}px system-ui, -apple-system, sans-serif`;
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (cur && ctx.measureText(next).width > maxW) {
        lines.push(cur);
        cur = w;
      } else {
        cur = next;
      }
    }
    if (cur) lines.push(cur);
    if (lines.length > M.textMaxLines) {
      // В стартовом пуле так не бывает, но новый длинный текст не должен
      // растягивать карточку на весь экран: режем с многоточием.
      const kept = lines.slice(0, M.textMaxLines);
      let last = kept[kept.length - 1];
      while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
      kept[kept.length - 1] = `${last}…`;
      return kept;
    }
    return lines;
  }

  /**
   * Раскладка панели. Единственный источник геометрии: и отрисовка, и тапы
   * берут прямоугольники отсюда.
   * @returns {{w:number, h:number, k:number, ox:number, oy:number, inner:number,
   *   rows:{y:number, h:number, lines:string[], control:number,
   *     button:{x:number,y:number,w:number,h:number}}[],
   *   bonus:{x:number,y:number,w:number,h:number}, bonusButton:{x:number,y:number,w:number,h:number},
   *   timerY:number, close:{x:number,y:number,w:number,h:number}}}
   */
  layout() {
    const { view, safe } = this.deps;
    const M = CFG.missions;
    const key = `${view.w}x${view.h}|${safe.top}|${safe.bottom}|${this.missions.texts.join('|')}`;
    if (this.layoutCache && key === this.layoutKey) return this.layoutCache;

    const w = Math.min(M.panelMaxWidth, view.w - M.panelSideMargin * 2);
    const inner = w - M.panelPadding * 2;
    const textW = inner - M.rowPad * 2;
    const x0 = M.panelPadding;

    let y = M.panelPadding + M.titleH;
    const rows = [];
    for (let i = 0; i < MISSION_TIERS.length; i++) {
      const lines = this.wrap(this.missions.texts[i], textW);
      const h = M.rowPad + M.tierH + lines.length * M.textLineH + M.textGap + M.controlH + M.rowPad;
      const control = y + M.rowPad + M.tierH + lines.length * M.textLineH + M.textGap;
      rows.push({
        y, h, lines, control,
        button: {
          x: x0 + inner - M.rowPad - M.buttonW, y: control, w: M.buttonW, h: M.controlH,
        },
      });
      y += h + M.rowGap;
    }
    const bonus = { x: x0, y, w: inner, h: M.bonusH };
    const bonusButton = {
      x: x0 + inner - M.rowPad - M.buttonW, y: y + (M.bonusH - M.controlH) / 2,
      w: M.buttonW, h: M.controlH,
    };
    y += M.bonusH;
    const timerY = y + M.timerH / 2 + 4;
    y += M.timerH;
    const close = { x: x0, y, w: inner, h: M.closeH };
    y += M.closeH + M.panelPadding;
    const h = y;

    // Не влезает по высоте — ужимаем целиком, но не мельче panelMinScale.
    const avail = view.h - safe.top - safe.bottom - M.panelScreenMargin * 2;
    const k = Math.max(M.panelMinScale, Math.min(1, avail / h));
    const ox = (view.w - w * k) / 2;
    const oy = safe.top + M.panelScreenMargin + Math.max(0, (avail - h * k) / 2);

    this.layoutCache = { w, h, k, ox, oy, inner, rows, bonus, bonusButton, timerY, close };
    this.layoutKey = key;
    return this.layoutCache;
  }

  // -------------------------------------------------------------------------
  // Ввод
  // -------------------------------------------------------------------------

  /**
   * Разобрать тап. Возвращает действие для main.js.
   * @param {number} x @param {number} y экранные px
   * @returns {{kind:'close'}|{kind:'claim'|'bonus', amount:number, x:number, y:number}
   *   |{kind:'reroll'}|{kind:'none'}}
   */
  handleTap(x, y) {
    const L = this.layout();
    const lx = (x - L.ox) / L.k;
    const ly = (y - L.oy) / L.k;
    const inside = lx >= 0 && lx <= L.w && ly >= 0 && ly <= L.h;
    if (!inside || hit(L.close, lx, ly)) return { kind: 'close' };

    const m = this.missions;
    for (let i = 0; i < L.rows.length; i++) {
      const b = L.rows[i].button;
      if (!hit(b, lx, ly)) continue;
      const s = m.state.slots[i];
      if (s.done && !s.claimed) {
        const amount = m.claim(i);
        if (amount > 0) {
          this.startPopup(amount, b);
          return { kind: 'claim', amount, ...this.toScreen(L, b.x + b.w / 2, b.y + b.h / 2) };
        }
      } else if (m.canReroll(i) && m.reroll(i)) {
        return { kind: 'reroll' };
      }
      return { kind: 'none' };
    }

    if (hit(L.bonusButton, lx, ly)) {
      const amount = m.claimBonus();
      if (amount > 0) {
        const b = L.bonusButton;
        this.startPopup(amount, b);
        return { kind: 'bonus', amount, ...this.toScreen(L, b.x + b.w / 2, b.y + b.h / 2) };
      }
    }
    return { kind: 'none' };
  }

  /** @param {number} amount @param {{x:number,y:number,w:number}} b */
  startPopup(amount, b) {
    this.popup.t = CFG.shards.popupTime;
    this.popup.amount = amount;
    this.popup.x = b.x + b.w / 2;
    this.popup.y = b.y;
  }

  /**
   * Локальные координаты панели -> экранные.
   * @returns {{x:number,y:number}}
   */
  toScreen(L, lx, ly) {
    return { x: L.ox + lx * L.k, y: L.oy + ly * L.k };
  }

  // -------------------------------------------------------------------------
  // Отрисовка
  // -------------------------------------------------------------------------

  /**
   * @param {ReturnType<typeof import('./config.js').theme>} T
   * @param {number} shards текущий баланс
   */
  draw(T, shards) {
    if (this.fade <= 0) return;
    const { ctx, view, roundRect, drawShardIcon } = this.deps;
    const M = CFG.missions;
    const TX = M.text;
    const m = this.missions;
    const L = this.layout();
    const x0 = M.panelPadding;

    ctx.save();
    ctx.globalAlpha = this.fade;
    ctx.fillStyle = T.overlay;
    ctx.fillRect(0, 0, view.w, view.h);

    ctx.translate(L.ox, L.oy);
    ctx.scale(L.k, L.k);

    ctx.fillStyle = T.panel;
    roundRect(0, 0, L.w, L.h, M.panelCorner);
    ctx.fill();
    ctx.strokeStyle = T.panelEdge;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Шапка: заголовок слева, баланс справа — туда же летят забранные осколки.
    const titleBase = M.panelPadding + M.titleH / 2 + 6;
    ctx.textAlign = 'left';
    ctx.fillStyle = T.accent;
    ctx.font = '700 18px system-ui, -apple-system, sans-serif';
    ctx.fillText(TX.title, x0, titleBase);
    const bal = String(shards);
    ctx.font = '600 16px system-ui, -apple-system, sans-serif';
    const balW = ctx.measureText(bal).width;
    ctx.textAlign = 'right';
    ctx.fillText(bal, x0 + L.inner, titleBase);
    const iconX = x0 + L.inner - balW - 14;
    drawShardIcon(iconX, titleBase - 5, 7, T);
    this.balanceAt.x = L.ox + iconX * L.k;
    this.balanceAt.y = L.oy + (titleBase - 5) * L.k;

    for (let i = 0; i < L.rows.length; i++) this.drawRow(T, L, i);
    this.drawBonus(T, L);

    ctx.textAlign = 'center';
    ctx.fillStyle = T.dim;
    ctx.font = '500 12px system-ui, -apple-system, sans-serif';
    ctx.fillText(m.timerString(Date.now()), L.w / 2, L.timerY);

    drawButton(this.deps, L.close, TX.close, T, false);

    if (this.popup.t > 0) {
      const S = CFG.shards;
      const kk = 1 - this.popup.t / S.popupTime;
      const a = kk < S.popupFadeFrom ? 1 : 1 - (kk - S.popupFadeFrom) / (1 - S.popupFadeFrom);
      ctx.globalAlpha = this.fade * Math.max(0, a);
      ctx.fillStyle = T.shard;
      ctx.font = '700 18px system-ui, -apple-system, sans-serif';
      ctx.fillText(`+${this.popup.amount}`, this.popup.x, this.popup.y - 6 - kk * S.popupRise);
    }
    ctx.restore();
  }

  /** Карточка одного задания. */
  drawRow(T, L, i) {
    const { ctx, roundRect } = this.deps;
    const M = CFG.missions;
    const TX = M.text;
    const m = this.missions;
    const s = m.state.slots[i];
    const r = L.rows[i];
    const x = M.panelPadding;
    const left = x + M.rowPad;
    const right = x + L.inner - M.rowPad;

    ctx.save();
    // Забранное задание отходит на второй план: дело сделано.
    if (s.claimed) ctx.globalAlpha *= CFG.shop.cardDimAlpha;
    ctx.fillStyle = T.control;
    roundRect(x, r.y, L.inner, r.h, M.rowCorner);
    ctx.fill();
    // Готовое к получению подсвечено рамкой акцента — взгляд должен падать сюда.
    ctx.strokeStyle = s.done && !s.claimed ? T.accent : T.panelEdge;
    ctx.lineWidth = s.done && !s.claimed ? 1.5 : 1;
    ctx.stroke();

    // Строка сложности и награды. Цвет сложности — рампа «нагрева» темы:
    // она уже подобрана под каждую тему и читается как «чем дальше, тем жарче».
    const tierY = r.y + M.rowPad + 11;
    ctx.textAlign = 'left';
    ctx.font = '700 11px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = T.multiplierTint[Math.min(i, T.multiplierTint.length - 1)];
    ctx.fillText(TX.tiers[s.tier], left, tierY);
    drawReward(this.deps, right, tierY, m.reward(i), T);

    ctx.fillStyle = T.accent;
    ctx.font = `500 ${M.textFont}px system-ui, -apple-system, sans-serif`;
    for (let k = 0; k < r.lines.length; k++) {
      ctx.fillText(r.lines[k], left, r.y + M.rowPad + M.tierH + (k + 1) * M.textLineH - 4);
    }

    // Справа — кнопка или подпись; полоса прогресса занимает остальное.
    let barRight = right;
    if (s.done && !s.claimed) {
      drawButton(this.deps, r.button, TX.claim, T, true);
      barRight = r.button.x - M.buttonGap;
    } else if (s.claimed) {
      ctx.textAlign = 'right';
      ctx.fillStyle = T.dim;
      ctx.font = '600 12px system-ui, -apple-system, sans-serif';
      ctx.fillText(TX.claimed, right, r.control + M.controlH / 2 + 4);
      barRight = r.button.x - M.buttonGap;
    } else if (m.canReroll(i)) {
      drawButton(this.deps, r.button, TX.reroll, T, false);
      barRight = r.button.x - M.buttonGap;
    }

    const target = m.target(i);
    const value = m.progress(i);
    ctx.textAlign = 'right';
    ctx.fillStyle = T.dim;
    ctx.font = '600 12px system-ui, -apple-system, sans-serif';
    ctx.fillText(`${value} / ${target}`, barRight, r.control + 13);
    drawBar(this.deps, left, r.control + M.controlH - M.barH - 4, barRight - left,
      value / target, s.done ? T.accent : T.shard, T);
    ctx.restore();
  }

  /** Строка бонуса за все три. */
  drawBonus(T, L) {
    const { ctx, roundRect } = this.deps;
    const M = CFG.missions;
    const TX = M.text;
    const m = this.missions;
    const b = L.bonus;
    const left = b.x + M.rowPad;
    const ready = m.bonusReady();
    const claimed = m.state.bonusClaimed;

    ctx.save();
    if (claimed) ctx.globalAlpha *= CFG.shop.cardDimAlpha;
    ctx.fillStyle = T.control;
    roundRect(b.x, b.y, b.w, b.h, M.rowCorner);
    ctx.fill();
    ctx.strokeStyle = ready ? T.accent : T.panelEdge;
    ctx.lineWidth = ready ? 1.5 : 1;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = T.accent;
    ctx.font = '600 14px system-ui, -apple-system, sans-serif';
    ctx.fillText(TX.bonus, left, b.y + 22);
    ctx.fillStyle = T.dim;
    ctx.font = '600 12px system-ui, -apple-system, sans-serif';
    ctx.fillText(`${m.doneCount()} / ${m.state.slots.length}`, left, b.y + 40);
    // Награду бонуса видно всегда — это и есть повод закрыть третье задание.
    drawReward(this.deps, left + 64, b.y + 40, M.allBonus, T, 'left');

    const right = b.x + b.w - M.rowPad;
    if (ready) {
      drawButton(this.deps, L.bonusButton, TX.claim, T, true);
    } else if (claimed) {
      ctx.textAlign = 'right';
      ctx.fillStyle = T.dim;
      ctx.font = '600 12px system-ui, -apple-system, sans-serif';
      ctx.fillText(TX.claimed, right, b.y + b.h / 2 + 4);
    }
    ctx.restore();
  }
}

/**
 * «+20 ◆»: награда с иконкой кристалла.
 * @param {string} [align] 'right' — x правый край, 'left' — левый
 */
function drawReward(deps, x, baseline, amount, T, align = 'right') {
  const { ctx, drawShardIcon } = deps;
  const label = `+${amount}`;
  ctx.font = '700 13px system-ui, -apple-system, sans-serif';
  const w = ctx.measureText(label).width;
  const iconR = 5.5;
  const gap = 7;
  const total = w + gap + iconR * 1.4;
  const start = align === 'right' ? x - total : x;
  ctx.textAlign = 'left';
  ctx.fillStyle = T.shard;
  ctx.fillText(label, start, baseline);
  drawShardIcon(start + w + gap + iconR * 0.7, baseline - 4.5, iconR, T);
}

/** Полоса прогресса. */
function drawBar(deps, x, y, w, frac, color, T) {
  const { ctx, roundRect } = deps;
  const h = CFG.missions.barH;
  ctx.fillStyle = T.panelEdge;
  roundRect(x, y, w, h, h / 2);
  ctx.fill();
  const f = Math.min(Math.max(frac, 0), 1);
  if (f <= 0) return;
  ctx.fillStyle = color;
  roundRect(x, y, Math.max(h, w * f), h, h / 2);
  ctx.fill();
}

/** Кнопка в стиле панели настроек. */
function drawButton(deps, r, label, T, primary) {
  const { ctx, roundRect } = deps;
  ctx.fillStyle = primary ? T.accent : T.control;
  roundRect(r.x, r.y, r.w, r.h, 10);
  ctx.fill();
  if (!primary) {
    ctx.strokeStyle = T.panelEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.font = '700 13px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = primary ? T.panel : T.accent;
  ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 5);
}

/** @returns {boolean} попал ли тап в прямоугольник */
function hit(r, x, y) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}
