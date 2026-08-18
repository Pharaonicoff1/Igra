const KEY = 'orbit-jumper:best';
const SETTINGS_KEY = 'orbit-jumper:settings';
const SHARDS_KEY = 'orbit-jumper:shards';
const SHOP_KEY = 'orbit-jumper:shop';

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

/** @typedef {{ownedSkins:string[], ownedThemes:string[], activeSkinId:string, activeThemeId:string}} ShopState */

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
