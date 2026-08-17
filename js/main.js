import {
  CFG, TRAP, effectiveMaxJumpDistance, spinBoostFactor,
  theme, setTheme, getThemeId, THEMES, THEME_ORDER,
} from './config.js';
import { Player, STATE_ORBIT, STATE_FLY } from './player.js';
import { Spawner } from './spawner.js';
import { Camera } from './camera.js';
import { Particles } from './particles.js';
import { Input } from './input.js';
import { Sfx } from './audio.js';
import { loadBest, saveBest, loadSettings, saveSettings } from './storage.js';

/** @type {HTMLCanvasElement} */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const view = { w: 0, h: 0, dpr: 1 };
const camera = new Camera();
const spawner = new Spawner();
const player = new Player();
const particles = new Particles();
const sfx = new Sfx();

/** Три экрана в одном канвасе. */
const SCREEN_MENU = 'menu';
const SCREEN_PLAY = 'play';
const SCREEN_OVER = 'over';

const game = {
  screen: SCREEN_MENU,
  /**
   * Очки: нелинейны, растут через множитель. Идут ТОЛЬКО в UI и в рекорд —
   * сложность на них не смотрит.
   */
  score: 0,
  /**
   * Реальный прогресс: сколько планет пройдено с начала раунда, ровно +1 за
   * успешную посадку, независимо от множителя. ЕДИНСТВЕННЫЙ источник сложности
   * (omega, пороги ловушек, дальность прыжка, затухание буста). На очках
   * сложность разгонялась бы впереди умения игрока: на x10 одна посадка давала
   * бы +10 к шкале сложности, и множитель наказывал бы сам себя.
   */
  planetsPassed: 0,
  best: loadBest(),
  /** Сколько секунд космонавт стоит на тлеющей лаве. Гонит виньетку и таймер смерти. */
  timeOnLava: 0,
  /** Прогресс fade текущего экрана, 0..1. Считается по реальному времени. */
  screenFade: 0,
  /** Множитель очков: растёт за дальние перелёты, сбрасывается за короткие. */
  multiplier: 1,
  /** Энергия частиц от множителя — пересчитывается при каждом его изменении. */
  particleEnergy: 1,
  /** Потолок дальности на момент отрыва: по нему считается «дальний» перелёт. */
  lastJumpLimit: CFG.player.maxJumpDistance,
  /** Накопитель для редких искр шлейфа, с. */
  sparkT: 0,
};

/** Пользовательские настройки: живут в localStorage, применяются сразу. */
const settings = loadSettings();

/** Состояние панели настроек. from — экран, с которого её открыли. */
const panel = {
  open: false,
  from: SCREEN_MENU,
  /** Прогресс fade панели, 0..1. Идёт по реальному времени, поэтому работает на паузе. */
  fade: 0,
};

/** Отступы безопасной зоны (вырез, домашний индикатор). Кэшируем на resize. */
const safe = { top: 0, bottom: 0 };

/** Три слоя звёзд для параллакса. @type {{factor:number,alpha:number,tileH:number,stars:{x:number,y:number,r:number}[]}[]} */
let starLayers = [];

setTheme(settings.theme);
sfx.setEnabled(settings.sound);

/**
 * Пересчитать размеры канваса под devicePixelRatio.
 * Логика игры живёт в CSS-пикселях, dpr применяется только к трансформу контекста.
 */
function resize() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 3);
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  canvas.width = Math.round(view.w * view.dpr);
  canvas.height = Math.round(view.h * view.dpr);
  canvas.style.width = `${view.w}px`;
  canvas.style.height = `${view.h}px`;

  // Safe-area читаем редко (только здесь), а не каждый кадр.
  const css = getComputedStyle(document.documentElement);
  safe.top = parseFloat(css.getPropertyValue('--sat')) || 0;
  safe.bottom = parseFloat(css.getPropertyValue('--sab')) || 0;

  buildStars();
}

/**
 * Сгенерировать звёзды: плотность задана как «один пиксель звезды на N px² экрана».
 * Тайл делается больше экрана по обеим осям — камера теперь ездит и вбок,
 * поэтому поле замыкается в двумерный тор, а не только по вертикали.
 */
function buildStars() {
  const tileW = view.w * CFG.stars.tileExtra;
  const tileH = view.h * CFG.stars.tileExtra;
  starLayers = CFG.stars.layers.map((layer) => {
    const count = Math.round((tileW * tileH) / layer.density);
    const stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * tileW,
        y: Math.random() * tileH,
        r: layer.rMin + Math.random() * (layer.rMax - layer.rMin),
      });
    }
    return { factor: layer.factor, alpha: layer.alpha, stars, tileW, tileH };
  });
}

/**
 * Сменить экран с перезапуском fade-перехода.
 * @param {string} screen
 */
