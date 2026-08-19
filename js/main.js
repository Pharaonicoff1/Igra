import {
  CFG, TRAP, effectiveMaxJumpDistance, spinBoostFactor, scoreSpeedBonus,
  theme, getSkinId, getThemeId,
} from './config.js';
import { Player, STATE_ORBIT, STATE_FLY } from './player.js';
import { Planet } from './planet.js';
import { Spawner } from './spawner.js';
import { Camera } from './camera.js';
import { Particles } from './particles.js';
import { Input } from './input.js';
import { Sfx } from './audio.js';
import { loadBest, saveBest, loadSettings, saveSettings, loadShards, addShards } from './storage.js';
import { Shop } from './shop.js';
import { ASSETS, preloadAssets, aspectOf } from './assets.js';

/** @type {HTMLCanvasElement} */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const view = { w: 0, h: 0, dpr: 1 };
const camera = new Camera();
const spawner = new Spawner();
const player = new Player();
const particles = new Particles();
const sfx = new Sfx();
const shop = new Shop();

/**
 * Экраны в одном канвасе. INTRO — влёт камеры из меню в игру: мир уже живой
 * и цепочка уже построена, но тапы ещё не считаются прыжками.
 */
const SCREEN_MENU = 'menu';
const SCREEN_INTRO = 'intro';
const SCREEN_PLAY = 'play';
const SCREEN_OVER = 'over';
/** Магазин и перелёты к нему и обратно — те же кинематографичные, что и влёт. */
const SCREEN_TO_SHOP = 'toShop';
const SCREEN_SHOP = 'shop';
const SCREEN_TO_MENU = 'toMenu';

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
  /**
   * Космические осколки. Мета-валюта: живёт в storage между запусками и НЕ
   * обнуляется смертью, поэтому resetWorld() её не трогает.
   */
  shards: loadShards(),
  /** Всплывающее «+N» в точке посадки: остаток жизни, сумма и место. */
  shardPopup: { t: 0, amount: 0, x: 0, y: 0 },
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
  /** Прогресс fade лого и кнопок меню, 1 — видимы. Гаснут при старте игры. */
  menuUiFade: 1,
  /** Сколько длится текущий влёт из меню, с. Предохранитель от зависания. */
  introT: 0,
  /** Часы оформления меню, с. По ним идёт парение логотипа. */
  menuT: 0,
};

/**
 * Сцена главного меню: своя декоративная планета со своим космонавтом.
 * Это отдельные объекты, а не первая игровая планета — так меню не зависит
 * от того, что сгенерировал спавнер, а игровой мир не приходится подгонять
 * под вёрстку меню.
 * @type {{planet: Planet|null, player: Player}}
 */
const menu = {
  planet: null,
  player: new Player(),
};
menu.player.decorative = true;

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
const safe = { top: 0, bottom: 0, left: 0 };

/** Три слоя звёзд для параллакса. @type {{factor:number,alpha:number,tileH:number,stars:{x:number,y:number,r:number}[]}[]} */
let starLayers = [];

// Тема и скин берутся из магазина (что куплено и экипировано), а не из
// настроек: в настройках выбора темы по-прежнему нет. Старый settings.theme
// мигрирует во владение внутри storage.loadShop().
shop.applyEquipped();
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
  safe.left = parseFloat(css.getPropertyValue('--sal')) || 0;

  buildStars();

  // Сцена меню привязана к размеру экрана (и по позиции планеты, и по камере),
  // поэтому пересобирается на каждый resize/поворот.
  buildMenuScene();
  if (game.screen === SCREEN_MENU) snapCameraToMenu();

  // Сцена магазина висит от менюшной по X (offsetX * ширина экрана) — тоже
  // пересобирается, иначе после поворота экрана уедет мимо своей планеты.
  if (shop.planet) {
    shop.buildScene(menu.planet, view);
    if (game.screen === SCREEN_SHOP) {
      const p = shop.cameraPosition(view);
      camera.x = p.x;
      camera.y = p.y;
      camera.scale = 1;
      camera.targetScale = 1;
    }
  }
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
 * Экраны, на которых видны декоративные сцены (меню и магазин) и работают
 * перелёты между ними. Игра на них не идёт.
 * @param {string} screen
 * @returns {boolean}
 */
