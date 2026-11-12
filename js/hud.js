import { CFG, STREAK_LEVELS, streakLevelIndex, sectorOf, theme } from './config.js';
import { ui } from './ui.js';

/** Виды уведомлений слота, по убыванию приоритета. */
export const NOTE_RECORD = 'record';
export const NOTE_MISSION = 'mission';
export const NOTE_SECTOR = 'sector';

/**
 * HUD забега: верхняя полоса (осколки, счёт), подсказка о рекорде, пилюля
 * серии и ОДИН слот уведомлений. Схема и числа — в CFG.hud.
 *
 * Ничего не считает сам и ничего не опрашивает: игра сообщает о событиях
 * (сел, серия выросла, серия оборвалась, вошёл в сектор, побил рекорд), а
 * HUD по событию пересобирает свои строки. В кадре он только рисует готовое:
 * ни склейки строк, ни измерения ширины в отрисовке нет.
 */
export class Hud {
  /** @param {import('./missions.js').Missions} missions очередь выполненных заданий */
  constructor(missions) {
    this.missions = missions;
    /** @type {{view:{w:number,h:number}, safe:{top:number}}|null} */
    this.deps = null;
    /** Что сообщить игре, когда уведомление появилось (звук, вибрация). */
    this.onNote = null;

    this.scoreText = '0';
    this.shardsText = '0';
    /** «До рекорда N» либо пустая строка, когда показывать нечего. */
    this.hintText = '';
    /** Рекорд на начало забега: с ним сравниваем счёт. 0 — рекорда ещё нет. */
    this.best = 0;

    /**
     * Пилюля серии. text/w пересобираются при изменении серии; fade* — гаснущая
     * копия после обрыва (серия уже нулевая, а показать надо то, что было).
     */
    this.pill = { text: '', w: 0, level: 0, pulseT: 0, fadeT: 0, fadeText: '', fadeW: 0, fadeLevel: 0 };

    /** Текущее уведомление слота. kind === '' — слот пуст. */
    this.note = { kind: '', t: 0, title: '', sub: '', w: 0, gold: false };
    /**
     * Ожидающие уведомления. Задания ждут в кольце у Missions; здесь — только
     * флаг рекорда и номер сектора (-1 — нет). Больше одного сектора в очереди
     * не бывает: между ними 25 планет.
     */
    this.pending = { record: false, sector: -1 };

    /** Подложка-затемнение под верхней колонкой: градиент кэшируется. */
    this.scrim = { grad: null, color: '', top: -1 };
  }