function setScreen(screen) {
  game.screen = screen;
  game.screenFade = 0;
}

/** Заново собрать мир: планеты, космонавт, камера. */
function resetWorld() {
  game.score = 0;
  game.planetsPassed = 0;
  game.timeOnLava = 0;
  setMultiplier(1);
  particles.clear(); // пул не должен переносить хвосты между раундами
  const first = spawner.reset(view);
  player.attach(first, -Math.PI / 2);

  // Кадр надо собрать до первого спавна: границы спавна считаются от видимой
  // области, а она зависит от зума. Ставим камеру дважды — грубо по стартовой
  // планете, затем точно, когда появилась следующая.
  camera.setPair(first, null, view);
  camera.snap(player, view);
  // Предзаполняем цепочку до первого кадра: игрок не должен увидеть,
  // как достраивается мир.
  spawner.fill(camera, view, game.planetsPassed);
  camera.setPair(first, spawner.nextInChain(first), view);
  camera.snap(player, view);
  armSpinBoost(first);
}

/** Уйти в главное меню: мир пересобирается и живёт фоном, игра не идёт. */
function goToMenu() {
  resetWorld();
  setScreen(SCREEN_MENU);
}

/** Начать раунд. */
function startRun() {
  resetWorld();
  setScreen(SCREEN_PLAY);
}

/** Смерть: фиксируем рекорд и уходим на экран поражения. */
function die() {
  if (game.screen !== SCREEN_PLAY) return;
  setScreen(SCREEN_OVER);
  game.best = saveBest(game.score);
  particles.deathBurst(player.x, player.y, game.particleEnergy);
  sfx.death();
  if (navigator.vibrate) navigator.vibrate(CFG.haptics.death);
}

player.onJump = () => {
  // Предсказываем планету назначения прямо в момент тапа и сразу переводим
  // кадр на СЛЕДУЮЩУЮ пару: к посадке кадр уже правильный, доводки не будет.
  // Не нашли цель (летим в пустоту) — камера ведёт космонавта, зум едет к 1.
  const limit = effectiveMaxJumpDistance(game.planetsPassed) * player.jumpFactor();
  game.lastJumpLimit = limit;
  const predicted = spawner.predictTarget(player, limit);
  camera.setPair(predicted, spawner.nextInChain(predicted), view);
  // Планету, с которой ушли, возвращаем к обычной скорости: буст принадлежит
  // только той планете, на которой игрок стоит.
  if (player.ignore) player.ignore.setSpinBoost(1);

  // Множитель: ЕДИНСТВЕННЫЙ критерий — угол, намотанный на ПОКИНУТОЙ планете
  // с момента посадки на неё (player.spentAngle ещё не обнулён — обнуление
  // происходит только в attach(), при следующей посадке). Дальность прыжка,
  // который мы только что совершили, тут вообще не участвует.
  const pos = multiplierScreenPos();
  if (player.spentAngle < CFG.combo.angleThreshold) {
    if (game.multiplier < CFG.combo.maxMultiplier) {
      setMultiplier(game.multiplier + CFG.combo.step);
      particles.multiplierUp(pos.x, pos.y, game.particleEnergy);
    }
  } else if (game.multiplier > 1) {
    particles.multiplierReset(pos.x, pos.y);
    setMultiplier(1);
  }

  // Отдача: конус частиц против направления прыжка.
  const sp = Math.hypot(player.vx, player.vy) || 1;
  particles.jumpRecoil(player.x, player.y, player.vx / sp, player.vy / sp, game.particleEnergy);
  sfx.jump();
  if (navigator.vibrate) navigator.vibrate(CFG.haptics.jump);
};

player.onLand = (planet, flightDist) => {
  camera.shake();
  // Сели не туда, куда вела камера (задели другую планету по пути, планета
  // сдвинулась) — переключаем пару на фактическую, сглаживание доедет.
  // Совпало с предсказанием — setPair увидит ту же пару и не тронет зум.
  camera.setPair(planet, spawner.nextInChain(planet), view);
  // Тип A: сектор раскалённой лавы — смерть в момент касания, как промах.
  // Проверяем до начисления очка: планета не пройдена, если на ней погиб.
  const zone = planet.lavaAt(player.theta);
  if (zone && zone.kind === TRAP.HOT) {
    die();
    return;
  }
  // Прогресс и очки считаем ДО буста: armSpinBoost читает planetsPassed
  // (и потолок дальности, и затухание буста), поэтому планета, на которую
  // только что сели, обязана быть уже засчитана.
  // Дальний перелёт даёт бонус очков (farBonus вместо 1), но НИКАК не трогает
  // multiplier — тот меняется только в onJump, от намотанного угла.
  const far = flightDist >= CFG.combo.farRatio * game.lastJumpLimit;
  const gain = far ? CFG.combo.farBonus : 1;
  if (!planet.visited) {
    planet.visited = true;
    game.score += gain * game.multiplier;
    // Прогресс сложности — ровно +1 за планету, множитель на него не влияет.
    game.planetsPassed++;
  }

  armSpinBoost(planet);
  sfx.land();
  particles.landingDust(planet, player.x, player.y, game.particleEnergy);
};

