import {
  CFG, SKINS, SKIN_ORDER, THEMES, THEME_ORDER,
  theme, setTheme, setSkin,
} from './config.js';
import { Planet } from './planet.js';
import { Player } from './player.js';
import { loadShop, saveShop, loadShards, spendShards } from './storage.js';

/** Вкладки магазина. */
export const TAB_SKINS = 'skins';
export const TAB_THEMES = 'themes';
const TAB_ORDER = [TAB_SKINS, TAB_THEMES];

/**
 * Магазин: своя декоративная сцена, лента предметов, покупка и экипировка.
 *
 * Владение и экипировка живут в storage.js — здесь только состояние UI
 * (какая вкладка, какая карточка) и отрисовка. Баланс осколков никогда не
 * кэшируется: он читается из storage при каждом обращении, поэтому счётчик
 * в магазине и в HUD не могут разъехаться.
 */
export class Shop {
  constructor() {
    /** Декоративная планета-превью. @type {Planet|null} */
    this.planet = null;
    /** Космонавт на её орбите — живое превью выбранного скина. */
    this.player = new Player();
    this.player.decorative = true;

    this.tab = TAB_SKINS;
    /** Индекс выбранной карточки в каждой вкладке — переключение их не путает. */
    this.index = { [TAB_SKINS]: 0, [TAB_THEMES]: 0 };
    /** Остаток тряски кнопки при отказе покупки, с. */
    this.shakeT = 0;

    /** Что куплено и что экипировано. Единственная копия в памяти. */
    this.state = loadShop();

    /**
     * Внешние зависимости отрисовки (canvas, размеры, общие рисовальщики).
     * Инъекция вместо импорта из main.js: иначе получился бы цикл модулей.
     * @type {{ctx:CanvasRenderingContext2D, view:{w:number,h:number},
     *   safe:{top:number,bottom:number}, roundRect:Function, drawShardIcon:Function}|null}
     */
    this.deps = null;
  }

