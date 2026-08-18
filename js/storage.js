const KEY = 'orbit-jumper:best';
const SETTINGS_KEY = 'orbit-jumper:settings';
const SHARDS_KEY = 'orbit-jumper:shards';

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