/**
 * Непрерывные источники частиц: искры за космонавтом в полёте и угольки лавы.
 * Оба идут на фиксированном шаге физики, а не на сыром delta.
 * @param {number} dt секунды
 */
function updateParticleSources(dt) {
  const P = CFG.particles;

  // Искры отваливаются тем чаще, чем выше энергия.
  if (player.state === STATE_FLY) {
    game.sparkT += dt * game.particleEnergy;
    while (game.sparkT >= P.trail.periodBase) {
      game.sparkT -= P.trail.periodBase;
      particles.trailSpark(player.x, player.y, player.vx, player.vy, game.particleEnergy);
    }
  } else {
    game.sparkT = 0;
  }

  // Угольки лавы: только с планет в кадре, иначе пул уйдёт на невидимое.
  const vis = camera.visibleSize(view);
  const left = camera.x - vis.w * 0.1;
  const right = camera.x + vis.w * 1.1;
  const top = camera.y - vis.h * 0.1;
  const bottom = camera.y + vis.h * 1.1;

  for (const planet of spawner.planets) {
    if (planet.lava.length === 0) continue;
    if (planet.x + planet.r < left || planet.x - planet.r > right) continue;
    if (planet.y + planet.r < top || planet.y - planet.r > bottom) continue;

    planet.emberT += dt;
    const period = P.lava.periodPerZone / planet.lava.length;
    while (planet.emberT >= period) {
      planet.emberT -= period;
      const zone = planet.lava[(Math.random() * planet.lava.length) | 0];
      particles.lavaEmber(planet, zone, zone.kind === TRAP.HOT);
    }
  }
}

/**
 * Установить множитель и пересчитать энергию частиц. Энергия — единственный
 * канал, через который множитель влияет на всё остальное: игрок должен
 * чувствовать его ростом живости вокруг, а не чтением цифры.
 * @param {number} value
 */
function setMultiplier(value) {
  game.multiplier = Math.min(Math.max(value, 1), CFG.combo.maxMultiplier);
  game.particleEnergy = Particles.energyFor(game.multiplier);
}

/**
 * Экранная позиция цифры множителя — источник UI-частиц.
 * @returns {{x:number, y:number}}
 */
function multiplierScreenPos() {
  return { x: view.w / 2, y: safe.top + CFG.ui.multiplierY };
}

/** Идёт ли пауза: настройки, открытые поверх игры, останавливают физику. */
function isPaused() {
  return panel.open && panel.from === SCREEN_PLAY;
}

/**
 * Один шаг фиксированной физики.
 * @param {number} dt всегда CFG.physics.step
 */
function update(dt) {
  // На меню мир живёт только визуально: планеты и космонавт крутятся,
  // спавнер и камера стоят — это фон под логотипом, а не игра.
  if (game.screen === SCREEN_MENU) {
    for (const p of spawner.planets) p.update(dt);
    player.update(dt, []);
    return;
  }
  if (game.screen !== SCREEN_PLAY) return;

  player.update(dt, spawner.planets);

  // Не долетел: дальность полёта достигла потолка (с поправкой на сложность и
  // на штраф лозы), а посадки не было. Прогресс во время полёта не меняется
  // (planetsPassed растёт только при посадке), поэтому текущее значение
  // корректно описывает потолок именно этого прыжка.
  const jumpLimit = effectiveMaxJumpDistance(game.planetsPassed) * player.jumpFactor();
  if (player.state === STATE_FLY && player.flightDistance() >= jumpLimit) {
    die();
    return;
  }

  updateLava(dt);
  if (game.screen !== SCREEN_PLAY) return;

  updateSpinBoost();
  updateParticleSources(dt);
  particles.update(dt);
  spawner.update(dt, camera, view, game.planetsPassed, player.planet);
  refreshCameraPair();
  camera.update(dt, player, view);
  // Камера уезжает к цели раньше космонавта — следим, чтобы он не выпал за кадр.
  if (player.state === STATE_FLY) camera.clampToPlayer(player, view, dt);

  // Проверки «улетел за пределы экрана» здесь больше нет: камера ведёт
  // космонавта в полёте, поэтому он физически всегда в кадре, и условие стало
  // недостижимым. Промах теперь ловится единственным честным способом —
  // потолком дальности прыжка выше.
}

/**
 * Параметры луча прыжка «отсюда и сейчас»: потолок дальности и скорость.
 * В обоих уже учтены рост сложности и штраф лозы.
 * @returns {{limit:number, speed:number}}
 */
