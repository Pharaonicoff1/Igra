import { CFG, MISSION_TIERS } from './config.js';
import { ui } from './ui.js';

/**
 * Панель ежедневных заданий поверх главного меню.
 *
 * Только интерфейс: состояние дня, прогресс и награды живут в Missions.
 * Тап возвращает действие, а эффекты (осколки к счётчику, звук, вибрация)
 * делает main.js — там уже живут частицы и звук.
 *
 * ЕДИНАЯ СЕТКА у всех карточек и у строки бонуса (числа — в CFG.missions):
 *
 *   [сложность ................ награда ◆ ↻]   ↻ — замена, пока она доступна
 *   [текст задания, до двух строк          ]
 *   [полоска прогресса на всю ширину       ]
 *   [                              12 / 30 ]   или «✓ Получено»
 *   [              ЗАБРАТЬ                ]   только у выполненного
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
    /** @type {{view:{w:number,h:number}, safe:{top:number,bottom:number}}|null} */
    this.deps = null;
    /** Готовая раскладка и то, по чему она собрана. */
    this.L = null;
    this.sig = { w: -1, h: -1, top: -1, bottom: -1, epoch: -1, state: -1, t0: '', t1: '', t2: '', p0: -1, p1: -1, p2: -1, done: -1 };
    /** Куда летят осколки при получении награды — счётчик в шапке, экранные px. */
    this.balanceAt = { x: 0, y: 0 };
    /** Баланс в шапке: строка и ширина пересобираются при изменении числа. */
    this.balance = { value: -1, text: '', w: 0, epoch: -1 };
    /** Всплывающее «+N» над нажатой кнопкой, локальные координаты панели. */
    this.popup = { t: 0, text: '', x: 0, y: 0 };
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
   * Состояние карточек одним числом: по два бита на задание (выполнено,
   * забрано), бонус и доступность замены. Сравнить число дешевле, чем
   * собирать строку-ключ в каждом кадре.
   * @returns {number}
   */
  stateBits() {
    const m = this.missions;
    let bits = 0;
    for (let i = 0; i < m.state.slots.length; i++) {
      const s = m.state.slots[i];
      bits |= (s.done ? 1 : 0) << (i * 2);
      bits |= (s.claimed ? 1 : 0) << (i * 2 + 1);
    }
    if (m.bonusReady()) bits |= 1 << 8;
    if (m.state.bonusClaimed) bits |= 1 << 9;
    if (this.rerollOpen()) bits |= 1 << 10;
    return bits;
  }

  /** Доступна ли замена хоть у одного задания — тогда колонка под ↻ есть у всех. */
  rerollOpen() {
    const m = this.missions;
    for (let i = 0; i < m.state.slots.length; i++) if (m.canReroll(i)) return true;
    return false;
  }

  /**
   * Раскладка панели. Единственный источник геометрии: и отрисовка, и тапы
   * берут прямоугольники отсюда. Пересобирается, только когда изменился
   * экран, шрифт, набор заданий или их состояние.
   */
  layout() {
    const { view, safe } = this.deps;
    const M = CFG.missions;
    const m = this.missions;
    const g = this.sig;
    const state = this.stateBits();
    const done = m.doneCount();
    if (this.L && g.w === view.w && g.h === view.h && g.top === safe.top && g.bottom === safe.bottom
        && g.epoch === ui.epoch && g.state === state && g.done === done
        && g.t0 === m.texts[0] && g.t1 === m.texts[1] && g.t2 === m.texts[2]
        && g.p0 === m.progress(0) && g.p1 === m.progress(1) && g.p2 === m.progress(2)) {
      return this.L;
    }
    g.w = view.w; g.h = view.h; g.top = safe.top; g.bottom = safe.bottom;
    g.epoch = ui.epoch; g.state = state; g.done = done;
    g.t0 = m.texts[0]; g.t1 = m.texts[1]; g.t2 = m.texts[2];
    g.p0 = m.progress(0); g.p1 = m.progress(1); g.p2 = m.progress(2);

    const w = Math.min(M.panelMaxWidth, view.w - M.panelSideMargin * 2);
    const inner = w - M.panelPadding * 2;
    const x0 = M.panelPadding;
    const left = x0 + M.rowPad;
    const right = x0 + inner - M.rowPad;
    const contentW = right - left;
    const lineH = ui.lineH('body');
    const reroll = this.rerollOpen();
    // Колонка под иконку замены — у всех карточек сразу или ни у одной.
    const rewardRight = right - (reroll ? M.rerollCol : 0);

    /** Собрать одну карточку сетки. */
    const makeRow = (y, lines, claim, canReroll, count, reward) => {
      const textH = lines.length * lineH;
      const headY = y + M.rowPad + M.headH / 2;
      const textY = y + M.rowPad + M.headH;
      const barY = textY + textH + (lines.length ? M.textGap : M.textGap / 2);
      const statusY = barY + M.barH + M.statusH / 2 + 2;
      let h = barY + M.barH + M.statusH + M.rowPad - y;
      let button = null;
      if (claim) {
        button = { x: left, y: barY + M.barH + M.statusH + M.claimGap, w: contentW, h: M.claimH };
        h += M.claimGap + M.claimH;
      }
      return {
        y, h, lines, headY, textY, barY, statusY, button, count, reward,
        // Зона нажатия замены — квадрат 44px вокруг иконки в правом верхнем углу.
        reroll: canReroll ? {
          x: right - M.rerollSize / 2 - M.rerollHit / 2,
          y: headY - M.rerollHit / 2, w: M.rerollHit, h: M.rerollHit,
        } : null,
        rerollX: right - M.rerollSize / 2,
      };
    };

    let y = M.panelPadding + M.titleH;
    const rows = [];
    for (let i = 0; i < MISSION_TIERS.length; i++) {
      const s = m.state.slots[i];
      const lines = ui.wrap(m.texts[i], 'body', contentW, M.textMaxLines);
      const row = makeRow(y, lines, s.done && !s.claimed, m.canReroll(i),
        `${m.progress(i)} / ${m.target(i)}`, `+${m.reward(i)}`);
      rows.push(row);
      y += row.h + M.rowGap;
    }
    const bonus = makeRow(y, [], m.bonusReady(), false,
      `${done} / ${m.state.slots.length}`, `+${M.allBonus}`);
    y += bonus.h;
    const timerY = y + M.timerH / 2;
    y += M.timerH;
    const close = { x: x0, y, w: inner, h: M.closeH };
    y += M.closeH + M.panelPadding;
    const h = y;

    // Не влезает по высоте — ужимаем целиком, но не мельче panelMinScale.
    const avail = view.h - safe.top - safe.bottom - M.panelScreenMargin * 2;
    const k = Math.max(M.panelMinScale, Math.min(1, avail / h));
    const ox = (view.w - w * k) / 2;
    const oy = safe.top + M.panelScreenMargin + Math.max(0, (avail - h * k) / 2);

    this.L = { w, h, k, ox, oy, inner, x0, left, right, contentW, rewardRight, lineH,
      rows, bonus, timerY, close, reroll };
    return this.L;
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
    // Тап мимо панели — то же самое, что «Закрыть».
    if (!inside || ui.hit(L.close, lx, ly)) return { kind: 'close' };

    const m = this.missions;
    for (let i = 0; i < L.rows.length; i++) {
      const row = L.rows[i];
      if (row.button && ui.hit(row.button, lx, ly)) {
        const amount = m.claim(i);
        if (amount > 0) return this.claimed('claim', amount, L, row.button);
        return { kind: 'none' };
      }
      if (row.reroll && ui.hit(row.reroll, lx, ly)) {
        return m.reroll(i) ? { kind: 'reroll' } : { kind: 'none' };
      }
    }
    if (L.bonus.button && ui.hit(L.bonus.button, lx, ly)) {
      const amount = m.claimBonus();
      if (amount > 0) return this.claimed('bonus', amount, L, L.bonus.button);
    }
    return { kind: 'none' };
  }

  /** Награда забрана: всплывающее «+N» и точка, откуда летят осколки. */
  claimed(kind, amount, L, b) {
    this.popup.t = CFG.shards.popupTime;
    this.popup.text = `+${amount}`;
    this.popup.x = b.x + b.w / 2;
    this.popup.y = b.y;
    return {
      kind, amount,
      x: L.ox + (b.x + b.w / 2) * L.k,
      y: L.oy + (b.y + b.h / 2) * L.k,
    };
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
    const ctx = ui.ctx;
    const M = CFG.missions;
    const TX = M.text;
    const m = this.missions;
    const L = this.layout();

    ctx.save();
    ctx.globalAlpha = this.fade;
    // Плотное затемнение и непрозрачная панель: кнопки меню сквозь неё
    // читаться не должны.
    ui.overlay(T);

    ctx.translate(L.ox, L.oy);
    ctx.scale(L.k, L.k);
    ui.panel(T, 0, 0, L.w, L.h);

    // Шапка: заголовок слева, баланс справа — туда же летят забранные осколки.
    const headCy = M.panelPadding + M.titleH / 2 - 2;
    ui.textMid(TX.title, L.x0 + 2, headCy, 'title', T.accent, 'left');
    const b = this.balance;
    if (b.value !== shards || b.epoch !== ui.epoch) {
      b.value = shards;
      b.epoch = ui.epoch;
      b.text = String(shards);
      b.w = ui.width(b.text, 'strong');
    }
    const balRight = L.x0 + L.inner - 2;
    ui.textMid(b.text, balRight, headCy, 'strong', T.accent, 'right');
    const iconX = balRight - b.w - 14;
    ui.shardIcon(iconX, headCy, 7, T);
    this.balanceAt.x = L.ox + iconX * L.k;
    this.balanceAt.y = L.oy + headCy * L.k;

    for (let i = 0; i < L.rows.length; i++) {
      const s = m.state.slots[i];
      this.drawRow(T, L, L.rows[i], TX.tiers[s.tier], false, s.done, s.claimed,
        m.progress(i) / m.target(i));
    }
    this.drawRow(T, L, L.bonus, TX.bonus, true, m.bonusReady() || m.state.bonusClaimed,
      m.state.bonusClaimed, m.doneCount() / m.state.slots.length);

    ui.textMid(m.timerString(Date.now()), L.w / 2, L.timerY, 'caption', T.dim);
    ui.button(T, L.close, TX.close, 'secondary');

    if (this.popup.t > 0) {
      const S = CFG.shards;
      const kk = 1 - this.popup.t / S.popupTime;
      const a = kk < S.popupFadeFrom ? 1 : 1 - (kk - S.popupFadeFrom) / (1 - S.popupFadeFrom);
      ctx.globalAlpha = this.fade * Math.max(0, a);
      ui.text(this.popup.text, this.popup.x, this.popup.y - 6 - kk * S.popupRise, 'strong', T.shard);
    }
    ctx.restore();
  }

  /**
   * Одна карточка сетки — задание или строка бонуса.
   * @param {string} head подпись верхней строки: сложность или «Все три задания»
   * @param {boolean} headStrong у бонуса верхняя строка — это и есть его название
   * @param {boolean} done выполнено @param {boolean} claimed награда забрана
   * @param {number} frac доля прогресса
   */
  drawRow(T, L, row, head, headStrong, done, claimed, frac) {
    const ctx = ui.ctx;
    const M = CFG.missions;
    const TX = M.text;

    ctx.save();
    // Забранное отходит на второй план: дело сделано.
    if (claimed) ctx.globalAlpha *= CFG.ui.dimmedAlpha;
    // Готовое к получению выделено золотой рамкой — взгляд должен падать сюда.
    const ready = done && !claimed;
    ui.card(T, L.x0, row.y, L.inner, row.h, ready ? T.gold : T.panelEdge, ready ? 1.5 : 1);

    if (headStrong) ui.textMid(head, L.left, row.headY, 'strong', T.accent, 'left');
    else ui.textMid(head, L.left, row.headY, 'caption', T.dim, 'left');
    ui.reward(row.reward, L.rewardRight, row.headY, T, 'right');
    if (row.reroll) ui.reroll(row.rerollX, row.headY, M.rerollSize, T.dim);

    const ascent = ui.size('body') * 0.82;
    for (let k = 0; k < row.lines.length; k++) {
      ui.text(row.lines[k], L.left, row.textY + ascent + k * L.lineH + 2, 'body', T.accent, 'left');
    }

    // Золото — выполненное; до тех пор полоска основного цвета.
    ui.bar(T, L.left, row.barY, L.contentW, M.barH, frac, done ? T.gold : T.accent);

    if (claimed) {
      const w = ui.width(TX.claimed, 'caption');
      ui.textMid(TX.claimed, L.right, row.statusY, 'caption', T.dim, 'right');
      ui.check(L.right - w - 12, row.statusY, 5, T.dim);
    } else {
      ui.textMid(row.count, L.right, row.statusY, 'label', done ? T.gold : T.dim, 'right');
    }
    if (row.button) ui.button(T, row.button, TX.claim, 'primary');
    ctx.restore();
  }
}
