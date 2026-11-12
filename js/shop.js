import {
  CFG, SKINS, SKIN_ORDER, THEMES, THEME_ORDER,
  theme, setTheme, setSkin,
  MAX_MULTIPLIER_LEVEL, multiplierValue, multiplierUpgradeCost, formatMultiplier,
} from './config.js';
import { Planet } from './planet.js';
import { Player } from './player.js';
import { loadShop, saveShop, loadShards, spendShards } from './storage.js';
import { pluralize } from './util.js';
import { ui } from './ui.js';

/** Вкладки магазина. */
export const TAB_SKINS = 'skins';
export const TAB_THEMES = 'themes';
export const TAB_UPGRADES = 'upgrades';
const TAB_ORDER = [TAB_SKINS, TAB_THEMES, TAB_UPGRADES];

/** Единственный предмет вкладки улучшений. */
const UPGRADE_MULTIPLIER = 'multiplier';

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

    this.tab = TAB_SKINS;
    /** Индекс выбранной карточки в каждой вкладке — переключение их не путает. */
    this.index = { [TAB_SKINS]: 0, [TAB_THEMES]: 0, [TAB_UPGRADES]: 0 };
    /** Остаток тряски кнопки при отказе покупки, с. */
    this.shakeT = 0;

    /** Что куплено и что экипировано. Единственная копия в памяти. */
    this.state = loadShop();

    /**
     * Размеры экрана и безопасная зона. Рисование идёт через общий ui.
     * @type {{view:{w:number,h:number}, safe:{top:number,bottom:number}}|null}
     */
    this.deps = null;
    /**
     * Готовые строки интерфейса и значения, по которым они собраны: надпись
     * на кнопке и строка карточки пересобираются, только когда сменился
     * предмет, его состояние или баланс, а не в каждом кадре.
     */
    this.cache = { tab: '', id: '', status: '', price: -1, balance: -1, level: -1,
      button: '', line: '', balanceText: '' };
  }

  /**
   * Подключить размеры экрана. Вызывается один раз при старте.
   * @param {NonNullable<Shop['deps']>} deps
   */
  attach(deps) {
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // Каталог
  // -------------------------------------------------------------------------

  /**
   * Предметы активной вкладки в порядке ленты.
   *
   * У улучшений предмет один, и его цена зависит от уже купленного уровня:
   * это не витрина из независимых товаров, а одна лестница, следующая ступень
   * которой и продаётся.
   *
   * @returns {{id:string, name:string, price:number, kind:string}[]}
   */
  items() {
    if (this.tab === TAB_UPGRADES) {
      const cost = multiplierUpgradeCost(this.state.multiplierLevel);
      return [{
        id: UPGRADE_MULTIPLIER,
        name: CFG.shop.text.upgradeName,
        price: cost ?? 0, // на максимуме покупать нечего, цена не показывается
        kind: TAB_UPGRADES,
      }];
    }
    if (this.tab === TAB_THEMES) {
      return THEME_ORDER.map((id) => ({
        id, name: THEMES[id].name, price: CFG.shop.themePrices[id] ?? 0, kind: TAB_THEMES,
      }));
    }
    return SKIN_ORDER.map((id) => ({
      id, name: SKINS[id].name, price: SKINS[id].price, kind: TAB_SKINS,
    }));
  }

  /** Текущий множитель очков — то, что уже действует в забегах. */
  multiplier() {
    return multiplierValue(this.state.multiplierLevel);
  }

  /** Достигнут ли потолок прокачки. */
  atMaxLevel() {
    return this.state.multiplierLevel >= MAX_MULTIPLIER_LEVEL;
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
   *
   * У улучшения нет ни «куплено», ни «экипировано»: уровень действует сразу и
   * навсегда, выбирать между уровнями нечего. Его конечное состояние — 'max',
   * визуально такое же нерабочее, как 'equipped' у остальных.
   *
   * @param {{id:string, price:number}} item
   * @returns {'equipped'|'owned'|'affordable'|'locked'|'max'}
   */
  statusOf(item) {
    if (item.kind === TAB_UPGRADES) {
      if (this.atMaxLevel()) return 'max';
      return loadShards() >= item.price ? 'affordable' : 'locked';
    }
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

    // Радиус превью зависит от высоты экрана (см. layout): на низких экранах
    // планета ужимается, чтобы колонка влезла без наложений.
    const r = this.deps ? this.layout().planetR : S.planetRadius;
    if (!this.planet) {
      this.planet = new Planet({ x, y, r, omega: S.planetOmega });
      this.player.attach(this.planet, -Math.PI / 2);
    } else {
      this.planet.x = x;
      this.planet.y = y;
      this.planet.r = r;
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
      y: this.planet.y - this.layout().planetCy,
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
    if (this.tab === TAB_UPGRADES) {
      // Улучшению нечего примерять: показываем ровно то, что экипировано, а
      // само значение множителя рисуется цифрой рядом с планетой.
      setTheme(this.state.activeThemeId);
      this.player.skinId = this.state.activeSkinId;
      return;
    }
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
   *
   * Одна колонка: вкладки -> планета-превью -> карточка -> точки -> кнопка;
   * «Назад» прижата к низу. Положение планеты и верх карточки считаются по
   * САМОЙ ВЫСОКОЙ карточке из трёх вкладок, поэтому при переключении вкладок
   * ничего не прыгает: меняется только высота карточки и место кнопки под ней.
   */
  layout() {
    const S = CFG.shop;
    const { view, safe } = this.deps;

    // Ширина вкладки ужимается под экран: три вкладки по S.tabWidth не влезают
    // ни в один телефон уже, чем ~410px.
    const n = TAB_ORDER.length;
    const avail = view.w - S.tabSideMargin * 2 - S.tabGap * (n - 1);
    const tabW = Math.min(S.tabWidth, avail / n);
    const tabsW = tabW * n + S.tabGap * (n - 1);
    const tabsX = (view.w - tabsW) / 2;
    const tabs = TAB_ORDER.map((id, i) => ({
      id,
      x: tabsX + i * (tabW + S.tabGap),
      y: safe.top + S.tabsY,
      w: tabW,
      h: S.tabHeight,
    }));
    const tabsBottom = safe.top + S.tabsY + S.tabHeight;

    const backW = Math.min(S.backWidth, view.w - 48);
    const back = {
      x: (view.w - backW) / 2, y: view.h - safe.bottom - S.backBottom - S.backHeight,
      w: backW, h: S.backHeight,
    };

    const tallest = Math.max(S.cardHeight.skins, S.cardHeight.themes, S.cardHeight.upgrades);
    const blockH = tallest + S.buttonGap + S.buttonHeight;
    // Что остаётся планете после карточки, кнопки и трёх минимальных зазоров.
    const room = back.y - tabsBottom - blockH - S.gapMin * 3;
    const planetR = Math.min(S.planetRadius, Math.max(S.planetMinRadius, room / 2 - S.orbitPad));
    const orbitR = planetR + S.orbitPad;
    // Лишняя высота делится между зазорами по долям, а не копится в одном.
    const spare = Math.max(0, room - orbitR * 2);
    const planetCy = tabsBottom + S.gapMin + spare * S.spareTop + orbitR;

    const cardW = Math.min(S.cardWidth, view.w - (S.arrowSize + S.arrowGap) * 2 - 12);
    const cardX = (view.w - cardW) / 2;
    const cardY = planetCy + orbitR + S.gapMin + spare * S.spareMid;
    const cardH = S.cardHeight[this.tab];
    const card = { x: cardX, y: cardY, w: cardW, h: cardH };

    const arrowY = cardY + (cardH - S.arrowSize) / 2;
    const prev = { x: cardX - S.arrowGap - S.arrowSize, y: arrowY, w: S.arrowSize, h: S.arrowSize };
    const next = { x: cardX + cardW + S.arrowGap, y: arrowY, w: S.arrowSize, h: S.arrowSize };

    const button = { x: cardX, y: cardY + cardH + S.buttonGap, w: cardW, h: S.buttonHeight };

    // Ленты из одного предмета нет: стрелки и точки-индикаторы на вкладке
    // улучшений только обманывали бы — листать некуда.
    const showArrows = this.items().length > 1;

    return { tabs, card, prev, next, button, back, showArrows, planetR, planetCy,
      dotsY: cardY + cardH + S.dotsGap };
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

    if (L.showArrows && hit(L.prev)) { this.step(-1); return 'handled'; }
    if (L.showArrows && hit(L.next)) { this.step(1); return 'handled'; }
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

    if (status === 'equipped' || status === 'max') return;

    if (status === 'locked') {
      this.shakeT = CFG.shop.shakeTime;
      return;
    }

    // Списание идёт через storage: там же и проверка достаточности, поэтому
    // рассинхрон кнопки и баланса не может привести к бесплатной покупке.
    // Один и тот же путь для скинов, тем и улучшений — расходятся они только
    // в том, что записывают ПОСЛЕ успешного списания.
    if (status === 'affordable' && spendShards(item.price) === null) {
      this.shakeT = CFG.shop.shakeTime;
      return;
    }

    if (item.kind === TAB_UPGRADES) {
      // Уровень растёт ровно на один: цена, которую мы только что списали, —
      // это цена следующей ступени, и перепрыгнуть через неё нельзя.
      this.state.multiplierLevel++;
      saveShop(this.state);
      return;
    }

    if (status === 'affordable') this.owned().push(item.id);
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
   * Пересобрать надпись кнопки и строку карточки, если что-то изменилось.
   * @param {{id:string, price:number, kind:string}} item
   * @param {string} status
   * @param {number} balance
   */
  refreshTexts(item, status, balance) {
    const c = this.cache;
    const level = this.state.multiplierLevel;
    if (c.tab === this.tab && c.id === item.id && c.status === status && c.price === item.price
        && c.balance === balance && c.level === level) return;
    c.tab = this.tab; c.id = item.id; c.status = status; c.price = item.price;
    c.balance = balance; c.level = level;
    c.balanceText = String(balance);

    const TX = CFG.shop.text;
    const upgrade = item.kind === TAB_UPGRADES;
    if (status === 'locked') {
      // Не хватает — кнопка неактивна и говорит, СКОЛЬКО не хватает: «купить
      // за 150» при балансе 137 заставляло считать в уме.
      c.button = TX.short.replace('{n}', String(item.price - balance));
    } else if (status === 'max') c.button = TX.max;
    else if (status === 'equipped') c.button = TX.equipped[this.tab];
    else if (status === 'owned') c.button = TX.equip[this.tab];
    else c.button = (upgrade ? TX.upgrade : TX.buy).replace('{n}', String(item.price));

    if (upgrade) {
      const now = formatMultiplier(this.multiplier());
      c.line = this.atMaxLevel()
        ? `x${now}`
        : `x${now} → x${formatMultiplier(multiplierValue(level + 1))}`;
    } else {
      const owned = status === 'owned' || status === 'equipped';
      c.line = owned ? TX.owned : String(item.price);
    }
  }

  /**
   * Интерфейс магазина поверх сцены.
   * @param {number} fade прозрачность всего слоя, 0..1
   */
  draw(fade) {
    if (fade <= 0) return;
    const S = CFG.shop;
    const TX = S.text;
    const { view, safe } = this.deps;
    const ctx = ui.ctx;
    const T = theme();
    const L = this.layout();
    const item = this.current();
    const status = this.statusOf(item);
    const balance = loadShards();
    this.refreshTexts(item, status, balance);

    ctx.save();
    ctx.globalAlpha = fade;

    ui.text(TX.title, view.w / 2, safe.top + S.titleY, 'title', T.accent);

    // Счётчик осколков — в том же углу и той же иконкой, что в игре.
    const H = CFG.hud;
    const iconR = CFG.shards.hudIconR;
    ui.shardIcon(H.sideMargin + iconR, safe.top + H.rowY, iconR, T);
    ui.textMid(this.cache.balanceText, H.sideMargin + iconR * 2 + CFG.shards.hudIconGap,
      safe.top + H.rowY, 'strong', T.accent, 'left');

    // Вкладки — те же кнопки: активная залита, остальные контурные.
    for (const t of L.tabs) {
      ui.button(T, t, TX.tabs[t.id], this.tab === t.id ? 'primary' : 'secondary', TAB_OPTS);
    }

    this.drawCard(L.card, item, status, T);
    if (L.showArrows) {
      this.drawArrow(L.prev, -1, T);
      this.drawArrow(L.next, 1, T);
      this.drawDots(L, T);
    }
    this.drawActionButton(L.button, item, status, T);

    ui.button(T, L.back, TX.back, 'secondary');
    ctx.restore();
  }

  /**
   * Карточка предмета: название и ОДНА строка под ним — цена с кристаллом
   * либо «Куплено». Тема добавляет полоску своих секторов, улучшение — шкалу
   * уровней. Всё, что про действие, — на кнопке под карточкой.
   */
  drawCard(r, item, status, T) {
    const S = CFG.shop;
    const ctx = ui.ctx;
    const cx = r.x + r.w / 2;
    const c = this.cache;

    ctx.save();
    ctx.fillStyle = T.panel;
    ui.roundRect(r.x, r.y, r.w, r.h, CFG.ui.cardCorner);
    ctx.fill();
    // Рамкой акцента отмечено «дальше некуда»: для предмета это экипировка,
    // для улучшения — максимальный уровень.
    const marked = status === 'equipped' || status === 'max';
    ctx.strokeStyle = marked ? T.accent : T.panelEdge;
    ctx.lineWidth = marked ? 2 : 1;
    ctx.stroke();

    ui.text(item.name, cx, r.y + S.cardNameY, 'strong', T.accent);

    if (item.kind === TAB_UPGRADES) {
      // Переход показывается целиком: игрок должен видеть, что именно покупает.
      ui.text(c.line, cx, r.y + S.cardLineY, 'strong', T.gold);
      this.drawLevels(r, T);
    } else if (status === 'owned' || status === 'equipped') {
      ui.text(c.line, cx, r.y + S.cardLineY, 'caption', T.dim);
    } else {
      // Цена: число и кристалл одной группой по центру.
      const w = ui.width(c.line, 'label');
      const iconW = S.priceIconR * 1.4 + 7;
      const left = cx - (w + iconW) / 2;
      ui.text(c.line, left, r.y + S.cardLineY, 'label', T.accent, 'left');
      ui.shardIcon(left + w + 7 + S.priceIconR * 0.7, r.y + S.cardLineY - 5, S.priceIconR, T);
    }

    if (item.kind === TAB_THEMES) this.drawSectorSwatches(r, THEMES[item.id], T);
    ctx.restore();
  }

  /**
   * Шкала уровней прокачки: по делению на уровень, купленные закрашены.
   * Заменяет подпись «Уровень 2 из 7»: то же самое видно без чтения.
   */
  drawLevels(r, T) {
    const S = CFG.shop;
    const ctx = ui.ctx;
    const n = MAX_MULTIPLIER_LEVEL;
    const inner = r.w - 32;
    const w = (inner - S.levelGap * (n - 1)) / n;
    const y = r.y + S.cardLevelsY;
    for (let i = 0; i < n; i++) {
      const x = r.x + 16 + i * (w + S.levelGap);
      ctx.fillStyle = i < this.state.multiplierLevel ? T.gold : T.panelEdge;
      ui.roundRect(x, y, w, S.levelH, S.levelH / 2);
      ctx.fill();
    }
  }

  /**
   * Превью секторов темы: полоска плашек и подпись «4 сектора».
   *
   * Тема продаётся не одной палитрой, а набором миров, и карточка обязана это
   * показать: иначе игрок видит в превью только первый сектор и не знает, что
   * покупает ещё три. Плашка — уменьшенный сектор: его градиент фона и точка
   * цвета первой планеты.
   *
   * @param {{x:number,y:number,w:number,h:number}} r карточка
   * @param {typeof THEMES.space} itemTheme тема ПРЕДМЕТА (не обязательно активная)
   */
  drawSectorSwatches(r, itemTheme, T) {
    const S = CFG.sector;
    const ctx = ui.ctx;
    const sectors = itemTheme.sectors;
    const caption = this.swatchCaption(sectors.length);
    const captionW = ui.width(caption, 'caption');
    const stripW = sectors.length * S.swatchW + (sectors.length - 1) * S.swatchGap;
    let x = r.x + (r.w - (stripW + S.swatchCaptionGap + captionW)) / 2;
    const cy = r.y + CFG.shop.cardSwatchY;
    const top = cy - S.swatchH / 2;

    for (const sec of sectors) {
      const g = ctx.createLinearGradient(0, top, 0, top + S.swatchH);
      g.addColorStop(0, sec.bg);
      g.addColorStop(1, sec.bgGlow);
      ctx.fillStyle = g;
      ui.roundRect(x, top, S.swatchW, S.swatchH, S.swatchCorner);
      ctx.fill();
      // Рамка обязательна: фон сектора почти такой же тёмный, как карточка.
      ctx.strokeStyle = T.panelEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = sec.planetPalette[0][0];
      ctx.beginPath();
      ctx.arc(x + S.swatchW / 2, cy, S.swatchDot, 0, Math.PI * 2);
      ctx.fill();
      x += S.swatchW + S.swatchGap;
    }
    ui.textMid(caption, x - S.swatchGap + S.swatchCaptionGap, cy, 'caption', T.dim, 'left');
  }

  /** Подпись «4 сектора» — собирается один раз на число секторов. */
  swatchCaption(n) {
    if (this.captionFor !== n) {
      this.captionFor = n;
      this.captionText = pluralize(CFG.sector.text.shop.replace('{n}', String(n)), n);
    }
    return this.captionText;
  }

  /**
   * Точки-индикатор страниц — под карточкой: внутри неё они спорили с ценой
   * и читались как часть предмета.
   */
  drawDots(L, T) {
    const S = CFG.shop;
    const ctx = ui.ctx;
    const n = this.items().length;
    const cx = L.card.x + L.card.w / 2;
    const startX = cx - ((n - 1) * S.dotStep) / 2;
    ctx.save();
    ctx.fillStyle = T.accent;
    const base = ctx.globalAlpha;
    for (let i = 0; i < n; i++) {
      ctx.globalAlpha = base * (i === this.index[this.tab] ? 1 : 0.35);
      ctx.beginPath();
      ctx.arc(startX + i * S.dotStep, L.dotsY, S.dotR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Стрелка пролистывания: остриё смотрит туда, куда листает. Слева ◀,
   * справа ▶ (раньше были перепутаны — основание и остриё стояли наоборот).
   * @param {{x:number,y:number,w:number,h:number}} r
   * @param {number} dir -1 влево, +1 вправо
   */
  drawArrow(r, dir, T) {
    const S = CFG.shop;
    const ctx = ui.ctx;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    ctx.save();
    ctx.globalAlpha *= 0.8;
    ctx.fillStyle = T.accent;
    ctx.beginPath();
    ctx.moveTo(cx - dir * S.arrowGlyph * 0.6, cy - S.arrowGlyph);
    ctx.lineTo(cx - dir * S.arrowGlyph * 0.6, cy + S.arrowGlyph);
    ctx.lineTo(cx + dir * S.arrowGlyph * 0.7, cy);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * Кнопка действия — ОДНА на все состояния предмета:
   *   не куплено, хватает     -> «КУПИТЬ ЗА 80 ◆»
   *   не куплено, не хватает  -> неактивная «НЕ ХВАТАЕТ 13 ◆»
   *   куплено                 -> «НАДЕТЬ» / «ВЫБРАТЬ»
   *   уже надето              -> неактивная «✓ НАДЕТО» / «✓ ВЫБРАНО»
   * У улучшения — «УЛУЧШИТЬ ЗА 40 ◆» и неактивная «✓ МАКСИМУМ».
   */
  drawActionButton(r, item, status, T) {
    const S = CFG.shop;
    // Отказ покупки читается тряской — той же, что была у кнопки-заглушки.
    const o = BUTTON_OPTS;
    o.dx = this.shakeT > 0
      ? Math.cos((S.shakeTime - this.shakeT) * S.shakeFreq) * S.shakeAmp * (this.shakeT / S.shakeTime)
      : 0;
    const final = status === 'equipped' || status === 'max';
    o.check = final;
    // Кристалл — там, где на кнопке стоит сумма.
    o.shard = status === 'affordable' || status === 'locked';
    const kind = final || status === 'locked' ? 'disabled' : 'primary';
    ui.button(T, r, this.cache.button, kind, o);
  }
}

/** Параметры кнопок — по одному объекту на игру, а не на кадр. */
const TAB_OPTS = { role: 'label' };
const BUTTON_OPTS = { dx: 0, check: false, shard: false };