function jumpRayParams() {
  const factor = player.jumpFactor();
  return {
    limit: effectiveMaxJumpDistance(game.planetsPassed) * factor,
    speed: CFG.player.jumpSpeed * factor,
  };
}

/**
 * Смотрит ли траектория прыжка прямо сейчас в следующую планету цепочки.
 * Именно в неё, а не в любую: иначе буст гас бы от случайного попадания в соседа.
 * @param {import('./planet.js').Planet} planet планета, на которой стоит игрок
 * @returns {boolean}
 */
function jumpWindowOpen(planet) {
  const next = spawner.nextInChain(planet);
  if (!next) return false;
  const { limit, speed } = jumpRayParams();
  return spawner.traceJumpRay(planet, player.theta, limit, speed) === next;
}

/**
 * Взвести буст вращения при постановке игрока на планету.
 * Если окно для прыжка открыто прямо сейчас — ускорять нечего, буст сразу
 * считается израсходованным.
 * @param {import('./planet.js').Planet} planet
 */
function armSpinBoost(planet) {
  planet.boostFlashT = 0;
  if (jumpWindowOpen(planet)) {
    planet.boostConsumed = true;
    planet.setSpinBoost(1);
    return;
  }
  planet.boostConsumed = false;
  planet.setSpinBoost(spinBoostFactor(game.planetsPassed));
}

/**
 * Погасить буст в первый же кадр, когда окно открылось. Одноразово за посадку:
 * пропустил окно — дальше крутится с обычной скоростью, буст не возвращается.
 */
function updateSpinBoost() {
  const planet = player.planet;
  if (!planet || player.state !== STATE_ORBIT || planet.boostConsumed) return;
  if (!jumpWindowOpen(planet)) return;

  // Переход мгновенный, поэтому момент обязан читаться сам по себе:
  // вспышка + короткий тик + лёгкая вибрация.
  planet.boostConsumed = true;
  planet.setSpinBoost(1);
  planet.boostFlashT = CFG.spin.flashTime;
  particles.boostRing(planet);
  sfx.tick();
  if (navigator.vibrate) navigator.vibrate(CFG.haptics.window);
}

/**
 * Держать пару планет кадрирования в актуальном состоянии.
 *
 * Вызывается каждый кадр, но setPair — no-op, пока пара та же, поэтому зум
 * по-прежнему пересчитывается только при СМЕНЕ пары, а не от дрейфа планет.
 * Нужно вот зачем: в момент отрыва цель часто ещё последняя в цепочке, и
 * преемника у неё нет — зум считался бы по неполной паре и обрезал бы верх
 * следующей планеты, пока спавнер не достроит цепочку.
 */
function refreshCameraPair() {
  // В полёте якорь — предсказанная планета назначения, а не текущая (её нет).
  const anchor = player.state === STATE_ORBIT ? player.planet : camera.anchor;
  if (!anchor) return; // промах в пустоту: камера ведёт космонавта
  camera.setPair(anchor, spawner.nextInChain(anchor), view);
}

/**
 * Тип B: пока космонавт стоит в секторе тлеющей лавы — копится timeOnLava и
 * растёт виньетка. Успел прыгнуть — таймер откатывается назад за smolderFadeTime.
 * @param {number} dt секунды фиксированного шага
 */
function updateLava(dt) {
  const L = CFG.lava;
  const zone = player.state === STATE_ORBIT && player.planet
    ? player.planet.lavaAt(player.theta)
    : null;

  if (zone && zone.kind === TRAP.SMOLDER) {
    game.timeOnLava += dt;
    if (game.timeOnLava >= L.smolderDeathTime) {
      game.timeOnLava = L.smolderDeathTime;
      die();
    }
    return;
  }

  // Откат с той же скоростью независимо от накопленного — полная виньетка
  // гаснет ровно за smolderFadeTime.
  if (game.timeOnLava > 0) {
    game.timeOnLava = Math.max(0, game.timeOnLava - dt * (L.smolderDeathTime / L.smolderFadeTime));
  }
}

// ---------------------------------------------------------------------------
// Геометрия UI. Раскладка живёт в одном месте: и отрисовка, и попадания тапа
// берут прямоугольники отсюда, поэтому они не могут разъехаться.
// ---------------------------------------------------------------------------

/**
 * Тап-зона шестерёнки.
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function gearRect() {
  const U = CFG.ui;
  return {
    x: view.w - U.gearMargin - U.gearSize,
    y: safe.top + U.gearMargin,
    w: U.gearSize,
    h: U.gearSize,
  };
}

/**
 * Раскладка панели настроек.
 * @returns {{panel:{x:number,y:number,w:number,h:number}, title:number,
 *   sound:{x:number,y:number,w:number,h:number}, toggle:{x:number,y:number,w:number,h:number},
 *   themeLabel:number, chips:{id:string,x:number,y:number,w:number,h:number}[],
 *   menuBtn:{x:number,y:number,w:number,h:number}|null,
 *   closeBtn:{x:number,y:number,w:number,h:number}}}
 */
