import { CFG } from './config.js';

/**
 * Предзагрузка растровых ассетов.
 *
 * Единственная точка загрузки картинок в игре: всё остальное рисуется
 * процедурно. Игровой цикл стартует только после того, как судьба каждого
 * файла выяснена — загрузился он или нет. Иначе первый кадр меню показал бы
 * пустое место там, где через мгновение появится логотип.
 *
 * Отсутствие файла НЕ считается фатальной ошибкой: игра обязана запускаться
 * и без ассетов (файл ещё не положили, кэш пуст, сеть отвалилась). В этом
 * случае значение остаётся null, а место под картинку всё равно резервируется
 * вёрсткой — так появление файла позже не сдвинет остальные элементы.
 */

/**
 * Загруженные ассеты. Ключ — имя, значение — готовое изображение либо null,
 * если файл недоступен.
 * @type {{logo: HTMLImageElement|null}}
 */
export const ASSETS = {
  logo: null,
};

/** Загрузка уже выполнялась: повторный preload — no-op. */
let loaded = false;

/**
 * Загрузить одну картинку, никогда не отклоняя промис.
 *
 * Таймаут обязателен: `Image` на битом или бесконечно висящем ответе может не
 * позвать ни onload, ни onerror, и без него игра просто не запустилась бы.
 *
 * @param {string} src путь к файлу
 * @param {number} timeoutMs сколько ждём, прежде чем сдаться
 * @returns {Promise<HTMLImageElement|null>} null, если файл недоступен
 */
export function loadImage(src, timeoutMs) {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    img.onload = () => {
      // Декодируем заранее, где это поддержано: иначе первый drawImage
      // декодирует картинку синхронно прямо в кадре и даёт заметный провал.
      if (typeof img.decode === 'function') {
        img.decode().then(() => finish(img)).catch(() => finish(img));
      } else {
        finish(img);
      }
    };
    img.onerror = () => finish(null);

    img.src = src;
  });
}

/**
 * Загрузить все ассеты игры. Вызывается один раз перед первым кадром.
 * @returns {Promise<void>}
 */
export async function preloadAssets() {
  if (loaded) return;
  loaded = true;
  const A = CFG.assets;
  // Логотип и шрифт грузятся параллельно: ждать их по очереди значило бы
  // складывать два таймаута на плохой сети.
  const [logo] = await Promise.all([
    loadImage(A.logoPath, A.loadTimeout),
    loadFonts(A.loadTimeout),
  ]);
  ASSETS.logo = logo;
}

/**
 * Загрузить шрифт интерфейса, никогда не отклоняя промис.
 *
 * Правила те же, что у логотипа: ждём не дольше таймаута, после него игра
 * стартует на системном шрифте. Отличие одно — опоздавший шрифт не
 * выбрасывается: когда файл всё-таки приедет, onReady сообщит об этом, и
 * канвас со следующего кадра перерисует текст уже им (игра рисует каждый
 * кадр заново, поэтому достаточно сменить строку шрифта).
 *
 * @param {number} timeoutMs сколько ждём до старта игры
 * @returns {Promise<boolean>} успел ли шрифт к старту
 */
export function loadFonts(timeoutMs) {
  const TY = CFG.type;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);

    try {
      if (typeof FontFace !== 'function' || !document.fonts) {
        settle(false);
        return;
      }
      const faces = CFG.assets.fonts.map((f) => new FontFace(
        TY.family, `url(${f.path}) format("woff2")`,
        { weight: TY.weightRange, style: 'normal', unicodeRange: f.range },
      ));
      Promise.all(faces.map((face) => face.load())).then((ready) => {
        for (const face of ready) document.fonts.add(face);
        // Сообщаем всегда, даже после таймаута: опоздавший шрифт тоже нужен.
        for (const fn of fontListeners) fn();
        settle(true);
      }).catch(() => settle(false));
    } catch {
      settle(false);
    }
  });
}

/** Кого известить, когда шрифт готов. @type {(() => void)[]} */
const fontListeners = [];

/**
 * Подписаться на готовность шрифта. Вызывать ДО preloadAssets().
 * @param {() => void} fn
 */
export function onFontReady(fn) {
  fontListeners.push(fn);
}

/**
 * Пропорции картинки (ширина / высота).
 *
 * Пока файла нет, отдаём запасное соотношение из конфига — по нему вёрстка
 * резервирует место, и появление логотипа не сдвинет ни разделитель, ни
 * строку статистики под ним.
 *
 * @param {HTMLImageElement|null} img
 * @param {number} fallback запасное соотношение сторон
 * @returns {number}
 */
export function aspectOf(img, fallback) {
  if (!img || !img.naturalWidth || !img.naturalHeight) return fallback;
  return img.naturalWidth / img.naturalHeight;
}
