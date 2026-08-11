const KEY = 'orbit-jumper:best';

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