  /** @param {NonNullable<Hud['deps']>} deps */
  attach(deps) {
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // События из игры
  // -------------------------------------------------------------------------

  /**
   * Новый забег: всё с нуля.
   * @param {number} best рекорд на начало забега
   * @param {number} shards баланс осколков
   */
  reset(best, shards) {
    this.best = best;
    this.scoreText = '0';
    this.hintText = '';
    this.setShards(shards);
    this.pill.level = 0;
    this.pill.pulseT = 0;
    this.pill.fadeT = 0;
    this.clearNotes();
  }

  /** Снять текущее уведомление и всё, что ждёт. */
  clearNotes() {
    this.note.kind = '';
    this.note.t = 0;
    this.pending.record = false;
    this.pending.sector = -1;
    while (this.missions.takeToast() >= 0) { /* опустошаем очередь */ }
  }

  /** @param {number} shards баланс осколков */
  setShards(shards) {
    this.shardsText = String(shards);
  }

  /**
   * Счёт изменился (посадка). Здесь же решается подсказка «До рекорда N».
   * @param {number} score видимый счёт
   * @param {number} perLanding сколько очков даёт обычная посадка текущим темпом
   * @param {boolean} beaten рекорд уже побит в этом забеге
   */
  setScore(score, perLanding, beaten) {
    this.scoreText = String(score);
    const H = CFG.hud;
    const left = this.best - score;
    // N — сколько очков нужно НАБРАТЬ, чтобы рекорд был побит: при равенстве
    // это единица, а не ноль, иначе подсказка врала бы «осталось 0».
    if (this.best > 0 && !beaten && left >= 0 && left <= H.recordNearLandings * perLanding) {
      this.hintText = H.text.recordHint.replace('{n}', String(left + 1));
    } else {
      this.hintText = '';
    }
  }

  /**
   * Серия выросла.
   * @param {number} streak длина серии
   */
  setStreak(streak) {
    const p = this.pill;
    const level = streakLevelIndex(streak);
    if (level > p.level && level > 0) p.pulseT = CFG.streak.pulseTime;
    p.level = level;
    p.fadeT = 0;
    if (level > 0) {
      // «x2 · 7»: множитель без лишнего нуля — в пилюле мало места.
      p.text = `x${STREAK_LEVELS[level].value} · ${streak}`;
      p.w = ui.width(p.text, 'label');
    }
  }

  /**
   * Серия оборвалась: пилюля не исчезает мгновенно, а гаснет — игрок должен
   * увидеть, что именно потерял.
   * @param {boolean} notice показывать ли затухание (обрыв с заметного уровня)
   */
  breakStreak(notice) {
    const p = this.pill;
    if (notice && p.level > 0) {
      p.fadeT = CFG.streak.breakFadeTime;
      p.fadeText = p.text;
      p.fadeW = p.w;
      p.fadeLevel = p.level;
    }
    p.level = 0;
    p.pulseT = 0;
  }

  /** Рекорд побит — уведомление встаёт в очередь первым. */
  queueRecord() {
    this.pending.record = true;
    this.hintText = '';
  }

  /** @param {number} index номер сектора с нуля */
  queueSector(index) {
    this.pending.sector = index;
  }

  // -------------------------------------------------------------------------
  // Время и очередь
  // -------------------------------------------------------------------------

  /**
   * Шаг по реальному времени: таймеры пилюли и слота, выбор следующего
   * уведомления. Одновременно показывается одно; приоритет при выборе —
   * рекорд, затем задание, затем сектор. Уже показанное не вытесняется:
   * перебивать надпись на полуслове хуже, чем подождать две секунды.
   *
   * @param {number} dtReal
   * @param {boolean} active идёт ли забег (вне забега очередь не разбирается)
   */
  update(dtReal, active) {
    const p = this.pill;
    if (p.pulseT > 0) p.pulseT = Math.max(0, p.pulseT - dtReal);
    if (p.fadeT > 0) p.fadeT = Math.max(0, p.fadeT - dtReal);

    const n = this.note;
    if (n.t > 0) {
      n.t = Math.max(0, n.t - dtReal);
      if (n.t <= 0) n.kind = '';
    }
    if (n.kind !== '' || !active) return;

    const H = CFG.hud;
    if (this.pending.record) {
      this.pending.record = false;
      this.show(NOTE_RECORD, H.text.recordNote, '', true);
      return;
    }
    const slot = this.missions.takeToast();
    if (slot >= 0) {
      this.show(NOTE_MISSION, CFG.missions.text.noteTitle, this.missions.texts[slot], true);
      return;
    }
    if (this.pending.sector >= 0) {
      const index = this.pending.sector;
      this.pending.sector = -1;
      this.show(NOTE_SECTOR, CFG.sector.text.note.replace('{n}', String(index + 1)),
        sectorOf(theme(), index).name, false);
    }
  }

  /**
   * Поставить уведомление в слот. Строки и ширина считаются здесь, один раз.
   * @param {string} kind @param {string} title @param {string} sub
   * @param {boolean} gold достижение — заголовок золотом
   */
  show(kind, title, sub, gold) {
    const H = CFG.hud;
    const n = this.note;
    const maxW = this.deps.view.w - H.slotSideMargin * 2;
    n.kind = kind;
    n.t = H.noteTime;
    n.title = title;
    // Вторая строка не переносится: слот фиксированной высоты. Не влезла —
    // обрезается многоточием (в стартовом пуле заданий такого нет).
    n.sub = sub ? ui.wrap(sub, 'caption', maxW - H.slotPadX * 2, 1)[0] : '';
    const inner = Math.max(ui.width(title, 'strong'), n.sub ? ui.width(n.sub, 'caption') : 0);
    n.w = Math.min(maxW, Math.max(H.slotMinW, inner + H.slotPadX * 2));
    n.gold = gold;
    if (this.onNote) this.onNote(kind);
  }

  // -------------------------------------------------------------------------
  // Отрисовка
  // -------------------------------------------------------------------------

  /**
   * @param {ReturnType<typeof theme>} T
   * @param {number} fade прозрачность экрана
   */
  draw(T, fade) {
    const { view, safe } = this.deps;
    const ctx = ui.ctx;
    const H = CFG.hud;
    const top = safe.top;
    const cx = view.w / 2;

    ctx.save();
    ctx.globalAlpha = fade;
    this.drawScrim(T, fade);

    // Осколки — слева, в одну линию с шестерёнкой.
    const iconR = CFG.shards.hudIconR;
    ui.shardIcon(H.sideMargin + iconR, top + H.rowY, iconR, T);
    ui.textMid(this.shardsText, H.sideMargin + iconR * 2 + CFG.shards.hudIconGap, top + H.rowY,
      'strong', T.accent, 'left');

    ui.text(this.scoreText, cx, top + H.scoreY, 'score', T.accent);
    if (this.hintText) ui.text(this.hintText, cx, top + H.hintY, 'caption', T.gold);

    this.drawPill(T, fade, cx, top + (this.hintText ? H.pillTopHint : H.pillTop));
    this.drawNote(T, fade, cx, top + H.slotTop);
    ctx.restore();
  }

  /** Затемнение под верхней колонкой: счёт обязан читаться поверх планет. */
  drawScrim(T, fade) {
    const { view, safe } = this.deps;
    const ctx = ui.ctx;
    const H = CFG.hud;
    const s = this.scrim;
    if (!s.grad || s.color !== T.scrim || s.top !== safe.top) {
      const n = parseInt(T.scrim.slice(1), 16);
      const rgb = `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
      const g = ctx.createLinearGradient(0, 0, 0, safe.top + H.scrimH);
      g.addColorStop(0, `rgba(${rgb},${H.scrimAlpha})`);
      g.addColorStop(0.45, `rgba(${rgb},${H.scrimAlpha * 0.6})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      s.grad = g;
      s.color = T.scrim;
      s.top = safe.top;
    }
    ctx.fillStyle = s.grad;
    ctx.fillRect(0, 0, view.w, safe.top + H.scrimH);
  }

  /** Пилюля серии «x2 · 7». Скрыта на x1; после обрыва гаснет. */
  drawPill(T, fade, cx, y) {
    const p = this.pill;
    const live = p.level > 0;
    if (!live && p.fadeT <= 0) return;
    const ctx = ui.ctx;
    const H = CFG.hud;
    const S = CFG.streak;

    const level = live ? p.level : p.fadeLevel;
    const text = live ? p.text : p.fadeText;
    const w = (live ? p.w : p.fadeW) + H.pillPadX * 2;
    const alpha = live ? 1 : p.fadeT / S.breakFadeTime;
    // Пульс: пик в самом начале — всплеск совпадает с событием, а не догоняет.
    const k = p.pulseT / S.pulseTime;
    const scale = 1 + S.pulseScale * k * k;
    const ramp = T.goldRamp;
    const color = ramp[Math.min(level - 1, ramp.length - 1)];

    ctx.save();
    ctx.globalAlpha = fade * alpha;
    // Масштаб от центра пилюли, иначе пульс уводил бы её вбок и вниз.
    ctx.translate(cx, y + H.pillH / 2);
    ctx.scale(scale, scale);
    ctx.fillStyle = T.panel;
    ui.roundRect(-w / 2, -H.pillH / 2, w, H.pillH, H.pillH / 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ui.textMid(text, 0, 0, 'label', color);
    ctx.restore();
  }

  /** Плашка уведомления в слоте. */
  drawNote(T, fade, cx, y) {
    const n = this.note;
    if (n.kind === '' || n.t <= 0) return;
    const ctx = ui.ctx;
    const H = CFG.hud;
    const age = H.noteTime - n.t;
    const k = Math.min(1, age / H.noteIn, n.t / H.noteOut);
    const top = y - (1 - Math.min(1, age / H.noteIn)) * H.noteSlide;

    ctx.save();
    ctx.globalAlpha = fade * k;
    ctx.fillStyle = T.panel;
    ui.roundRect(cx - n.w / 2, top, n.w, H.slotH, CFG.ui.cardCorner);
    ctx.fill();
    ctx.strokeStyle = n.gold ? T.gold : T.panelEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
    if (n.sub) {
      ui.textMid(n.title, cx, top + H.slotH * 0.32, 'strong', n.gold ? T.gold : T.accent);
      ui.textMid(n.sub, cx, top + H.slotH * 0.72, 'caption', T.dim);
    } else {
      ui.textMid(n.title, cx, top + H.slotH / 2, 'strong', n.gold ? T.gold : T.accent);
    }
    ctx.restore();
  }
}
