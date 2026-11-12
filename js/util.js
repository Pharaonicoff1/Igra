/**
 * Мелкие общие утилиты без состояния: детерминированный генератор, склонение
 * по числу, разбор цвета. Вынесены сюда, когда понадобились второму модулю —
 * импортировать их из заданий в небо (или наоборот) значило бы связать
 * системы, которые друг о друге знать не должны.
 */

/**
 * Детерминированный генератор (mulberry32). Тот же seed — та же
 * последовательность на любом устройстве.
 * @param {number} seed
 * @returns {() => number} [0, 1)
 */
export function mulberry32(seed) {
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
 * Смешать несколько целых в один seed.
 * @param {...number} parts
 * @returns {number}
 */
export function mixSeed(...parts) {
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
 * Подставить в шаблон формы слова: «{сектор|сектора|секторов}» -> по числу n.
 * @param {string} text
 * @param {number} n
 * @returns {string}
 */
export function pluralize(text, n) {
  return text.replace(/\{([^{}|]+)\|([^{}|]+)\|([^{}|]+)\}/g, (_, a, b, c) => pluralRu(n, [a, b, c]));
}

/**
 * Разобрать #rrggbb в число 0xRRGGBB. Делается ЗАРАНЕЕ (при смене сектора),
 * чтобы в кадре с цветом работали как с числами, а не со строками.
 * @param {string} hex
 * @returns {number}
 */
export function parseHex(hex) {
  return parseInt(hex.slice(1), 16);
}

/**
 * Строка rgba() из числа 0xRRGGBB.
 * @param {number} rgb
 * @param {number} alpha 0..1
 * @returns {string}
 */
export function rgba(rgb, alpha) {
  return `rgba(${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255},${alpha})`;
}

/**
 * Линейная смесь двух цветов 0xRRGGBB по каналам.
 * @param {number} a @param {number} b
 * @param {number} t 0..1
 * @returns {number}
 */
export function mixRgb(a, b, t) {
  const r = ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t;
  const g = ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t;
  const bl = (a & 255) + ((b & 255) - (a & 255)) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}
