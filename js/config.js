/**
 * Orbit Jumper — единственное место для числовых констант.
 * Правило проекта: ни одного «магического числа» вне этого файла.
 */
export const CFG = {
  /** Физика: фиксированный шаг + защита от «спирали смерти» при лагах. */
  physics: {
    step: 1 / 120,        // шаг симуляции, с
    maxFrame: 0.25,       // максимум времени, которое можно накопить за кадр, с
  },

  /** Космонавт. */
  player: {
    orbitOffset: 14,      // высота над поверхностью планеты, px
    captureMargin: 20,    // dist < r + captureMargin => приземление, px
    jumpSpeed: 620,       // модуль скорости в полёте, px/s
    maxJumpDistance: 420, // жёсткий потолок дальности прыжка, px — не долетел = смерть
    reachSafety: 0.85,    // спавнер обязан держать планету в пределах maxJumpDistance * reachSafety — честный прыжок гарантирован
    jumpDangerStart: 0.85, // доля от maxJumpDistance, после которой пунктир-предсказание краснеет (последние 15%)
    radius: 7,            // радиус тела космонавта для отрисовки, px
    killMargin: 200,      // выход за пределы экрана на столько px => смерть
    trailLength: 12,      // точек в шлейфе
    trailStep: 1 / 60,    // период записи точки шлейфа, с
  },

  /** Базовые параметры планет (до кривой сложности). */
  planet: {
    rMin: 60,
    rMax: 90,
    omegaMin: 1.2,        // rad/s
    omegaMax: 2.0,        // rad/s
  },

  /** Генерация: где и как ставим следующую планету. */
  spawn: {
    poolSize: 6,          // сколько планет держим активными
    distMin: 220,         // дистанция между центрами соседних планет, px
    distMax: 340,         // <= player.maxJumpDistance * player.reachSafety — честный прыжок всегда есть
    coneDeg: 70,          // разброс направления от «строго вверх», градусы
    edgeMargin: 40,       // отступ центра планеты от края экрана, px
    minGap: 60,           // минимальный зазор между поверхностями планет, px
    cullBelow: 260,       // насколько ниже низа экрана удаляем планету, px
    placeAttempts: 24,    // попыток подобрать корректную позицию
    firstPlanetFromBottom: 0.32, // стартовая планета: доля высоты экрана снизу
  },

  /** Камера: следует за космонавтом вверх с лагом и мёртвой зоной. */
  camera: {
    lerp: 0.08,           // коэффициент сглаживания за кадр при 60 FPS
    anchor: 0.62,         // где держим космонавта по высоте экрана (0 — верх)
    deadZone: 40,         // не двигаемся, пока рассинхрон меньше этого, px
    shakeAmp: 4,          // амплитуда тряски при приземлении, px
    shakeTime: 0.12,      // длительность тряски, с
  },

  /** Кривая сложности по счёту. */
  difficulty: {
    calmUntil: 10,        // до этого счёта — базовые параметры
    radiusToScore: 35,    // к этому счёту радиусы доходят до минимума
    radiusHardMin: 35,
    radiusHardMax: 55,
    // Глобальный множитель сложности — применяется ко ВСЕМ планетам при спавне
    // (не только к отдельным порогам): растёт асимптотически до x(1+factorCap).
    // difficultyFactor(score) = 1 + min(score / factorScore, factorCap)
    factorScore: 150,       // счёт, к которому множитель почти достигает потолка
    factorCap: 1.2,         // предел добавки к множителю (итог до x2.2)
    omegaJitter: 0.1,       // случайный разброс omega вокруг множителя, ±10%
    jumpDistanceGrowth: 0.15, // на сколько (в долях) растёт maxJumpDistance к позднему этапу —
                              // без этого высокая omega на поздних счётах делает прыжки нечитаемыми
    driftFromScore: 25,   // планеты, дрейфующие по горизонтали
    driftSpeedMin: 20,    // px/s
    driftSpeedMax: 55,    // px/s
    brittleFromScore: 40, // «хрупкие» планеты
    brittleLifetime: 1.5, // с после приземления до разрушения
    brittleChance: 0.35,
    asteroidFromScore: 60,
    asteroidChance: 0.35,
    asteroidRadius: 12,
    asteroidSpeed: 70,    // px/s
  },

  /**
   * Лавовые ловушки — дуговые зоны на поверхности планеты.
   * Заданы в локальных углах планеты, поэтому вращаются вместе с ней.
   * Тип A («раскалённая») — посадка в сектор = мгновенная смерть.
   * Тип B («тлеющая») — посадка разрешена, но включает таймер до смерти.
   */
  lava: {
    fromScore: 15,        // с какого счёта планеты вообще могут получить лаву
    safePlanets: 3,       // первые N планет после старта/рестарта — всегда без лавы
    chanceStart: 0.12,    // шанс лавы на планете сразу после fromScore
    chanceCap: 0.35,      // потолок шанса
    chanceToScore: 60,    // счёт, к которому шанс выходит на потолок
    zonesMax: 2,          // максимум дуг на одной планете
    secondZoneChance: 0.3, // шанс, что дуг будет две, а не одна
    arcMinDeg: 26,        // минимальная угловая ширина дуги, градусы
    arcMaxDeg: 70,        // максимальная угловая ширина дуги, градусы
    coverageMax: 0.4,     // суммарно дуги не длиннее 40% окружности — безопасный сектор есть всегда
    gapMinDeg: 30,        // минимальный зазор между соседними дугами, градусы
    placeAttempts: 12,    // попыток разложить дугу с соблюдением зазора
    hotChance: 0.45,      // доля «раскалённых» (тип A) среди всех дуг
    thickness: 8,         // толщина дуги, px
    outset: 3,            // насколько дуга выступает за радиус планеты, px
    hotPulseSpeed: 6,     // скорость пульсации свечения типа A, rad/s
    hotPulseAmp: 0.35,    // амплитуда пульсации яркости типа A, доля
    hotGlowBlur: 12,      // размытие свечения типа A, px
    smolderDeathTime: 2.5, // с на тлеющей лаве до смерти
    smolderFadeTime: 0.4, // с на затухание виньетки после прыжка
    vignetteMaxAlpha: 0.7, // непрозрачность виньетки при полном таймере
    vignetteBaseAlpha: 0.12, // стартовая непрозрачность в момент посадки — чтобы
                             // таймер читался сразу, а не был ловушкой-сюрпризом
    vignetteInner: 0.45,  // граница прозрачной сердцевины виньетки, доля от полудиагонали
  },

  /** Комбо за дальние перелёты. */
  combo: {
    farRatio: 0.7,        // доля от maxJumpDistance, после которой перелёт «дальний»
    farBonus: 2,          // очков за дальний перелёт
    maxMultiplier: 5,
  },

  /** Тактильная отдача. */
  haptics: {
    jump: 10,             // мс
    death: 25,            // мс
  },

  /** Фон: три слоя звёзд с разной скоростью параллакса. */
  stars: {
    layers: [
      { factor: 0.15, density: 9000, rMin: 0.6, rMax: 1.2, alpha: 0.45 },
      { factor: 0.35, density: 14000, rMin: 0.8, rMax: 1.6, alpha: 0.65 },
      { factor: 0.60, density: 22000, rMin: 1.0, rMax: 2.0, alpha: 0.9 },
    ],
    tileExtra: 1.5,       // высота полосы звёзд относительно экрана
  },

  /** Палитра. Всё рисуется кодом, растровых ассетов нет. */
  colors: {
    bg: '#0b1026',
    bgGlow: '#151d47',
    warmWhite: '#fff4e2',
    dim: 'rgba(255,244,226,0.45)',
    danger: '#ff6b6b',
    planetPalette: [
      ['#2e5bff', '#1b2a6b'],
      ['#00c2ff', '#0b4f7a'],
      ['#7a5cff', '#2a1b6b'],
      ['#00d8a4', '#0b5a4a'],
      ['#4d7cff', '#16205c'],
    ],
    brittle: ['#ff9f68', '#6b2f1b'],
    asteroid: '#8a94b8',
    lavaHot: '#ff3030',     // тип A — раскалённая лава, мгновенная смерть
    lavaSmolder: '#ff8c1a', // тип B — тлеющая лава, таймер под давлением
  },

  /** UI и переходы. */
  ui: {
    fadeTime: 0.2,        // длительность fade между экранами, с
  },
};

