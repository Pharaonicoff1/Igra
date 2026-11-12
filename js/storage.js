import {
  clampMultiplierLevel, MISSION_TIERS, MISSION_MODE, missionType, missionTarget,
} from './config.js';

const KEY = 'orbit-jumper:best';
const SETTINGS_KEY = 'orbit-jumper:settings';
const SHARDS_KEY = 'orbit-jumper:shards';
const STREAK_KEY = 'orbit-jumper:beststreak';
const SECTOR_KEY = 'orbit-jumper:bestsector';
const SHOP_KEY = 'orbit-jumper:shop';
const MISSIONS_KEY = 'orbit-jumper:missions';

/**
 * Версия схемы записи заданий. Меняется при любом несовместимом изменении
 * формата; запись другой версии не чинится, а выбрасывается — набор дня
 * детерминирован по дате и восстановится сам, теряется только прогресс.
 */
export const MISSIONS_SCHEMA = 1;

/** Что выдаётся бесплатно с первого запуска. */
const FREE_SKIN = 'default';
const FREE_THEME = 'space';

/** @typedef {{sound:boolean, theme:string}} Settings */

/** Значения по умолчанию для первого запуска. */
const DEFAULTS = { sound: true, theme: 'space' };

/**
 * Прочитать рекорд.
 * @returns {number}
 */
export function loadBest() {
  try {
    const raw = localStorage.getItem(KEY);
    const n = raw === null ? 0 : parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    // Приватный режим/заблокированное хранилище — играем без рекорда.
    return 0;
  }
}

/**
 * Сохранить рекорд, если он выше прошлого.
 * @param {number} score
 * @returns {number} актуальный рекорд
 */
export function saveBest(score) {
  const best = loadBest();
  if (score <= best) return best;
  try {
    localStorage.setItem(KEY, String(score));
  } catch {
    // Игнорируем: невозможность сохранить не должна ломать игру.
  }
  return score;
}

/**
 * Прочитать рекорд серии за точные прыжки. Отдельный ключ, а не поле внутри
 * рекорда очков: это два независимых достижения, и лучшая серия вполне может
 * быть поставлена в забеге с посредственным счётом.
 * @returns {number}
 */