function settingsLayout() {
  const U = CFG.ui;
  const showMenuBtn = panel.from === SCREEN_PLAY;
  const w = Math.min(U.panelMaxWidth, view.w - U.panelSideMargin * 2);
  const inner = w - U.panelPadding * 2;

  const titleH = 38;
  const themeLabelH = 26;
  const buttons = showMenuBtn ? 2 : 1;
  const buttonsH = buttons * U.buttonHeight + (buttons - 1) * U.buttonGap;
  const h = U.panelPadding * 2 + titleH + U.rowHeight + themeLabelH + U.chipHeight + 18 + buttonsH;

  const x = (view.w - w) / 2;
  const y = (view.h - h) / 2;
  let cursor = y + U.panelPadding;

  const title = cursor + 22;
  cursor += titleH;

  const sound = { x: x + U.panelPadding, y: cursor, w: inner, h: U.rowHeight };
  const toggle = {
    x: sound.x + inner - U.toggleW,
    y: cursor + (U.rowHeight - U.toggleH) / 2,
    w: U.toggleW,
    h: U.toggleH,
  };
  cursor += U.rowHeight;

  const themeLabel = cursor + 16;
  cursor += themeLabelH;

  const chipW = (inner - U.chipGap * 2) / 3;
  const chips = THEME_ORDER.map((id, i) => ({
    id,
    x: x + U.panelPadding + i * (chipW + U.chipGap),
    y: cursor,
    w: chipW,
    h: U.chipHeight,
  }));
  cursor += U.chipHeight + 18;

  let menuBtn = null;
  if (showMenuBtn) {
    menuBtn = { x: x + U.panelPadding, y: cursor, w: inner, h: U.buttonHeight };
    cursor += U.buttonHeight + U.buttonGap;
  }
  const closeBtn = { x: x + U.panelPadding, y: cursor, w: inner, h: U.buttonHeight };

  return { panel: { x, y, w, h }, title, sound, toggle, themeLabel, chips, menuBtn, closeBtn };
}

/**
 * @param {{x:number,y:number,w:number,h:number}} r
 * @param {number} x
 * @param {number} y
 * @returns {boolean} попал ли тап в прямоугольник
 */
function hit(r, x, y) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// ---------------------------------------------------------------------------
// Отрисовка
// ---------------------------------------------------------------------------

/** Отрисовка кадра. */
function render() {
  const T = theme();
  const s = camera.scale;
  // Тряска складывается с позицией камеры только здесь — в саму позицию она
  // не подмешивается, иначе сглаживание размажет её. Амплитуда задана в
  // экранных px, поэтому в мировых координатах делится на зум.
  const camX = camera.x + camera.shakeX / s;
  const camY = camera.y + camera.shakeY / s;

  // Базовая трансформация экрана: dpr и ничего больше. Всё, что рисуется
  // после restore(), живёт в экранных координатах — без камеры и без зума.
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

  // Фон: градиент активной темы.
  const bg = ctx.createLinearGradient(0, 0, 0, view.h);
  bg.addColorStop(0, T.bg);
  bg.addColorStop(1, T.bgGlow);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, view.w, view.h);

  // Звёзды рисуются в экранных координатах, без зума: иначе при отъезде камеры
  // менялась бы видимая плотность звёздного поля.
  drawStars(camX, camY, T);

  // Единственное место, где мир получает камеру и зум.
  ctx.save();
  ctx.setTransform(view.dpr * s, 0, 0, view.dpr * s, 0, 0);
  ctx.translate(-camX, -camY);
  for (const p of spawner.planets) p.draw(ctx, s);
  player.draw(ctx, effectiveMaxJumpDistance(game.planetsPassed), s);
  // Мировые частицы — внутри той же трансформации, размер компенсирован зумом.
  particles.drawWorld(ctx, s);
  ctx.restore();

  drawLavaVignette(T);
  drawHud(T);
  // UI-частицы: экранные координаты, уже вне трансформации мира.
  particles.drawUi(ctx);
  if (panel.fade > 0) drawSettings(T);
}

/**
 * Красная виньетка тлеющей лавы. Появляется сразу заметной (vignetteBaseAlpha),
 * дальше растёт пропорционально таймеру — давление должно читаться мгновенно.
 * @param {ReturnType<typeof theme>} T
 */