function isSceneScreen(screen) {
  return screen === SCREEN_MENU || screen === SCREEN_TO_SHOP
    || screen === SCREEN_SHOP || screen === SCREEN_TO_MENU;
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

/**
 * Собрать сцену меню и поставить камеру на неё.
 *
 * Декоративная планета стоит НИЖЕ стартовой игровой ровно на riseFactor высот
 * экрана — отсюда и берётся дистанция влёта. Вызывается после resetWorld(),
 * когда позиция стартовой планеты уже известна, и повторно на resize.
 */
function buildMenuScene() {
  const M = CFG.menu;
  const first = spawner.planets[0];
  if (!first) return;

  const x = first.x;
  const y = first.y + view.h * M.riseFactor;
  const r = view.h * M.planetRadiusRatio;

  if (!menu.planet) {
    menu.planet = new Planet({ x, y, r, omega: M.planetOmega });
    // Ловушек на ней нет по умолчанию — планета чисто декоративная.
    // Атмосферный ободок делает из неё «горизонт», а метка вращения на таком
    // радиусе читается пятном-дефектом, поэтому выключена.
    menu.planet.atmosphere = M.planetAtmosphere;
    menu.planet.showSurfaceMark = false;
    menu.player.attach(menu.planet, -Math.PI / 2);
  } else {
    menu.planet.x = x;
    menu.planet.y = y;
    // r — доля от view.h (см. CFG.menu.planetRadiusRatio), поэтому обязан
    // пересчитываться и здесь: resize/поворот экрана меняет view.h так же,
    // как первый вызов при старте.
    menu.planet.r = r;
    menu.player.syncOrbitPosition();
  }
}

/**
 * Точка обзора меню: декоративная планета по центру экрана, зум 1:1.
 * @returns {{x:number,y:number}} мировые координаты левого верхнего угла кадра
 */
function menuCameraPosition() {
  return {
    x: menu.planet.x - view.w / 2,
    y: menu.planet.y - view.h * CFG.menu.planetScreenY,
  };
}

/** Поставить камеру на сцену меню (мгновенно, без подъезда). */
function snapCameraToMenu() {
  if (!menu.planet) return;
  const p = menuCameraPosition();
  camera.scale = 1;
  camera.targetScale = 1;
  camera.x = p.x;
  camera.y = p.y;
}

/** Уйти в главное меню: мир пересобирается и живёт фоном, игра не идёт. */
function goToMenu() {
  resetWorld();
  buildMenuScene();
  // resetWorld() поставил камеру на игровой кадр — уводим её вниз, на сцену меню.
  snapCameraToMenu();
  camera.endCinematic();
  game.menuUiFade = 1;
  setScreen(SCREEN_MENU);
}

/**
 * Старт игры из меню: влёт камеры вверх, к стартовой планете.
 *
 * Мир пересобирается ДО начала перелёта (цепочка, счётчики, буст), поэтому во
 * время полёта ничего не догружается. Цель перелёта — игровой кадр, который
 * resetWorld() уже вычислил: запоминаем его, возвращаем камеру вниз на сцену
 * меню и отдаём общему механизму flyCameraTo.
 */
function startRun() {
  resetWorld();
  const target = { x: camera.x, y: camera.y, scale: camera.scale };
  buildMenuScene();
  snapCameraToMenu();
  camera.flyCameraTo(target.x, target.y, target.scale, CFG.camera.introSmoothTime);
  game.introT = 0;
  game.menuUiFade = 1; // гаснет за uiFadeTime уже во время влёта
  setScreen(SCREEN_INTRO);
}

/**
 * Перелёт из меню в магазин. Тот же механизм, что и влёт в игру, только цель —
 * декоративная сцена сбоку, а не игровой кадр сверху.
 */
function goToShop() {
  shop.buildScene(menu.planet, view);
  const p = shop.cameraPosition(view);
  camera.flyCameraTo(p.x, p.y, 1, CFG.shop.flyTime);
  game.introT = 0;
  game.menuUiFade = 1; // лого и кнопки меню гаснут по дороге
  setScreen(SCREEN_TO_SHOP);
}

/** Обратный перелёт из магазина в меню — симметрично. */
function leaveShop() {
  // Просмотр мог временно включить некупленную тему — возвращаем экипированную.
  shop.restoreEquipped();
  const p = menuCameraPosition();
  camera.flyCameraTo(p.x, p.y, 1, CFG.shop.flyTime);
  game.introT = 0;
  setScreen(SCREEN_TO_MENU);
}

/**
 * Общий шаг перелёта между сценами: доехали — переключаем экран.
 * @param {number} dtReal секунды реального времени
 * @param {string} nextScreen куда переходим по прилёте
 * @param {() => void} [onArrive] что сделать в момент прилёта
 */
function updateSceneFlight(dtReal, nextScreen, onArrive) {
  const S = CFG.shop;
  game.introT += dtReal;
  if (!camera.flightArrived(S.arriveDist) && game.introT < S.flyMaxTime) return;
  camera.endCinematic();
  if (onArrive) onArrive();
  setScreen(nextScreen);
}

/** Мгновенный старт без влёта — с экрана поражения («ещё раз»). */
function restartRun() {
  resetWorld();
  buildMenuScene();
  game.menuUiFade = 0;
  setScreen(SCREEN_PLAY);
}

/**
 * Влёт закончен, когда камера доехала до своего игрового кадра. Порог в
 * мировых px, плюс предохранитель по времени: подвиснуть в неинтерактивном
 * состоянии игра не имеет права ни при каких условиях.
 * @param {number} dtReal секунды реального времени
 */
function updateIntro(dtReal) {
  game.introT += dtReal;
  if (!camera.flightArrived(CFG.menu.arriveDist) && game.introT < CFG.menu.introMaxTime) return;

  camera.endCinematic();
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
  // Астероид — необязательная боковая цель, а не звено маршрута: он не даёт
  // ни очков, ни прогресса сложности, только осколки. Иначе крюк в сторону
  // разгонял бы кривую сложности, которая должна отражать движение ВПЕРЁД.
  if (planet.asteroid) {
    awardShards(planet);
    armSpinBoost(planet);
    sfx.land();
    particles.landingDust(planet, player.x, player.y, game.particleEnergy);
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
    awardShards(planet);
  }

  armSpinBoost(planet);
  sfx.land();
  particles.landingDust(planet, player.x, player.y, game.particleEnergy);
};

/**
 * Целое в диапазоне [a, b], обе границы включительно.
 * @param {number} a @param {number} b
 * @returns {number}
 */
function randomInt(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

/**
 * Начислить осколки за посадку и дать обратную связь.
 *
 * Пишем в storage СРАЗУ, а не в конце забега: смерть не должна съедать уже
 * заработанное. Астероид платит заметно больше обычной планеты — ради этого
 * и стоит сходить с маршрута.
 *
 * @param {import('./planet.js').Planet} planet тело, на которое сели
 */
function awardShards(planet) {
  const S = CFG.shards;
  let amount = 0;

  if (planet.asteroid) {
    if (planet.shardsTaken) return; // повторный визит на тот же астероид не платит
    planet.shardsTaken = true;
    amount = randomInt(S.asteroidMin, S.asteroidMax);
  } else if (Math.random() < S.planetChance) {
    amount = randomInt(S.planetMin, S.planetMax);
  }
  if (amount <= 0) return;

  game.shards = addShards(amount);

  // Всплеск летит из точки посадки к счётчику в HUD — обе точки экранные,
  // поэтому мировые координаты космонавта переводим в экранные.
  const from = worldToScreen(player.x, player.y);
  const to = shardCounterPos();
  particles.shardGain(from.x, from.y, to.x, to.y);

  game.shardPopup.t = S.popupTime;
  game.shardPopup.amount = amount;
  game.shardPopup.x = from.x;
  game.shardPopup.y = from.y;

  // Вибро уважает общий тумблер звука: отдельного переключателя нет, и тихий
  // режим логично понимать как «игра меня не трогает».
  if (settings.sound && navigator.vibrate) navigator.vibrate(CFG.haptics.shard);
}

/**
 * Мировые координаты -> экранные. Ровно та же трансформация, что в render().
 * @param {number} x @param {number} y
 * @returns {{x:number,y:number}}
 */
function worldToScreen(x, y) {
  const s = camera.scale;
  return { x: (x - camera.x) * s, y: (y - camera.y) * s };
}

/**
 * Экранная позиция счётчика осколков в HUD — цель для частиц.
 * @returns {{x:number,y:number}}
 */
function shardCounterPos() {
  const S = CFG.shards;
  return { x: S.hudX + S.hudIconR, y: safe.top + S.hudY };
}

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

  for (const planet of spawner.landables) {
    if (planet.lava.length === 0) continue;
    if (planet.x + planet.r < left || planet.x - planet.r > right) continue;
    if (planet.y + planet.r < top || planet.y - planet.r > bottom) continue;

    planet.emberT += dt;
    const period = P.lava.periodPerZone / planet.lava.length;
    while (planet.emberT >= period) {
      planet.emberT -= period;
      // Угольки — только у лавовых секторов. Лоза — не огонь, и оранжевая
      // искра на зелёной дуге читалась бы как лава там, где её нет.
      const zone = planet.lava[(Math.random() * planet.lava.length) | 0];
      if (zone.kind === TRAP.VINE) continue;
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
  // Сцена меню крутится всегда, пока она видна: и на самом меню, и во время
  // любого перелёта, когда планета меню проезжает через кадр.
  if (isSceneScreen(game.screen) || game.screen === SCREEN_INTRO) {
    if (menu.planet) {
      menu.planet.update(dt);
      menu.player.update(dt, []);
    }
    shop.update(dt);
  }

  // Магазин и перелёты к нему: игры нет, спавнер стоит.
  if (game.screen === SCREEN_SHOP || game.screen === SCREEN_TO_SHOP
      || game.screen === SCREEN_TO_MENU) {
    for (const p of spawner.planets) p.update(dt);
    // Камера двигается ТОЛЬКО во время самого перелёта. На статичном
    // SCREEN_SHOP камера не должна пересчитываться вовсе: flyTarget к этому
    // моменту уже снят (endCinematic при прилёте), а desiredPosition() без
    // него откатится к устаревшей паре anchor/next от игрового кадра и
    // утащит камеру прочь от сцены магазина — ровно так же, как на MENU
    // камера стоит неподвижно, не вызывая camera.update().
    if (game.screen === SCREEN_TO_SHOP || game.screen === SCREEN_TO_MENU) {
      camera.update(dt, player, view);
    }
    return;
  }

  // На меню мир живёт только визуально: планеты и космонавт крутятся,
  // спавнер и камера стоят — это фон под логотипом, а не игра.
  if (game.screen === SCREEN_MENU) {
    for (const p of spawner.planets) p.update(dt);
    player.update(dt, []);
    return;
  }

  // Влёт: мир уже настоящий и живой (планеты крутятся, космонавт на орбите),
  // но прыжков нет — тапы игнорируются до конца перелёта. Спавнер не трогаем:
  // цепочка построена до старта влёта, догружать во время полёта нечего.
  if (game.screen === SCREEN_INTRO) {
    for (const p of spawner.planets) p.update(dt);
    player.update(dt, spawner.landables);
    updateScoreSpeed();
    particles.update(dt);
    camera.update(dt, player, view);
    return;
  }

  if (game.screen !== SCREEN_PLAY) return;

  player.update(dt, spawner.landables);

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
  updateScoreSpeed();
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
 * Обновить бонус скорости вращения от очков на ВСЕХ активных планетах —
 * не только на той, где стоит игрок, иначе мир визуально рассинхронится:
 * непосещённые планеты крутились бы медленнее, чем та, что под игроком.
 * В генерацию и валидатор не идёт (см. CFG.scoreSpeed) — только на реальную
 * скорость в кадре.
 */
function updateScoreSpeed() {
  const factor = scoreSpeedBonus(game.score);
  for (const p of spawner.landables) p.setScoreBoost(factor);
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
 * Прямоугольник логотипа в экранных координатах.
 *
 * Вписан «contain» по ДВУМ измерениям, не только по ширине:
 *  - ширина ограничена долей экрана с потолком (logoWidthRatio/logoMaxWidth);
 *  - высота ограничена РЕАЛЬНО ДОСТУПНЫМ местом между низом логотипа и
 *    атмосферой декоративной планеты (которая сама пропорциональна view.h).
 * На узком, но невысоком экране ширинное ограничение в одиночку давало
 * логотип, который вместе с кнопками утаскивал их в свечение планеты —
 * см. комментарий у CFG.menu.glowMargin. Побеждает более тесное ограничение;
 * если высота стала лимитирующей, ширина пересчитывается из неё, чтобы
 * пропорции файла остались точными в любом случае.
 *
 * Пока файл не загружен, высота берётся из запасного соотношения в конфиге,
 * чтобы вёрстка ниже стояла на месте до его появления.
 *
 * bottom — низ ЗАРЕЗЕРВИРОВАННОГО места без учёта парения: разделитель и
 * строка статистики под ним не должны качаться вместе с логотипом.
 *
 * @returns {{x:number, y:number, w:number, h:number, bottom:number}}
 */
function logoBox() {
  const M = CFG.menu;
  const top = safe.top + M.logoTop;

  // Доступная высота — от низа логотипа до безопасного запаса над атмосферой,
  // за вычетом всего, что стоит МЕЖДУ логотипом и кнопками (статистика,
  // зазор) и самого блока кнопок. planet.r уже пропорционален view.h
  // (см. CFG.menu.planetRadiusRatio) — до первого buildMenuScene() планеты
  // ещё нет, тогда считаем радиус по той же формуле для консистентности.
  const r = menu.planet ? menu.planet.r : view.h * M.planetRadiusRatio;
  const glowTop = view.h - r * CFG.planet.atmosphere.spread;
  const buttonsBlockH = M.buttonHeight * 2 + M.buttonGap;
  const reserved = M.statsY + M.buttonsGap + buttonsBlockH + M.glowMargin;
  const maxH = Math.max(glowTop - top - reserved, M.logoMinHeight);

  const maxW = Math.min(view.w * M.logoWidthRatio, M.logoMaxWidth);
  const aspect = aspectOf(ASSETS.logo, M.logoAspectFallback);
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }

  // Парение: медленная синусоида с периодом logoBobPeriod.
  const bob = Math.sin((game.menuT / M.logoBobPeriod) * Math.PI * 2) * M.logoBobAmp;
  return { x: (view.w - w) / 2, y: top + bob, w, h, bottom: top + h };
}

/**
 * Раскладка кнопок главного меню. Две кнопки в столбик под планетой.
 * @returns {{play:{x:number,y:number,w:number,h:number},
 *   shop:{x:number,y:number,w:number,h:number}}}
 */
function menuLayout() {
  const M = CFG.menu;
  const w = Math.min(M.buttonWidth, view.w - M.buttonSideMargin * 2);
  const x = (view.w - w) / 2;
  // Верх блока — от РЕАЛЬНОЙ геометрии логотипа (аспект конкретного файла),
  // а не от доли экрана: см. комментарий у CFG.menu.buttonsGap.
  const top = logoBox().bottom + M.statsY + M.buttonsGap;
  return {
    play: { x, y: top, w, h: M.buttonHeight },
    shop: { x, y: top + M.buttonHeight + M.buttonGap, w, h: M.buttonHeight },
  };
}

/**
 * Раскладка панели настроек.
 * @returns {{panel:{x:number,y:number,w:number,h:number}, title:number,
 *   sound:{x:number,y:number,w:number,h:number}, toggle:{x:number,y:number,w:number,h:number},
 *   menuBtn:{x:number,y:number,w:number,h:number}|null,
 *   closeBtn:{x:number,y:number,w:number,h:number}}}
 */
function settingsLayout() {
  const U = CFG.ui;
  const showMenuBtn = panel.from === SCREEN_PLAY;
  const w = Math.min(U.panelMaxWidth, view.w - U.panelSideMargin * 2);
  const inner = w - U.panelPadding * 2;

  const titleH = 38;
  const buttons = showMenuBtn ? 2 : 1;
  const buttonsH = buttons * U.buttonHeight + (buttons - 1) * U.buttonGap;
  const h = U.panelPadding * 2 + titleH + U.rowHeight + U.settingsGap + buttonsH;

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
  cursor += U.rowHeight + U.settingsGap;

  let menuBtn = null;
  if (showMenuBtn) {
    menuBtn = { x: x + U.panelPadding, y: cursor, w: inner, h: U.buttonHeight };
    cursor += U.buttonHeight + U.buttonGap;
  }
  const closeBtn = { x: x + U.panelPadding, y: cursor, w: inner, h: U.buttonHeight };

  return { panel: { x, y, w, h }, title, sound, toggle, menuBtn, closeBtn };
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
  // Сцена меню рисуется тем же кодом, что и игровые планеты. На влёте она
  // остаётся в кадре и уезжает вниз — это и делает переход одним движением,
  // а не склейкой двух картинок.
  if ((isSceneScreen(game.screen) || game.screen === SCREEN_INTRO) && menu.planet) {
    menu.planet.draw(ctx, s);
    menu.player.draw(ctx, 0, s);
  }
  // Сцена магазина видна и на самом магазине, и на обоих перелётах — так
  // переход читается одним движением камеры, а не подменой картинки.
  if (isSceneScreen(game.screen) && shop.planet) {
    shop.planet.draw(ctx, s);
    shop.player.draw(ctx, 0, s);
  }
  for (const p of spawner.landables) p.draw(ctx, s);
  player.draw(ctx, effectiveMaxJumpDistance(game.planetsPassed), s);
  // Мировые частицы — внутри той же трансформации, размер компенсирован зумом.
  particles.drawWorld(ctx, s);
  ctx.restore();

  drawLavaVignette(T);
  drawHud(T);
  drawBuildTag(T);
  // UI-частицы: экранные координаты, уже вне трансформации мира.
  particles.drawUi(ctx);
  if (panel.fade > 0) drawSettings(T);
}

/**
 * Метка сборки в левом нижнем углу. Видна на любом экране и не гасится
 * фейдами переходов — её единственная задача диагностическая: дать понять,
 * какая версия кода сейчас реально запущена (актуально после случая, когда
 * забытый git push выглядел как регрессия вёрстки).
 * @param {ReturnType<typeof theme>} T
 */
function drawBuildTag(T) {
  const B = CFG.build;
  ctx.save();
  ctx.globalAlpha = B.alpha;
  ctx.fillStyle = T.dim;
  ctx.font = `${B.fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(B.label, safe.left + B.margin, view.h - safe.bottom - B.margin);
  ctx.restore();
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
    drawShardHud(T);
    drawAsteroidRadar(T);
    drawGear(T);
    return;
  }

  if (game.screen === SCREEN_MENU || game.screen === SCREEN_INTRO
      || game.screen === SCREEN_TO_SHOP) {
    drawMenuUi(T);
    return;
  }

  if (game.screen === SCREEN_SHOP) {
    shop.draw(game.screenFade);
    return;
  }

  // Обратный перелёт: интерфейс магазина уже погашен, меню ещё не проявилось.
  if (game.screen === SCREEN_TO_MENU) return;

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
 * Иконка-кристалл: ромб с холодным свечением. Один рисовальщик и для HUD,
 * и для меню — иначе валюта выглядела бы двумя разными предметами.
 * @param {number} cx @param {number} cy центр
 * @param {number} r радиус (половина высоты ромба), px
 * @param {ReturnType<typeof theme>} T
 */
function drawShardIcon(cx, cy, r, T) {
  ctx.save();
  // Свечение — отдельный полупрозрачный ромб побольше, без shadowBlur.
  ctx.fillStyle = T.shardGlow;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 1.6);
  ctx.lineTo(cx + r * 1.1, cy);
  ctx.lineTo(cx, cy + r * 1.6);
  ctx.lineTo(cx - r * 1.1, cy);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = T.shard;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r * 0.66, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r * 0.66, cy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Счётчик осколков в игре: компактный, в левом верхнем углу. Намеренно мельче
 * счёта — валюта копится фоном и не должна перетягивать внимание с забега.
 * @param {ReturnType<typeof theme>} T
 */
function drawShardHud(T) {
  const S = CFG.shards;
  const x = S.hudX;
  const y = safe.top + S.hudY;

  ctx.save();
  ctx.globalAlpha = game.screenFade;
  drawShardIcon(x + S.hudIconR, y, S.hudIconR, T);
  ctx.textAlign = 'left';
  ctx.font = '600 15px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = T.accent;
  ctx.fillText(String(game.shards), x + S.hudIconR * 2 + S.hudIconGap, y + 5);
  ctx.restore();

  drawShardPopup(T);
}

/**
 * Всплывающее «+N» в точке посадки: поднимается и гаснет.
 * @param {ReturnType<typeof theme>} T
 */
function drawShardPopup(T) {
  const S = CFG.shards;
  const p = game.shardPopup;
  if (p.t <= 0) return;

  const k = 1 - p.t / S.popupTime;              // 0 -> 1 по ходу жизни
  const alpha = k < S.popupFadeFrom ? 1 : 1 - (k - S.popupFadeFrom) / (1 - S.popupFadeFrom);

  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha) * game.screenFade;
  ctx.textAlign = 'center';
  ctx.font = '700 18px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = T.shard;
  ctx.fillText(`+${p.amount}`, p.x, p.y - k * S.popupRise);
  ctx.restore();
}

/**
 * Радар: указатель на кромке экрана, пока астероид существует, но не виден.
 *
 * Кадр под астероид намеренно НЕ расширяется (зум подобран под маршрут), так
 * что боковая цель часто оказывается за кромкой. Без указателя игрок просто
 * не узнает, что рядом есть бонус.
 * @param {ReturnType<typeof theme>} T
 */
function drawAsteroidRadar(T) {
  const A = CFG.asteroid;
  for (const a of spawner.asteroids) {
    const p = worldToScreen(a.x, a.y);
    const r = a.r * camera.scale;
    // Виден целиком или частично — указатель не нужен.
    if (p.x + r > 0 && p.x - r < view.w && p.y + r > 0 && p.y - r < view.h) continue;

    // Точка на кромке экрана в направлении астероида от центра кадра.
    const cx = view.w / 2;
    const cy = view.h / 2;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const halfW = view.w / 2 - A.radarMargin;
    const halfH = view.h / 2 - A.radarMargin;
    // Масштаб до пересечения с прямоугольником кромки — по большей из осей.
    const t = Math.min(halfW / Math.abs(dx || 1e-6), halfH / Math.abs(dy || 1e-6));
    const ix = cx + dx * t;
    const iy = cy + dy * t;

    ctx.save();
    ctx.globalAlpha = A.radarAlpha * game.screenFade;
    drawShardIcon(ix, iy, A.radarR * 0.7, T);
    // Стрелка наружу: показывает, в какую сторону смотреть.
    ctx.strokeStyle = T.shard;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ix + (dx / len) * A.radarR, iy + (dy / len) * A.radarR);
    ctx.lineTo(ix + (dx / len) * (A.radarR + A.radarArrow),
      iy + (dy / len) * (A.radarR + A.radarArrow));
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Интерфейс главного меню: лого, рекорд, две кнопки, шестерёнка.
 * Всё гаснет вместе (menuUiFade) при старте игры — планета и звёзды остаются,
 * поэтому влёт читается как продолжение той же сцены.
 * @param {ReturnType<typeof theme>} T
 */
function drawMenuUi(T) {
  const M = CFG.menu;
  const alpha = game.screenFade * game.menuUiFade;
  if (alpha <= 0) return;

  const L = menuLayout();
  const cx = view.w / 2;
  const logo = logoBox();

  ctx.save();
  ctx.textAlign = 'center';
  ctx.globalAlpha = alpha;

  // Логотип — растровый ассет в ЭКРАННЫХ координатах: трансформация камеры
  // сюда не приходит, поэтому зум и положение декоративной сцены на него не
  // влияют. Пока файл не загружен, место под него всё равно зарезервировано
  // (см. logoBox), и появление картинки не сдвинет ничего ниже.
  if (ASSETS.logo) {
    // Канвас уже отмасштабирован под devicePixelRatio, поэтому координаты в
    // CSS-пикселях сами дают полное разрешение экрана. Остаётся качество
    // фильтрации: логотип почти всегда УМЕНЬШАЕТСЯ из крупного файла.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(ASSETS.logo, logo.x, logo.y, logo.w, logo.h);
  }

  drawMenuDivider(cx, logo.bottom + M.dividerY, T);
  drawMenuStats(cx, logo.bottom + M.statsY, T);

  drawMenuButton(L.play, 'ИГРАТЬ', T, true, 0);
  drawMenuButton(L.shop, 'МАГАЗИН', T, false, 0);

  ctx.restore();
  drawGear(T, alpha);
}


/**
 * Разделитель под лого: две тонкие линии и ромб-осколок между ними.
 * Ромб повторяет иконку валюты — заголовок и экономика игры перекликаются.
 * @param {number} cx @param {number} y
 * @param {ReturnType<typeof theme>} T
 */
function drawMenuDivider(cx, y, T) {
  const M = CFG.menu;
  const half = M.dividerWidth / 2;

  ctx.save();
  ctx.globalAlpha *= M.dividerAlpha;
  ctx.strokeStyle = T.accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - half, y);
  ctx.lineTo(cx - M.dividerGap, y);
  ctx.moveTo(cx + M.dividerGap, y);
  ctx.lineTo(cx + half, y);
  ctx.stroke();
  ctx.restore();

  const d = M.dividerDiamond;
  ctx.save();
  ctx.fillStyle = T.accent;
  ctx.globalAlpha *= 0.7;
  ctx.beginPath();
  ctx.moveTo(cx, y - d);
  ctx.lineTo(cx + d * 0.66, y);
  ctx.lineTo(cx, y + d);
  ctx.lineTo(cx - d * 0.66, y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Строка статистики: «РЕКОРД N» и осколки в ОДНУ строку, блок центрирован
 * целиком. Двумя строками, как было раньше, титульный блок растягивался и
 * подчёркивал пустоту под собой.
 * @param {number} cx @param {number} y базовая линия
 * @param {ReturnType<typeof theme>} T
 */
function drawMenuStats(cx, y, T) {
  const M = CFG.menu;
  const S = CFG.shards;
  const best = `РЕКОРД ${game.best}`;
  const shards = String(game.shards);

  ctx.font = '500 15px system-ui, -apple-system, sans-serif';
  const bestW = ctx.measureText(best).width;
  ctx.font = '600 16px system-ui, -apple-system, sans-serif';
  const shardsW = ctx.measureText(shards).width;

  const iconW = S.menuIconR * 2 + S.menuIconGap;
  const totalW = bestW + M.statsGap + iconW + shardsW;
  let x = cx - totalW / 2;

  ctx.save();
  ctx.textAlign = 'left';

  ctx.font = '500 15px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = T.dim;
  ctx.fillText(best, x, y);
  x += bestW + M.statsGap;

  drawShardIcon(x + S.menuIconR, y - 5, S.menuIconR, T);
  x += iconW;

  ctx.font = '600 16px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = T.accent;
  ctx.fillText(shards, x, y);
  ctx.restore();
}


/**
 * Кнопка главного меню.
 * @param {{x:number,y:number,w:number,h:number}} r
 * @param {string} label
 * @param {ReturnType<typeof theme>} T
 * @param {boolean} primary заливать ли акцентом
 * @param {number} dx горизонтальный сдвиг (тряска), px
 */
function drawMenuButton(r, label, T, primary, dx) {
  const M = CFG.menu;
  ctx.save();
  // Главная кнопка светится: взгляд обязан падать на «Играть» первым, а не
  // блуждать между двумя одинаковыми по весу прямоугольниками.
  if (primary) {
    ctx.shadowColor = T.accent;
    ctx.shadowBlur = M.playGlow;
  }
  ctx.fillStyle = primary ? T.accent : T.control;
  roundRect(r.x + dx, r.y, r.w, r.h, M.buttonCorner);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = primary ? T.accent : T.panelEdge;
  ctx.lineWidth = 1;
  roundRect(r.x + dx, r.y, r.w, r.h, M.buttonCorner);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.font = '700 17px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = primary ? T.panel : T.accent;
  ctx.fillText(label, r.x + dx + r.w / 2, r.y + r.h / 2 + 6);
}


/**
 * Иконка-шестерёнка в правом верхнем углу.
 * @param {ReturnType<typeof theme>} T
 * @param {number} fade прозрачность; в меню она гаснет вместе с остальным UI,
 *   поэтому берётся снаружи, а не только из game.screenFade
 */
function drawGear(T, fade = game.screenFade) {
  const r = gearRect();
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const outer = r.w * 0.28;
  const teeth = 8;

  ctx.save();
  ctx.globalAlpha = 0.8 * fade;
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
  // Перелёты и магазин неинтерактивны для настроек, включая Escape на
  // десктопе: он приходит мимо onTap, поэтому проверка стоит здесь, а не
  // только в разборе тапа.
  if (game.screen === SCREEN_INTRO || game.screen === SCREEN_TO_SHOP
      || game.screen === SCREEN_TO_MENU || game.screen === SCREEN_SHOP) return;
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

  // Любой перелёт между сценами неинтерактивен целиком. Иначе тап, которым
  // игрок запустил переход (или случайный второй), сработал бы как прыжок или
  // как нажатие на ещё не приехавший интерфейс.
  if (game.screen === SCREEN_INTRO || game.screen === SCREEN_TO_SHOP
      || game.screen === SCREEN_TO_MENU) return;

  if (game.screen === SCREEN_SHOP) {
    if (x === null) return; // клавиатура в магазине ничего не выбирает
    if (shop.handleTap(x, y) === 'back') leaveShop();
    return;
  }

  // Шестерёнка доступна и в меню, и в игре (на экране поражения её нет).
  if (x !== null && (game.screen === SCREEN_MENU || game.screen === SCREEN_PLAY) && hit(gearRect(), x, y)) {
    openSettings();
    return;
  }

  if (game.screen === SCREEN_MENU) {
    handleMenuTap(x, y);
  } else if (game.screen === SCREEN_PLAY) {
    if (player.state === STATE_ORBIT) player.jump();
  } else {
    restartRun();
  }
}

/**
 * Разбор тапа по главному меню. Мимо кнопок — ничего: игра начинается только
 * с «Играть», иначе случайный тап по фону запускал бы раунд.
 * @param {number|null} x null — клавиатура (пробел/enter): считаем за «Играть»
 * @param {number} y
 */
function handleMenuTap(x, y) {
  if (x === null) {
    startRun();
    return;
  }
  const L = menuLayout();
  if (hit(L.play, x, y)) {
    startRun();
    return;
  }
  if (hit(L.shop, x, y)) goToShop();
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

  // Таймеры меню тоже идут по реальному времени: тряска и подпись «Скоро»
  // должны доигрывать независимо от того, что делает физика.

  // «+N» за осколки живёт по реальному времени: это UI, а не физика.
  if (game.shardPopup.t > 0) game.shardPopup.t = Math.max(0, game.shardPopup.t - dtReal);
  // UI меню гаснет на влёте в игру и на перелёте в магазин; на самом меню
  // держится, а по возвращении проявляется обратно.
  if (game.screen === SCREEN_INTRO || game.screen === SCREEN_TO_SHOP) {
    game.menuUiFade = Math.max(0, game.menuUiFade - dtReal / CFG.menu.uiFadeTime);
  } else if (game.screen === SCREEN_MENU) {
    game.menuUiFade = Math.min(1, game.menuUiFade + dtReal / CFG.menu.uiFadeTime);
  }
  game.menuT += dtReal;
  shop.updateUi(dtReal);

  // На паузе время в аккумулятор не капает — после закрытия панели
  // физика продолжится с того же кадра, без рывка наверстывания.
  if (!isPaused()) {
    acc += dtReal;
    while (acc >= CFG.physics.step) {
      update(CFG.physics.step);
      acc -= CFG.physics.step;
    }
    // Проверяем прилёт ПОСЛЕ шагов физики: камера уже сдвинулась в этом кадре.
    if (game.screen === SCREEN_INTRO) updateIntro(dtReal);
    else if (game.screen === SCREEN_TO_SHOP) updateSceneFlight(dtReal, SCREEN_SHOP);
    else if (game.screen === SCREEN_TO_MENU) updateSceneFlight(dtReal, SCREEN_MENU);
  }

  render();
  requestAnimationFrame(frame);
}

// Отладочный хук: удобно щупать состояние из консоли и из автотестов.
window.__oj = {
  game, player, spawner, camera, view, settings, panel, sfx, particles, menu, shop,
  awardShards, worldToScreen, shardCounterPos, effectiveMaxJumpDistance,
  getSkinId, getThemeId,
  openSettings, closeSettings, settingsLayout, menuLayout, gearRect, onTap,
  startRun, restartRun, goToMenu,
  goToShop, leaveShop, logoBox, ASSETS, CFG,
  safeTop: () => safe.top,
  SCREEN_MENU, SCREEN_INTRO, SCREEN_PLAY, SCREEN_OVER,
  SCREEN_TO_SHOP, SCREEN_SHOP, SCREEN_TO_MENU,
};

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
// Магазин рисует себя сам, но общими кистями: канвас, размеры и рисовальщики
// приходят снаружи — импорт из main.js создал бы цикл модулей.
shop.attach({ ctx, view, safe, roundRect, drawShardIcon });

new Input(canvas, onTap, () => (panel.open ? closeSettings() : openSettings()));

// Ассеты грузятся ДО первого кадра: иначе меню на мгновение показало бы
// пустое место вместо логотипа. Промис никогда не отклоняется — недоступный
// файл лишь оставляет своё место пустым, игра запускается в любом случае.
preloadAssets().then(() => {
  resize();
  goToMenu();
  requestAnimationFrame(frame);
});