  /**
   * Подключить зависимости отрисовки. Вызывается один раз при старте.
   * @param {{ctx:CanvasRenderingContext2D, view:{w:number,h:number},
   *   safe:{top:number,bottom:number}, roundRect:Function, drawShardIcon:Function}} deps
   */
  attach(deps) {
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // Каталог
  // -------------------------------------------------------------------------

  /**
   * Предметы активной вкладки в порядке ленты.
   * @returns {{id:string, name:string, price:number, kind:string}[]}
   */
  items() {
    if (this.tab === TAB_THEMES) {
      return THEME_ORDER.map((id) => ({
        id, name: THEMES[id].name, price: CFG.shop.themePrices[id] ?? 0, kind: TAB_THEMES,
      }));
    }
    return SKIN_ORDER.map((id) => ({
      id, name: SKINS[id].name, price: SKINS[id].price, kind: TAB_SKINS,
    }));
  }

  /** Предмет под курсором ленты. */
  current() {
    const list = this.items();
    return list[Math.min(this.index[this.tab], list.length - 1)];
  }

  /** Список id, которыми игрок владеет на активной вкладке. */
  owned() {
    return this.tab === TAB_THEMES ? this.state.ownedThemes : this.state.ownedSkins;
  }

  /** id экипированного предмета активной вкладки. */
  activeId() {
    return this.tab === TAB_THEMES ? this.state.activeThemeId : this.state.activeSkinId;
  }

  /**
   * Состояние карточки — из него следует и вид кнопки, и реакция на тап.
   * @param {{id:string, price:number}} item
   * @returns {'equipped'|'owned'|'affordable'|'locked'}
   */
  statusOf(item) {
    if (this.activeId() === item.id) return 'equipped';
    if (this.owned().includes(item.id)) return 'owned';
    return loadShards() >= item.price ? 'affordable' : 'locked';
  }

  // -------------------------------------------------------------------------
  // Сцена и превью
  // -------------------------------------------------------------------------

  /**
   * Собрать сцену: планета-превью сбоку от планеты меню.
   * @param {{x:number,y:number}} menuPlanet планета главного меню — точка отсчёта
   * @param {{w:number,h:number}} view
   */
  buildScene(menuPlanet, view) {
    const S = CFG.shop;
    const x = menuPlanet.x + view.w * S.sceneOffsetX;
    const y = menuPlanet.y;

    if (!this.planet) {
      this.planet = new Planet({ x, y, r: S.planetRadius, omega: S.planetOmega });
      this.player.attach(this.planet, -Math.PI / 2);
    } else {
      this.planet.x = x;
      this.planet.y = y;
      this.player.syncOrbitPosition();
    }
    this.syncPreview();
  }

  /**
   * Точка обзора магазина: планета-превью в верхней трети кадра.
   * @param {{w:number,h:number}} view
   * @returns {{x:number,y:number}}
   */
  cameraPosition(view) {
    return {
      x: this.planet.x - view.w / 2,
      y: this.planet.y - view.h * CFG.shop.planetScreenY,
    };
  }

  /**
   * Привести превью к выбранной карточке.
   *
   * Скин применяется только к превью-космонавту (у него собственный skinId),
   * а тема — глобально: иначе «живого превью темы» не получится, весь экран
   * обязан перекраситься. Экипированная тема возвращается в restoreEquipped()
   * при выходе, поэтому просмотр некупленного ничего не меняет насовсем.
   */
  syncPreview() {
    const item = this.current();
    if (this.tab === TAB_THEMES) {
      setTheme(item.id);
      this.player.skinId = this.state.activeSkinId;
    } else {
      setTheme(this.state.activeThemeId);
      this.player.skinId = item.id;
    }
  }

  /** Вернуть глобальные тему и скин к экипированным. Вызывать при выходе. */
  restoreEquipped() {
    setTheme(this.state.activeThemeId);
    setSkin(this.state.activeSkinId);
  }

  /** Применить экипировку к глобальному состоянию игры. */
  applyEquipped() {
    setTheme(this.state.activeThemeId);
    setSkin(this.state.activeSkinId);
  }

  /**
   * Шаг анимации сцены.
   * @param {number} dt секунды
   */
  update(dt) {
    if (!this.planet) return;
    this.planet.update(dt);
    this.player.update(dt, []);
  }

  /**
   * Таймеры UI по реальному времени (тряска отказа).
   * @param {number} dtReal секунды
   */
  updateUi(dtReal) {
    if (this.shakeT > 0) this.shakeT = Math.max(0, this.shakeT - dtReal);
  }

  // -------------------------------------------------------------------------
  // Раскладка
  // -------------------------------------------------------------------------

  /**
   * Прямоугольники всех элементов. Единственный источник геометрии: и
   * отрисовка, и попадания тапа берут её отсюда и не могут разъехаться.
   * @returns {{tabs:{id:string,x:number,y:number,w:number,h:number}[],
   *   card:{x:number,y:number,w:number,h:number},
   *   prev:{x:number,y:number,w:number,h:number},
   *   next:{x:number,y:number,w:number,h:number},
   *   button:{x:number,y:number,w:number,h:number},
   *   back:{x:number,y:number,w:number,h:number}}}
   */
  layout() {
    const S = CFG.shop;
    const { view, safe } = this.deps;

    const tabsW = S.tabWidth * TAB_ORDER.length + S.tabGap * (TAB_ORDER.length - 1);
    const tabsX = (view.w - tabsW) / 2;
    const tabs = TAB_ORDER.map((id, i) => ({
      id,
      x: tabsX + i * (S.tabWidth + S.tabGap),
      y: safe.top + S.tabsY,
      w: S.tabWidth,
      h: S.tabHeight,
    }));

    const cardW = Math.min(S.cardWidth, view.w - (S.arrowSize + S.arrowGap) * 2 - 16);
    const cardX = (view.w - cardW) / 2;
    const cardY = view.h * S.cardY;
    const card = { x: cardX, y: cardY, w: cardW, h: S.cardHeight };

    const arrowY = cardY + (S.cardHeight - S.arrowSize) / 2;
    const prev = { x: cardX - S.arrowGap - S.arrowSize, y: arrowY, w: S.arrowSize, h: S.arrowSize };
    const next = { x: cardX + cardW + S.arrowGap, y: arrowY, w: S.arrowSize, h: S.arrowSize };

    const button = {
      x: cardX, y: cardY + S.cardHeight + S.buttonGap, w: cardW, h: S.buttonHeight,
    };

    const backW = Math.min(S.backWidth, view.w - 48);
    const back = {
      x: (view.w - backW) / 2, y: view.h * S.backY, w: backW, h: S.backHeight,
    };

    return { tabs, card, prev, next, button, back };
  }

  // -------------------------------------------------------------------------
  // Ввод
  // -------------------------------------------------------------------------

  /**
   * Разбор тапа по магазину.
   * @param {number} x @param {number} y
   * @returns {'back'|'handled'|'miss'} back — просьба улететь обратно в меню
   */
  handleTap(x, y) {
    const L = this.layout();
    const hit = (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

    if (hit(L.back)) return 'back';

    for (const t of L.tabs) {
      if (!hit(t)) continue;
      if (this.tab !== t.id) {
        this.tab = t.id;
        this.syncPreview(); // вкладка сменилась — превью обязано догнать сразу
      }
      return 'handled';
    }

    if (hit(L.prev)) { this.step(-1); return 'handled'; }
    if (hit(L.next)) { this.step(1); return 'handled'; }
    if (hit(L.button)) { this.activate(); return 'handled'; }

    return 'miss';
  }

  /**
   * Пролистать ленту. Некупленные предметы НЕ пропускаются: игрок должен
   * видеть, что ещё можно купить, а не упираться в невидимую стену.
   * @param {number} dir -1 или +1
   */
  step(dir) {
    const n = this.items().length;
    this.index[this.tab] = (this.index[this.tab] + dir + n) % n;
    this.syncPreview();
  }

  /**
   * Действие кнопки под карточкой — по состоянию предмета.
   * Купить -> списать и сразу экипировать; куплено -> экипировать;
   * не хватает -> тряска и ничего больше; экипировано -> кнопки нет.
   */
  activate() {
    const item = this.current();
    const status = this.statusOf(item);

    if (status === 'equipped') return;

    if (status === 'locked') {
      this.shakeT = CFG.shop.shakeTime;
      return;
    }

    if (status === 'affordable') {
      // Списание идёт через storage: там же и проверка достаточности, поэтому
      // рассинхрон кнопки и баланса не может привести к бесплатной покупке.
      if (spendShards(item.price) === null) {
        this.shakeT = CFG.shop.shakeTime;
        return;
      }
      this.owned().push(item.id);
    }

    this.equip(item.id);
  }

  /**
   * Экипировать предмет активной вкладки и сохранить выбор.
   * @param {string} id
   */
  equip(id) {
    if (this.tab === TAB_THEMES) this.state.activeThemeId = id;
    else this.state.activeSkinId = id;
    saveShop(this.state);
    this.applyEquipped();
    this.syncPreview();
  }

  // -------------------------------------------------------------------------
  // Отрисовка
  // -------------------------------------------------------------------------

  /**
   * Интерфейс магазина поверх сцены.
   * @param {number} fade прозрачность всего слоя, 0..1
   */
  draw(fade) {
    if (fade <= 0) return;
    const S = CFG.shop;
    const { ctx, view, safe, roundRect, drawShardIcon } = this.deps;
    const T = theme();
    const L = this.layout();
    const item = this.current();
    const status = this.statusOf(item);

    ctx.save();
    ctx.globalAlpha = fade;
    ctx.textAlign = 'center';

    ctx.fillStyle = T.accent;
    ctx.font = '700 22px system-ui, -apple-system, sans-serif';
    ctx.fillText('МАГАЗИН', view.w / 2, safe.top + S.titleY);

    for (const t of L.tabs) this.drawTab(t, T, roundRect, ctx);

    this.drawCard(L.card, item, status, T, roundRect, ctx);
    this.drawArrow(L.prev, -1, T, ctx);
    this.drawArrow(L.next, 1, T, ctx);
    this.drawActionButton(L.button, item, status, T, roundRect, ctx);

    // «Назад» — второстепенная кнопка, поэтому контурная, а не залитая.
    ctx.fillStyle = T.control;
    roundRect(L.back.x, L.back.y, L.back.w, L.back.h, S.buttonCorner);
    ctx.fill();
    ctx.strokeStyle = T.panelEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = T.accent;
    ctx.font = '600 15px system-ui, -apple-system, sans-serif';
    ctx.fillText('НАЗАД', L.back.x + L.back.w / 2, L.back.y + L.back.h / 2 + 5);

    ctx.restore();

    // Счётчик осколков — в том же углу и той же иконкой, что в игре.
    const C = CFG.shards;
    ctx.save();
    ctx.globalAlpha = fade;
    drawShardIcon(C.hudX + C.hudIconR, safe.top + C.hudY, C.hudIconR, T);
    ctx.textAlign = 'left';
    ctx.font = '600 15px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = T.accent;
    ctx.fillText(String(loadShards()), C.hudX + C.hudIconR * 2 + C.hudIconGap, safe.top + C.hudY + 5);
    ctx.restore();
  }

  /**
   * Вкладка. Активная залита акцентом.
   * @param {{id:string,x:number,y:number,w:number,h:number}} t
   */
  drawTab(t, T, roundRect, ctx) {
    const active = this.tab === t.id;
    ctx.fillStyle = active ? T.accent : T.control;
    roundRect(t.x, t.y, t.w, t.h, CFG.shop.tabCorner);
    ctx.fill();
    if (!active) {
      ctx.strokeStyle = T.panelEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.font = '600 14px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = active ? T.panel : T.accent;
    ctx.fillText(t.id === TAB_SKINS ? 'СКИНЫ' : 'ТЕМЫ', t.x + t.w / 2, t.y + t.h / 2 + 5);
  }

  /**
   * Карточка предмета: название, цена, положение в ленте.
   * Недоступный предмет притушен — видно, что он есть, но пока не по карману.
   */
  drawCard(r, item, status, T, roundRect, ctx) {
    const S = CFG.shop;
    const dim = status === 'locked';

    ctx.save();
    if (dim) ctx.globalAlpha *= S.cardDimAlpha;

    ctx.fillStyle = T.panel;
    roundRect(r.x, r.y, r.w, r.h, S.cardCorner);
    ctx.fill();
    ctx.strokeStyle = status === 'equipped' ? T.accent : T.panelEdge;
    ctx.lineWidth = status === 'equipped' ? 2 : 1;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = T.accent;
    ctx.font = '700 18px system-ui, -apple-system, sans-serif';
    ctx.fillText(item.name, r.x + r.w / 2, r.y + 34);

    // Цена: у бесплатного и у купленного её показывать незачем.
    ctx.font = '500 14px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = T.dim;
    const owned = status === 'owned' || status === 'equipped';
    ctx.fillText(owned ? 'Куплено' : `${item.price}`, r.x + r.w / 2, r.y + 60);

    // Точки-индикаторы позиции в ленте.
    const list = this.items();
    const dotGap = 14;
    const startX = r.x + r.w / 2 - ((list.length - 1) * dotGap) / 2;
    for (let i = 0; i < list.length; i++) {
      ctx.globalAlpha = ctx.globalAlpha * (i === this.index[this.tab] ? 1 : 0.35);
      ctx.fillStyle = T.accent;
      ctx.beginPath();
      ctx.arc(startX + i * dotGap, r.y + r.h - 22, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = ctx.globalAlpha / (i === this.index[this.tab] ? 1 : 0.35);
    }
    ctx.restore();
  }

  /**
   * Стрелка пролистывания.
   * @param {{x:number,y:number,w:number,h:number}} r
   * @param {number} dir -1 влево, +1 вправо
   */
  drawArrow(r, dir, T, ctx) {
    const S = CFG.shop;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    ctx.save();
    ctx.globalAlpha *= 0.8;
    ctx.fillStyle = T.accent;
    ctx.beginPath();
    ctx.moveTo(cx + dir * S.arrowGlyph * 0.6, cy - S.arrowGlyph);
    ctx.lineTo(cx + dir * S.arrowGlyph * 0.6, cy + S.arrowGlyph);
    ctx.lineTo(cx - dir * S.arrowGlyph * 0.7, cy);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * Кнопка действия. Четыре состояния предмета дают три вида кнопки плюс
   * индикатор «Экипировано» вовсе без кнопки.
   */
  drawActionButton(r, item, status, T, roundRect, ctx) {
    const S = CFG.shop;

    if (status === 'equipped') {
      // Не кнопка, а отметка: тапать нечего.
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = T.accent;
      ctx.font = '600 15px system-ui, -apple-system, sans-serif';
      ctx.fillText('✓ ЭКИПИРОВАНО', r.x + r.w / 2, r.y + r.h / 2 + 5);
      ctx.restore();
      return;
    }

    // Отказ покупки читается тряской — той же, что была у кнопки-заглушки.
    const dx = this.shakeT > 0
      ? Math.cos((S.shakeTime - this.shakeT) * S.shakeFreq) * S.shakeAmp * (this.shakeT / S.shakeTime)
      : 0;

    ctx.save();
    if (status === 'locked') ctx.globalAlpha *= S.cardDimAlpha;

    const primary = status !== 'locked';
    ctx.fillStyle = primary ? T.accent : T.control;
    roundRect(r.x + dx, r.y, r.w, r.h, S.buttonCorner);
    ctx.fill();
    ctx.strokeStyle = T.panelEdge;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.font = '700 15px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = primary ? T.panel : T.accent;
    const label = status === 'owned' ? 'ВЫБРАТЬ' : `КУПИТЬ ЗА ${item.price}`;
    ctx.fillText(label, r.x + dx + r.w / 2, r.y + r.h / 2 + 5);
    ctx.restore();
  }
}