function drawLavaVignette(T) {
  if (game.timeOnLava <= 0) return;
  const L = CFG.lava;
  const t = Math.min(game.timeOnLava / L.smolderDeathTime, 1);
  const alpha = L.vignetteBaseAlpha + (L.vignetteMaxAlpha - L.vignetteBaseAlpha) * t;

  const cx = view.w / 2;
  const cy = view.h / 2;
  const outer = Math.hypot(cx, cy);
  const g = ctx.createRadialGradient(cx, cy, outer * L.vignetteInner, cx, cy, outer);
  g.addColorStop(0, 'rgba(255,48,48,0)');
  g.addColorStop(1, T.lavaHot);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, view.w, view.h);
  ctx.restore();
}

/**
 * Параллакс-звёзды. Каждый слой едет со своей долей скорости камеры по ОБЕИМ
 * осям, поле замкнуто в тор: тайл больше экрана, поэтому достаточно четырёх
 * копий (2x2), и шва не видно при движении в любую сторону.
 * @param {number} camX
 * @param {number} camY
 * @param {ReturnType<typeof theme>} T
 */
function drawStars(camX, camY, T) {
  ctx.fillStyle = T.star;
  for (const layer of starLayers) {
    const { tileW, tileH } = layer;
    const offX = ((camX * layer.factor) % tileW + tileW) % tileW;
    const offY = ((camY * layer.factor) % tileH + tileH) % tileH;
    ctx.globalAlpha = layer.alpha;

    for (const s of layer.stars) {
      const baseX = s.x - offX;
      const baseY = s.y - offY;
      // Две позиции по каждой оси покрывают экран целиком: сдвинутая копия
      // подхватывает то, что ушло за левый/верхний край.
      for (let ix = 0; ix < 2; ix++) {
        const x = baseX + ix * tileW;
        if (x < -s.r || x > view.w + s.r) continue;
        for (let iy = 0; iy < 2; iy++) {
          const y = baseY + iy * tileH;
          if (y < -s.r || y > view.h + s.r) continue;
          ctx.beginPath();
          ctx.arc(x, y, s.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * HUD трёх экранов. Переходы — fade по game.screenFade.
 * @param {ReturnType<typeof theme>} T
 */
function drawHud(T) {
  ctx.textAlign = 'center';

  if (game.screen === SCREEN_PLAY) {
    ctx.globalAlpha = 0.85 * game.screenFade;
    ctx.fillStyle = T.accent;
    ctx.font = '600 44px system-ui, -apple-system, sans-serif';
    ctx.fillText(String(game.score), view.w / 2, safe.top + 64);
    ctx.globalAlpha = game.screenFade;
    ctx.font = '500 14px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = T.dim;
    ctx.fillText(`РЕКОРД ${game.best}`, view.w / 2, safe.top + 88);

    // Множитель: цвет «нагревается» вместе с частицами, из той же рампы темы.
    if (game.multiplier > 1) {
      const tint = T.multiplierTint;
      const step = game.particleEnergy >= 2.2 ? 2 : game.particleEnergy >= 1.5 ? 1 : 0;
      ctx.fillStyle = tint[step];
      ctx.font = '700 22px system-ui, -apple-system, sans-serif';
      ctx.fillText(`x${game.multiplier}`, view.w / 2, safe.top + CFG.ui.multiplierY);
    }
    ctx.globalAlpha = 1;
    drawGear(T);
    return;
  }

  if (game.screen === SCREEN_MENU) {
    ctx.globalAlpha = game.screenFade;
    ctx.fillStyle = T.accent;
    ctx.font = '700 40px system-ui, -apple-system, sans-serif';
    ctx.fillText('ORBIT', view.w / 2, view.h * 0.34);
    ctx.fillText('JUMPER', view.w / 2, view.h * 0.34 + 44);
    ctx.font = '500 15px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = T.dim;
    ctx.fillText(`РЕКОРД ${game.best}`, view.w / 2, view.h * 0.34 + 84);
    // Подсказка дышит, чтобы отличаться от статичного текста.
    ctx.globalAlpha = game.screenFade * (0.55 + 0.45 * Math.sin(Date.now() / 420));
    ctx.fillStyle = T.accent;
    ctx.font = '600 16px system-ui, -apple-system, sans-serif';
    ctx.fillText('ТАПНИ, ЧТОБЫ НАЧАТЬ', view.w / 2, view.h * 0.68);
    ctx.globalAlpha = 1;
    drawGear(T);
    return;
  }

  // Экран поражения.
  ctx.globalAlpha = game.screenFade;
  ctx.fillStyle = T.overlay;
  ctx.fillRect(0, 0, view.w, view.h);
  ctx.fillStyle = T.accent;
  ctx.font = '700 64px system-ui, -apple-system, sans-serif';
  ctx.fillText(String(game.score), view.w / 2, view.h / 2 - 10);
  ctx.font = '500 16px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = T.dim;
  ctx.fillText(`РЕКОРД ${game.best}`, view.w / 2, view.h / 2 + 22);
  ctx.fillStyle = T.accent;
  ctx.font = '600 16px system-ui, -apple-system, sans-serif';
  ctx.fillText('ЕЩЁ РАЗ', view.w / 2, view.h / 2 + 64);
  ctx.globalAlpha = 1;
}

/**
 * Иконка-шестерёнка в правом верхнем углу.
 * @param {ReturnType<typeof theme>} T
 */
function drawGear(T) {
  const r = gearRect();
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const outer = r.w * 0.28;
  const teeth = 8;

  ctx.save();
  ctx.globalAlpha = 0.8 * game.screenFade;
  ctx.strokeStyle = T.accent;
  ctx.fillStyle = T.accent;
  ctx.lineWidth = 2.5;

  // Зубцы.
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    ctx.lineTo(cx + Math.cos(a) * (outer + r.w * 0.11), cy + Math.sin(a) * (outer + r.w * 0.11));
    ctx.stroke();
  }
  // Обод и отверстие.
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, outer * 0.38, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * Прямоугольник со скруглением. Своя реализация вместо ctx.roundRect —
 * та появилась в Safari только в 16.4, а игра должна открываться и на старых.
 * @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r
 */
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Панель настроек поверх текущего кадра.
 * @param {ReturnType<typeof theme>} T
 */
function drawSettings(T) {
  const U = CFG.ui;
  const L = settingsLayout();

  ctx.save();
  ctx.globalAlpha = panel.fade;

  // Затемнение всего кадра под панелью.
  ctx.fillStyle = T.overlay;
  ctx.fillRect(0, 0, view.w, view.h);

  // Сама панель.
  ctx.fillStyle = T.panel;
  roundRect(L.panel.x, L.panel.y, L.panel.w, L.panel.h, U.panelCorner);
  ctx.fill();
  ctx.strokeStyle = T.panelEdge;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = T.accent;
  ctx.font = '700 18px system-ui, -apple-system, sans-serif';
  ctx.fillText('НАСТРОЙКИ', view.w / 2, L.title);

  // Строка «Звук» с переключателем.
  ctx.textAlign = 'left';
  ctx.font = '500 16px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = T.accent;
  ctx.fillText('Звук', L.sound.x, L.sound.y + L.sound.h / 2 + 6);
  drawToggle(L.toggle, settings.sound, T);

  // Заголовок блока тем.
  ctx.font = '500 13px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = T.dim;
  ctx.fillText('ТЕМА', L.sound.x, L.themeLabel);

  for (const chip of L.chips) drawThemeChip(chip, T);

  if (L.menuBtn) drawButton(L.menuBtn, 'В ГЛАВНОЕ МЕНЮ', T, false);
  drawButton(L.closeBtn, 'ЗАКРЫТЬ', T, true);

  ctx.restore();
}

/**
 * Переключатель-пилюля.
 * @param {{x:number,y:number,w:number,h:number}} r
 * @param {boolean} on
 * @param {ReturnType<typeof theme>} T
 */
function drawToggle(r, on, T) {
  const U = CFG.ui;
  ctx.fillStyle = on ? T.accent : T.control;
  roundRect(r.x, r.y, r.w, r.h, r.h / 2);
  ctx.fill();
  if (!on) {
    ctx.strokeStyle = T.panelEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const knobR = U.toggleKnob / 2;
  const pad = (r.h - U.toggleKnob) / 2;
  const cx = on ? r.x + r.w - pad - knobR : r.x + pad + knobR;
  ctx.fillStyle = on ? T.panel : T.accent;
  ctx.beginPath();
  ctx.arc(cx, r.y + r.h / 2, knobR, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Кнопка выбора темы: превью палитры + название, активная обведена акцентом.
 * @param {{id:string,x:number,y:number,w:number,h:number}} chip
 * @param {ReturnType<typeof theme>} T
 */
function drawThemeChip(chip, T) {
  const U = CFG.ui;
  const t = THEMES[chip.id];
  const active = chip.id === getThemeId();

  // Превью фона темы.
  ctx.fillStyle = t.bgGlow;
  roundRect(chip.x, chip.y, chip.w, chip.h, U.chipCorner);
  ctx.fill();
  ctx.strokeStyle = active ? T.accent : T.panelEdge;
  ctx.lineWidth = active ? 2 : 1;
  ctx.stroke();

  // Два кружка палитры планет — превью, а не просто подпись.
  const cy = chip.y + chip.h * 0.36;
  ctx.fillStyle = t.planetPalette[0][0];
  ctx.beginPath();
  ctx.arc(chip.x + chip.w / 2 - 8, cy, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = t.planetPalette[1][0];
  ctx.beginPath();
  ctx.arc(chip.x + chip.w / 2 + 8, cy, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.font = `${active ? '600' : '500'} 12px system-ui, -apple-system, sans-serif`;
  ctx.fillStyle = active ? T.accent : T.dim;
  ctx.fillText(t.name, chip.x + chip.w / 2, chip.y + chip.h - 10);
  ctx.textAlign = 'left';
}

/**
 * Кнопка панели.
 * @param {{x:number,y:number,w:number,h:number}} r
 * @param {string} label
 * @param {ReturnType<typeof theme>} T
 * @param {boolean} primary заливать ли акцентом
 */
function drawButton(r, label, T, primary) {
  ctx.fillStyle = primary ? T.accent : T.control;
  roundRect(r.x, r.y, r.w, r.h, 12);
  ctx.fill();
  if (!primary) {
    ctx.strokeStyle = T.panelEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.font = '600 14px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = primary ? T.panel : T.accent;
  ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 5);
  ctx.textAlign = 'left';
}

// ---------------------------------------------------------------------------
// Ввод
// ---------------------------------------------------------------------------

/**
 * Открыть настройки поверх текущего экрана. С игры — это ещё и пауза.
 */
function openSettings() {
  if (panel.open) return;
  panel.open = true;
  panel.from = game.screen;
}

/** Закрыть настройки и вернуться туда, откуда открыли. */
function closeSettings() {
  panel.open = false;
}

/**
 * Тап. Координаты — в CSS-пикселях канваса; null означает клавиатуру.
 * @param {number|null} x
 * @param {number|null} y
 */
function onTap(x, y) {
  // Аудио разблокируется только из реального жеста пользователя.
  sfx.unlock();

  if (panel.open) {
    if (x === null) return; // клавиатурный «прыжок» на паузе игнорируем
    handleSettingsTap(x, y);
    return;
  }

  // Шестерёнка доступна и в меню, и в игре (на экране поражения её нет).
  if (x !== null && (game.screen === SCREEN_MENU || game.screen === SCREEN_PLAY) && hit(gearRect(), x, y)) {
    openSettings();
    return;
  }

  if (game.screen === SCREEN_MENU) {
    startRun();
  } else if (game.screen === SCREEN_PLAY) {
    if (player.state === STATE_ORBIT) player.jump();
  } else {
    startRun();
  }
}

/**
 * Разбор тапа по панели настроек.
 * @param {number} x
 * @param {number} y
 */
function handleSettingsTap(x, y) {
  const L = settingsLayout();

  // Тап мимо панели — то же самое, что «Закрыть».
  if (!hit(L.panel, x, y)) {
    closeSettings();
    return;
  }

  // Вся строка «Звук» кликабельна, не только сама пилюля: так проще пальцем.
  if (hit(L.sound, x, y)) {
    settings.sound = !settings.sound;
    sfx.setEnabled(settings.sound);
    saveSettings(settings);
    if (settings.sound) {
      sfx.unlock();
      sfx.land(); // короткое подтверждение, что звук снова есть
    }
    return;
  }

  for (const chip of L.chips) {
    if (!hit(chip, x, y)) continue;
    settings.theme = setTheme(chip.id); // применяется мгновенно, в том числе на паузе
    saveSettings(settings);
    return;
  }

  if (L.menuBtn && hit(L.menuBtn, x, y)) {
    closeSettings();
    goToMenu();
    return;
  }

  if (hit(L.closeBtn, x, y)) closeSettings();
}

// ---------------------------------------------------------------------------
// Главный цикл
// ---------------------------------------------------------------------------

let last = 0;
let acc = 0;

/**
 * Главный цикл: рендер по rAF, физика — фиксированным шагом с аккумулятором.
 * @param {number} now метка времени rAF, мс
 */
function frame(now) {
  const raw = last === 0 ? 0 : (now - last) / 1000;
  last = now;
  const dtReal = Math.min(raw, CFG.physics.maxFrame);

  // Fade панели и экранов идёт по реальному времени: анимация обязана
  // работать и на паузе, когда физика стоит.
  const panelStep = dtReal / CFG.ui.panelFadeTime;
  panel.fade = panel.open
    ? Math.min(1, panel.fade + panelStep)
    : Math.max(0, panel.fade - panelStep);
  game.screenFade = Math.min(1, game.screenFade + dtReal / CFG.ui.fadeTime);

  // На паузе время в аккумулятор не капает — после закрытия панели
  // физика продолжится с того же кадра, без рывка наверстывания.
  if (!isPaused()) {
    acc += dtReal;
    while (acc >= CFG.physics.step) {
      update(CFG.physics.step);
      acc -= CFG.physics.step;
    }
  }

  render();
  requestAnimationFrame(frame);
}

// Отладочный хук: удобно щупать состояние из консоли и из автотестов.
window.__oj = {
  game, player, spawner, camera, view, settings, panel, sfx, particles,
  openSettings, closeSettings, settingsLayout, gearRect, onTap, startRun, goToMenu,
};

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
new Input(canvas, onTap, () => (panel.open ? closeSettings() : openSettings()));

resize();
goToMenu();
requestAnimationFrame(frame);
