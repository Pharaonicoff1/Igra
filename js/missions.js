import {
  CFG, TRAP, MISSION_TIERS, MISSION_MODE, MISSION_TYPES, missionType, missionTarget,
  STREAK_LEVELS, formatMultiplier,
} from './config.js';
import { loadMissions, saveMissions, addShards, MISSIONS_SCHEMA } from './storage.js';

/**
 * Ключ дня по ЛОКАЛЬНЫМ часам устройства: ГГГГММДД числом. Число, а не строка,
 * — даты сравниваются на «больше/меньше», и для чисел это честное сравнение.
 * @param {Date} [date]
 * @returns {number}
 */
export function localDayKey(date = new Date()) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/**
 * Момент ближайшей локальной полуночи, мс. setHours сам учитывает переход на
 * летнее время: «полночь» здесь — та же, что покажут часы на телефоне.
 * @param {number} nowMs
 * @returns {number}
 */
function nextMidnightMs(nowMs) {
  const d = new Date(nowMs);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Детерминированный генератор (mulberry32). Тот же seed — та же
 * последовательность на любом устройстве: набор дня обязан восстанавливаться
 * по одной только дате, даже если хранилище потерялось.
 * @param {number} seed
 * @returns {() => number} [0, 1)
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Смешать несколько целых в один seed. Нужен для замены: она обязана давать
 * другую последовательность, чем исходный набор того же дня.
 * @param {...number} parts
 * @returns {number}
 */
function mixSeed(...parts) {
  let h = 2166136261;
  for (const p of parts) {
    h = Math.imul(h ^ (p | 0), 16777619);
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  }
  return h >>> 0;
}

/**
 * Русская форма слова по числу: 1 планету, 2 планеты, 5 планет, 21 планету.
 * @param {number} n
 * @param {string[]} forms [для 1, для 2-4, для 5+]
 * @returns {string}
 */
export function pluralRu(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}

/**
 * Текст задания по шаблону из MISSION_TYPES.
 * @param {string} typeId
 * @param {string} tier
 * @returns {string}
 */
export function formatMissionText(typeId, tier) {
  const type = missionType(typeId);
  if (!type) return '';
  const n = missionTarget(typeId, tier);
  const raw = type.targets[tier];
  return type.text
    .replace('{n}', String(n))
    .replace('{x}', () => {
      const step = STREAK_LEVELS[Math.min(Math.max(raw, 1), STREAK_LEVELS.length - 1)];
      return formatMultiplier(step.value);
    })
    .replace(/\{([^{}|]+)\|([^{}|]+)\|([^{}|]+)\}/g, (_, a, b, c) => pluralRu(n, [a, b, c]));
}

/**
 * Типы, которые можно выдать на данной сложности, не повторив занятые семьи.
 * @param {string} tier
 * @param {Set<string>} usedFamilies
 * @returns {typeof MISSION_TYPES}
 */
function eligibleTypes(tier, usedFamilies) {
  return MISSION_TYPES.filter((t) => tier in t.targets && !usedFamilies.has(t.family));
}

/**
 * Выбрать тип из пула: сначала РАВНОВЕРОЯТНО семью, затем тип внутри неё.
 * Выбор сразу по типам перекашивал бы набор к большим семьям: у «планет» три
 * типа, и на лёгкой сложности они выпадали в 37% дней против ~13% у прочих.
 * @param {typeof MISSION_TYPES} pool
 * @param {() => number} rng
 * @returns {typeof MISSION_TYPES[number]}
 */
function pickType(pool, rng) {
  const families = [];
  for (const t of pool) if (!families.includes(t.family)) families.push(t.family);
  const family = families[Math.floor(rng() * families.length)];
  const inFamily = pool.filter((t) => t.family === family);
  return inFamily[Math.floor(rng() * inFamily.length)];
}

/**
 * Набор заданий дня. Только от даты и таблицы MISSION_TYPES: перезагрузка
 * страницы в тот же день — тот же набор, с хранилищем или без.
 *
 * Сложности разбираются по порядку easy -> medium -> hard. Лёгкая идёт первой,
 * потому что у неё самый узкий пул (нет лавы и лозы): заняв семью позже, она
 * могла бы остаться без кандидатов. Средней и трудной хватает в любом случае:
 * у них по шесть семей, занято не больше двух.
 *
 * @param {number} day ГГГГММДД
 * @returns {import('./storage.js').MissionSlot[]}
 */
export function generateDay(day) {
  const rng = mulberry32(mixSeed(day));
  const used = new Set();
  const slots = [];
  for (const tier of MISSION_TIERS) {
    const type = pickType(eligibleTypes(tier, used), rng);
    used.add(type.family);
    slots.push({ type: type.id, tier, progress: 0, done: false, claimed: false });
  }
  return slots;
}

/**
 * Замена задания в слоте: другой тип той же сложности, из семьи, которой ещё
 * нет в наборе. Своя семья исключается тоже — «пройдите 60 планет» вместо
 * «пройдите 30 планет за забег» заменой не ощущается. Если так никого не
 * осталось, допускаем свою семью, но не тот же тип.
 * @param {number} day
 * @param {import('./storage.js').MissionSlot[]} slots
 * @param {number} index
 * @param {number} nth который это по счёту перебор за день — для seed
 * @returns {string|null} id нового типа
 */
export function rerollPick(day, slots, index, nth) {
  const tier = slots[index].tier;
  const own = missionType(slots[index].type);
  const used = new Set();
  for (let i = 0; i < slots.length; i++) used.add(missionType(slots[i].type).family);
  let pool = eligibleTypes(tier, used);
  if (pool.length === 0) {
    used.delete(own.family);
    pool = eligibleTypes(tier, used).filter((t) => t.id !== own.id);
  }
  if (pool.length === 0) return null;
  const rng = mulberry32(mixSeed(day, index + 1, nth + 1, 7919));
  return pickType(pool, rng).id;
}

/**
 * Ежедневные задания: состояние дня, приём событий из игры, награды.
 *
 * Ничего не опрашивает сам: прогресс приносят события из существующих мест
 * игры (посадка, астероид, серия, воскрешение, конец забега). Хранилище
 * обновляется на каждом изменении — выполненное не теряется от закрытой вкладки.
 *
 * Прогресс «за один забег» живёт в памяти (runValue), а не в хранилище:
 * перезагрузка страницы и так заканчивает забег.
 */
export class Missions {
  constructor() {
    /** Подменная дата для тестов (ГГГГММДД) или null — живые часы. */
    this.dayOverride = null;
    /** @type {import('./storage.js').MissionsState|null} */
    this.state = null;
    /** Когда наступит следующий день, мс. Infinity при подменной дате. */
    this.nextDayAt = 0;
    /** Готовые тексты слотов: собираются при смене набора, не в отрисовке. */
    this.texts = ['', '', ''];
    /** Прогресс «за забег» по слотам. */
    this.runValue = [0, 0, 0];
    /** Прогресс накопительных на старте забега — для «было -> стало». */
    this.before = [0, 0, 0];
    /** Выполнено ли задание именно в этом забеге. */
    this.doneThisRun = [false, false, false];
    /** Идёт ли забег: на смену дня посреди забега набор не переключаем. */
    this.runActive = false;
    /** Было ли воскрешение в этом забеге — замораживает noRevive. */
    this.runRevived = false;
    /**
     * Очередь тостов «выполнено»: индексы слотов в кольце фиксированного
     * размера. Без массивов на событие — пополняется прямо из посадки.
     */
    this.toastRing = new Int8Array(CFG.missions.toastQueue);
    this.toastHead = 0;
    this.toastCount = 0;
    /**
     * Сводка последнего забега для экрана поражения: строки собраны один раз
     * в конце забега. @type {{text:string, value:string, done:boolean}[]}
     */
    this.lastRun = [];
    /** Кэш таймера: строка пересобирается раз в минуту, а не каждый кадр. */
    this.timerMinutes = -1;
    this.timerText = '';

    this.ensureDay();
  }

  // -------------------------------------------------------------------------
  // День
  // -------------------------------------------------------------------------

  /** @returns {number} сегодняшний ключ ГГГГММДД */
  today() {
    return this.dayOverride !== null ? this.dayOverride : localDayKey();
  }

  /**
   * Привести набор к сегодняшнему дню.
   *
   * Новый день — новый набор; невыполненное и НЕЗАБРАННОЕ вчерашнее сгорает:
   * задания — повод зайти сегодня, а копилка наград за пропущенные дни
   * превратила бы их в обязанность «зайти хоть раз в неделю и собрать».
   *
   * Дата назад (часы переведены) выданный набор НЕ откатывает: иначе игрок
   * получал бы новый набор на каждом переводе туда-обратно.
   */
  ensureDay() {
    const key = this.today();
    if (!this.state) this.state = loadMissions();
    if (!this.state || this.state.day < key) {
      this.state = {
        v: MISSIONS_SCHEMA, day: key, rerollsUsed: 0, bonusClaimed: false,
        slots: generateDay(key),
      };
      this.resetRun();
      saveMissions(this.state);
    }
    this.refreshTexts();
    this.nextDayAt = this.dayOverride !== null ? Infinity : nextMidnightMs(Date.now());
    this.timerMinutes = -1;
  }

  /**
   * Наступила ли полночь. Дёшево: одно сравнение чисел, без Date на кадр.
   * Посреди забега набор не меняется — он доигрывается со старым набором.
   * @param {number} nowMs
   */
  checkClock(nowMs) {
    if (this.runActive || nowMs < this.nextDayAt) return;
    this.ensureDay();
  }

  /**
   * Подменить дату (тесты, отладка). null — вернуть живые часы.
   * @param {number|null} key ГГГГММДД
   */
  setDayOverride(key) {
    this.dayOverride = key;
    this.ensureDay();
  }

  /** Пересобрать тексты слотов. */
  refreshTexts() {
    const slots = this.state.slots;
    for (let i = 0; i < slots.length; i++) {
      this.texts[i] = formatMissionText(slots[i].type, slots[i].tier);
    }
  }

  /**
   * Строка таймера до нового набора. Минуты округляются ВВЕРХ: «0 мин» при
   * живом таймере читалось бы как зависание.
   * @param {number} nowMs
   * @returns {string}
   */
  timerString(nowMs) {
    if (this.nextDayAt === Infinity) return '';
    const minutes = Math.max(1, Math.ceil((this.nextDayAt - nowMs) / 60000));
    if (minutes !== this.timerMinutes) {
      this.timerMinutes = minutes;
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      const T = CFG.missions.text;
      this.timerText = (h > 0 ? T.timer : T.timerMinutes)
        .replace('{h}', String(h)).replace('{m}', String(m));
    }
    return this.timerText;
  }

  // -------------------------------------------------------------------------
  // Чтение для интерфейса
  // -------------------------------------------------------------------------

  /** @param {number} i @returns {number} цель слота */
  target(i) {
    const s = this.state.slots[i];
    return missionTarget(s.type, s.tier);
  }

  /** @param {number} i @returns {number} прогресс для показа */
  progress(i) {
    const s = this.state.slots[i];
    if (s.done) return this.target(i);
    return missionType(s.type).mode === MISSION_MODE.RUN ? this.runValue[i] : s.progress;
  }

  /** @param {number} i @returns {number} награда слота */
  reward(i) {
    return CFG.missions.rewards[this.state.slots[i].tier];
  }

  /** @returns {number} сколько заданий дня выполнено */
  doneCount() {
    let n = 0;
    for (const s of this.state.slots) if (s.done) n++;
    return n;
  }

  /** @returns {boolean} бонус за все три можно забрать */
  bonusReady() {
    return !this.state.bonusClaimed && this.doneCount() === this.state.slots.length;
  }

  /** @returns {boolean} есть хоть одна незабранная награда — точка на кнопке */
  hasClaimable() {
    for (const s of this.state.slots) if (s.done && !s.claimed) return true;
    return this.bonusReady();
  }

  /** @param {number} i @returns {boolean} доступна ли замена */
  canReroll(i) {
    const s = this.state.slots[i];
    return !s.done && !this.runActive
      && this.state.rerollsUsed < CFG.missions.rerollsPerDay;
  }

  // -------------------------------------------------------------------------
  // Действия игрока
  // -------------------------------------------------------------------------

  /**
   * Забрать награду слота. «Забрано» пишется ДО начисления: из двух возможных
   * сбоев (награда пропала / выдана дважды) второй хуже, его и исключаем.
   * @param {number} i
   * @returns {number} сколько осколков начислено (0 — нечего забирать)
   */
  claim(i) {
    const s = this.state.slots[i];
    if (!s || !s.done || s.claimed) return 0;
    s.claimed = true;
    saveMissions(this.state);
    const amount = this.reward(i);
    addShards(amount);
    return amount;
  }

  /** @returns {number} бонус за все три, 0 — недоступен */
  claimBonus() {
    if (!this.bonusReady()) return 0;
    this.state.bonusClaimed = true;
    saveMissions(this.state);
    addShards(CFG.missions.allBonus);
    return CFG.missions.allBonus;
  }

  /**
   * Заменить невыполненное задание на другое той же сложности.
   * @param {number} i
   * @returns {boolean} получилось ли
   */
  reroll(i) {
    if (!this.canReroll(i)) return false;
    const next = rerollPick(this.state.day, this.state.slots, i, this.state.rerollsUsed);
    if (!next) return false;
    this.state.slots[i] = {
      type: next, tier: this.state.slots[i].tier, progress: 0, done: false, claimed: false,
    };
    this.state.rerollsUsed++;
    this.runValue[i] = 0;
    saveMissions(this.state);
    this.refreshTexts();
    return true;
  }

  // -------------------------------------------------------------------------
  // События из игры
  // -------------------------------------------------------------------------

  /** Обнулить всё «за забег». */
  resetRun() {
    for (let i = 0; i < 3; i++) {
      this.runValue[i] = 0;
      this.doneThisRun[i] = false;
    }
    this.runRevived = false;
  }

  /** Забег начался: сверяем день и запоминаем «было». */
  onRunStart() {
    this.runActive = false; // чтобы смена дня между забегами применилась
    this.ensureDay();
    this.resetRun();
    const slots = this.state.slots;
    for (let i = 0; i < slots.length; i++) this.before[i] = slots[i].progress;
    this.runActive = true;
  }

  /**
   * Пройдена новая планета цепочки (первая посадка на неё).
   * @param {import('./planet.js').Planet} planet
   * @param {number} passed planetsPassed после посадки
   * @param {number} score видимый счёт после посадки
   */
  onPlanet(planet, passed, score) {
    if (!this.runActive) return;
    const lava = planet.hasTrap(TRAP.HOT) || planet.hasTrap(TRAP.SMOLDER);
    const vine = planet.hasTrap(TRAP.VINE);
    const slots = this.state.slots;
    for (let i = 0; i < slots.length; i++) {
      switch (slots[i].type) {
        case 'planets': this.addTotal(i, 1); break;
        case 'lavaPlanets': if (lava) this.addTotal(i, 1); break;
        case 'vinePlanets': if (vine) this.addTotal(i, 1); break;
        case 'planetsRun': this.setRun(i, passed); break;
        case 'noRevive': if (!this.runRevived) this.setRun(i, passed); break;
        case 'scoreRun': this.setRun(i, score); break;
        default: break;
      }
    }
  }

  /** Первая посадка на астероид — та же, что платит осколки. */
  onAsteroid() {
    if (!this.runActive) return;
    const slots = this.state.slots;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].type === 'asteroids') this.addTotal(i, 1);
    }
  }

  /**
   * Серия выросла.
   * @param {number} best лучшая серия этого забега
   */
  onStreak(best) {
    if (!this.runActive) return;
    const slots = this.state.slots;
    for (let i = 0; i < slots.length; i++) {
      const t = slots[i].type;
      if (t === 'streakRun' || t === 'streakLevel') this.setRun(i, best);
    }
  }

  /** Куплено воскрешение: «без воскрешения» дальше не растёт. */
  onRevive() {
    this.runRevived = true;
  }

  /**
   * Забег окончен поражением. Засчитываем забег, собираем сводку для экрана
   * поражения и обнуляем всё «за забег».
   */
  onRunEnd() {
    if (!this.runActive) return;
    const slots = this.state.slots;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].type === 'runs') this.addTotal(i, 1);
    }
    this.buildSummary();
    this.resetRun();
    this.runActive = false;
  }

  /** Забег брошен (выход в меню с паузы): не засчитывается, сводки нет. */
  abortRun() {
    if (!this.runActive) return;
    this.resetRun();
    this.runActive = false;
  }

  /** Строки «было -> стало» для экрана поражения. */
  buildSummary() {
    const T = CFG.missions.text;
    const slots = this.state.slots;
    this.lastRun = [];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const type = missionType(s.type);
      const target = this.target(i);
      let value;
      if (type.mode === MISSION_MODE.TOTAL) {
        // Накопительное: показываем, сколько было до забега и сколько стало.
        if (s.progress <= this.before[i] && !this.doneThisRun[i]) continue;
        value = `${this.before[i]} → ${s.progress} / ${target}`;
      } else {
        if (this.runValue[i] <= 0 && !this.doneThisRun[i]) continue;
        // За забег «было» всегда ноль — показываем итог забега.
        value = `${Math.min(this.runValue[i], target)} / ${target}`;
      }
      if (this.doneThisRun[i]) value += ` · ${T.overDone}`;
      this.lastRun.push({ text: this.texts[i], value, done: this.doneThisRun[i] });
    }
  }

  /**
   * Прибавить к накопительному заданию.
   * @param {number} i @param {number} amount
   */
  addTotal(i, amount) {
    const s = this.state.slots[i];
    if (s.done) return;
    s.progress = Math.min(s.progress + amount, this.target(i));
    if (s.progress >= this.target(i)) this.complete(i);
    else saveMissions(this.state);
  }

  /**
   * Обновить «за забег»: значение только растёт в пределах забега.
   * @param {number} i @param {number} value
   */
  setRun(i, value) {
    const s = this.state.slots[i];
    if (s.done || value <= this.runValue[i]) return;
    this.runValue[i] = value;
    if (value >= this.target(i)) this.complete(i);
  }

  /** @param {number} i слот выполнен — отмечаем сразу и ставим тост в очередь */
  complete(i) {
    const s = this.state.slots[i];
    s.done = true;
    s.progress = this.target(i);
    this.doneThisRun[i] = true;
    saveMissions(this.state);
    const Q = this.toastRing.length;
    if (this.toastCount < Q) {
      this.toastRing[(this.toastHead + this.toastCount) % Q] = i;
      this.toastCount++;
    }
  }

  /** @returns {number} индекс слота следующего тоста или -1 */
  takeToast() {
    if (this.toastCount === 0) return -1;
    const i = this.toastRing[this.toastHead];
    this.toastHead = (this.toastHead + 1) % this.toastRing.length;
    this.toastCount--;
    return i;
  }
}