/**
 * Глобальный множитель сложности по счёту. Растёт асимптотически: быстро в начале,
 * почти не растёт после factorScore — применяется ко всем планетам при спавне,
 * а не только к отдельным порогам.
 * @param {number} score
 * @returns {number} множитель, 1 .. (1 + factorCap)
 */
export function difficultyFactor(score) {
  return 1 + Math.min(score / CFG.difficulty.factorScore, CFG.difficulty.factorCap);
}

/**
 * Вероятность того, что новая планета получит лаву. До lava.fromScore — ноль,
 * дальше растёт от chanceStart к потолку chanceCap.
 * @param {number} score
 * @returns {number} 0..chanceCap
 */
export function lavaChance(score) {
  const L = CFG.lava;
  if (score < L.fromScore) return 0;
  const t = Math.min((score - L.fromScore) / (L.chanceToScore - L.fromScore), 1);
  return L.chanceStart + (L.chanceCap - L.chanceStart) * t;
}

/**
 * Потолок дальности прыжка с поправкой на сложность: растёт вместе с omega,
 * иначе быстрое вращение на поздних счётах делает прыжки нечитаемыми без
 * запаса по дальности. Использует ту же кривую прогресса, что и difficultyFactor.
 * @param {number} score
 * @returns {number} px
 */
export function effectiveMaxJumpDistance(score) {
  const t = Math.min(score / CFG.difficulty.factorScore, CFG.difficulty.factorCap) / CFG.difficulty.factorCap;
  return CFG.player.maxJumpDistance * (1 + CFG.difficulty.jumpDistanceGrowth * t);
}