export function loadBestStreak() {
  try {
    const raw = localStorage.getItem(STREAK_KEY);
    const n = raw === null ? 0 : parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Сохранить рекорд серии, если он выше прошлого.
 * @param {number} streak
 * @returns {number} актуальный рекорд серии
 */
export function saveBestStreak(streak) {
  const best = loadBestStreak();
  if (streak <= best) return best;
  try {
    localStorage.setItem(STREAK_KEY, String(streak));
  } catch {
    // Игнорируем: невозможность сохранить не должна ломать игру.
  }
  return streak;
}

/**
 * Прочитать дальний достигнутый сектор (номер с единицы; 0 — ещё не играл).
 * Хранится только номер: название сектора зависит от темы, и в меню игрок
 * видит «СЕКТОР 3», какой бы темой он туда ни долетел.
 * @returns {number}
 */
export function loadBestSector() {
  try {
    const raw = localStorage.getItem(SECTOR_KEY);
    const n = raw === null ? 0 : parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Сохранить достигнутый сектор, если он дальше прошлого.
 * @param {number} number номер сектора с единицы
 * @returns {number} актуальный рекорд
 */
export function saveBestSector(number) {
  const best = loadBestSector();
  if (!(number > best)) return best;
  try {
    localStorage.setItem(SECTOR_KEY, String(Math.floor(number)));
  } catch {
    // Игнорируем: невозможность сохранить не должна ломать игру.
  }
  return Math.floor(number);
}

/**
 * @typedef {{type:string, tier:string, progress:number, done:boolean, claimed:boolean}} MissionSlot
 * @typedef {{v:number, day:number, rerollsUsed:number, bonusClaimed:boolean,
 *   slots:MissionSlot[]}} MissionsState
 */

/**
 * Прочитать состояние ежедневных заданий, починив всё, что можно починить.
 *
 * Правила починки (по образцу clampMultiplierLevel — хранилище не верит
 * записи на слово):
 *  - чужая версия схемы, битый JSON, кривая дата -> null, набор пересоберётся;
 *  - слотов не три, сложности не по порядку, тип неизвестен или не выдаётся
 *    на своей сложности, две семьи совпали -> null: такой набор не мог
 *    получиться у генератора, и чинить его по кускам значило бы выдумывать;
 *  - прогресс приводится к целому в [0, цель]; накопительное задание с
 *    прогрессом на цели считается выполненным; «забрано» без «выполнено»
 *    сбрасывается — награду за невыполненное не выдают задним числом.
 *
 * @returns {MissionsState|null}
 */
export function loadMissions() {
  let parsed;
  try {
    const raw = localStorage.getItem(MISSIONS_KEY);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return sanitizeMissions(parsed);
}

/**
 * Проверка и починка записи заданий. Отдельно от чтения — чтобы её можно было
 * прогнать на подсунутых данных в тестах.
 * @param {any} parsed
 * @returns {MissionsState|null}
 */
export function sanitizeMissions(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.v !== MISSIONS_SCHEMA) return null;
  const day = Number(parsed.day);
  // ГГГГММДД: восемь цифр, иначе это не наша дата.
  if (!Number.isInteger(day) || day < 19700101 || day > 99991231) return null;
  if (!Array.isArray(parsed.slots) || parsed.slots.length !== MISSION_TIERS.length) return null;

  const families = new Set();
  const slots = [];
  for (let i = 0; i < MISSION_TIERS.length; i++) {
    const s = parsed.slots[i];
    const tier = MISSION_TIERS[i];
    if (!s || s.tier !== tier) return null;
    const type = missionType(s.type);
    const target = type ? missionTarget(s.type, tier) : null;
    if (!type || target === null) return null;
    if (families.has(type.family)) return null;
    families.add(type.family);

    let progress = Math.round(Number(s.progress));
    if (!Number.isFinite(progress)) progress = 0;
    progress = Math.min(Math.max(progress, 0), target);
    let done = s.done === true;
    if (type.mode === MISSION_MODE.TOTAL && progress >= target) done = true;
    if (done) progress = target;
    const claimed = done && s.claimed === true;
    slots.push({ type: type.id, tier, progress, done, claimed });
  }

  let rerollsUsed = Math.round(Number(parsed.rerollsUsed));
  if (!Number.isFinite(rerollsUsed) || rerollsUsed < 0) rerollsUsed = 0;
  const allDone = slots.every((s) => s.done);
  return {
    v: MISSIONS_SCHEMA,
    day,
    rerollsUsed,
    bonusClaimed: allDone && parsed.bonusClaimed === true,
    slots,
  };
}

/**
 * Сохранить состояние заданий. Пишется сразу при каждом изменении, а не в
 * конце забега: выполненное задание не должно теряться от закрытой вкладки.
 * @param {MissionsState} state
 */
export function saveMissions(state) {
  try {
    localStorage.setItem(MISSIONS_KEY, JSON.stringify(state));
  } catch {
    // Приватный режим — задания живут до перезагрузки, набор всё равно тот же.
  }
}

/**
 * Прочитать накопленные космические осколки.
 *
 * Валюта живёт МЕЖДУ забегами и не обнуляется смертью: тратить её пока негде,
 * и сброс был бы чистым наказанием без компенсации.
 * @returns {number}
 */
export function loadShards() {
  try {
    const raw = localStorage.getItem(SHARDS_KEY);
    const n = raw === null ? 0 : parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    // Приватный режим/заблокированное хранилище — играем без накоплений.
    return 0;
  }
}

/**
 * Начислить осколки поверх накопленного. Пишется сразу при получении, а не в
 * конце забега: смерть не должна съедать уже заработанное.
 * @param {number} amount сколько добавить (>= 0)
 * @returns {number} новый итог
 */
export function addShards(amount) {
  const total = loadShards() + Math.max(0, Math.round(amount));
  try {
    localStorage.setItem(SHARDS_KEY, String(total));
  } catch {
    // Не смогли сохранить — в этой сессии счётчик всё равно вырастет.
  }
  return total;
}

/**
 * Списать осколки на покупку.
 *
 * Проверка достаточности живёт ЗДЕСЬ, а не в UI: хранилище — единственный
 * источник правды по балансу, и оно не должно полагаться на то, что кнопка
 * была правильно притушена.
 *
 * @param {number} amount сколько списать
 * @returns {number|null} новый баланс, либо null если не хватило (ничего не списано)
 */
export function spendShards(amount) {
  const cost = Math.max(0, Math.round(amount));
  const have = loadShards();
  if (have < cost) return null;
  const total = have - cost;
  try {
    localStorage.setItem(SHARDS_KEY, String(total));
  } catch {
    // Не смогли сохранить — в этой сессии баланс всё равно уменьшится.
  }
  return total;
}

/** @typedef {{ownedSkins:string[], ownedThemes:string[], activeSkinId:string, activeThemeId:string, multiplierLevel:number}} ShopState */

/**
 * Прочитать состояние магазина: что куплено и что экипировано.
 *
 * МИГРАЦИЯ: до появления магазина тема выбиралась в настройках и лежала в
 * settings.theme. Если записи магазина ещё нет, а сохранённая тема была не
 * дефолтной — считаем её честно полученной и переносим во владение, а не
 * откатываем игрока на «Космос».
 *
 * @returns {ShopState}
 */
export function loadShop() {
  const base = {
    ownedSkins: [FREE_SKIN],
    ownedThemes: [FREE_THEME],
    activeSkinId: FREE_SKIN,
    activeThemeId: FREE_THEME,
    // Прокачка множителя очков. Необратима и не сбрасывается никогда: у старых
    // записей магазина поля просто нет — это ровно нулевой уровень.
    multiplierLevel: 0,
  };

  let raw = null;
  try {
    raw = localStorage.getItem(SHOP_KEY);
  } catch {
    return base;
  }

  if (!raw) {
    // Записи магазина нет — первый запуск этой версии. Подбираем тему из
    // старых настроек, если игрок её когда-то выбирал.
    const legacy = loadSettings().theme;
    if (legacy && legacy !== FREE_THEME) {
      base.ownedThemes.push(legacy);
      base.activeThemeId = legacy;
    }
    // Сохраняем результат миграции сразу: иначе владение темой существует
    // только в памяти текущей сессии и держится на негласном допущении, что
    // settings.theme больше никогда не перезапишется (в игре так и есть —
    // UI выбора темы в настройках убран, но полагаться на этот факт вечно
    // не стоит, если код когда-нибудь снова начнёт писать settings.theme).
    saveShop(base);
    return base;
  }

  try {
    const parsed = JSON.parse(raw);
    const list = (v, fallback) => {
      const arr = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
      // Бесплатный предмет всегда во владении, даже если запись побилась.
      return arr.includes(fallback) ? arr : [fallback, ...arr];
    };
    const ownedSkins = list(parsed.ownedSkins, FREE_SKIN);
    const ownedThemes = list(parsed.ownedThemes, FREE_THEME);
    // Экипировать можно только то, чем владеешь: битая запись не должна
    // включать неоплаченный предмет.
    const pick = (id, owned, fallback) =>
      (typeof id === 'string' && owned.includes(id) ? id : fallback);
    return {
      ownedSkins,
      ownedThemes,
      activeSkinId: pick(parsed.activeSkinId, ownedSkins, FREE_SKIN),
      activeThemeId: pick(parsed.activeThemeId, ownedThemes, FREE_THEME),
      multiplierLevel: clampMultiplierLevel(parsed.multiplierLevel),
    };
  } catch {
    return base;
  }
}

/**
 * Сохранить состояние магазина.
 * @param {ShopState} state
 */
export function saveShop(state) {
  try {
    localStorage.setItem(SHOP_KEY, JSON.stringify(state));
  } catch {
    // Приватный режим — покупка работает до перезагрузки, но не падает.
  }
}

/**
 * Прочитать настройки. Битые/частичные данные добираются значениями по умолчанию.
 * @returns {Settings}
 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      sound: typeof parsed.sound === 'boolean' ? parsed.sound : DEFAULTS.sound,
      theme: typeof parsed.theme === 'string' ? parsed.theme : DEFAULTS.theme,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Сохранить настройки.
 * @param {Settings} settings
 */
export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Приватный режим — играем без сохранения, но не падаем.
  }
}
