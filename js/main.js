import { CFG, effectiveMaxJumpDistance } from './config.js';
import { Player, STATE_ORBIT, STATE_FLY } from './player.js';
import { Spawner } from './spawner.js';
import { Camera } from './camera.js';
import { Input } from './input.js';
import { loadBest, saveBest } from './storage.js';

/** @type {HTMLCanvasElement} */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const view = { w: 0, h: 0, dpr: 1 };
const camera = new Camera();
const spawner = new Spawner();
const player = new Player();

/** Экраны игры. Меню и полноценный game over — следующий этап. */
const SCREEN_PLAY = 'play';
const SCREEN_OVER = 'over';

const game = {
  screen: SCREEN_PLAY,
  score: 0,
  best: loadBest(),
};

/** Три слоя звёзд для параллакса. @type {{factor:number,alpha:number,stars:{x:number,y:number,r:number}[]}[]} */
let starLayers = [];

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
  buildStars();
}

/** Сгенерировать звёзды: плотность задана как «один пиксель звезды на N px² экрана». */
function buildStars() {
  const tileH = view.h * CFG.stars.tileExtra;
  starLayers = CFG.stars.layers.map((layer) => {
    const count = Math.round((view.w * tileH) / layer.density);
    const stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * view.w,
        y: Math.random() * tileH,
        r: layer.rMin + Math.random() * (layer.rMax - layer.rMin),
      });
    }
    return { factor: layer.factor, alpha: layer.alpha, stars, tileH };
  });
}

/** Полный сброс раунда. */
function startRun() {
  game.screen = SCREEN_PLAY;
  game.score = 0;
  const first = spawner.reset(view);
  player.attach(first, -Math.PI / 2);
  camera.snapTo(player.y, view.h);
  spawner.update(0, camera, view, game.score, first);
}

/** Смерть: фиксируем рекорд и уходим на экран поражения. */
function die() {
  if (game.screen !== SCREEN_PLAY) return;
  game.screen = SCREEN_OVER;
  game.best = saveBest(game.score);
  if (navigator.vibrate) navigator.vibrate(CFG.haptics.death);
}

player.onJump = () => {
  if (navigator.vibrate) navigator.vibrate(CFG.haptics.jump);
};

player.onLand = (planet) => {
  camera.shake();
  if (!planet.visited) {
    planet.visited = true;
    game.score += 1;
  }
};

/**
 * Один шаг фиксированной физики.
 * @param {number} dt всегда CFG.physics.step
 */
function update(dt) {
  if (game.screen !== SCREEN_PLAY) return;

  player.update(dt, spawner.planets);

  // Не долетел: дальность полёта достигла потолка (с поправкой на сложность),
  // а посадки не было. Счёт во время полёта не меняется (обновляется только при
  // посадке), поэтому текущий game.score корректно описывает потолок этого прыжка.
  if (player.state === STATE_FLY && player.flightDistance() >= effectiveMaxJumpDistance(game.score)) {
    die();
    return;
  }

  spawner.update(dt, camera, view, game.score, player.planet);
  camera.update(dt, player.y, view.h);

  // Смерть: ушли под экран или далеко за боковую кромку.
  const m = CFG.player.killMargin;
  if (player.y > camera.y + view.h + m || player.x < -m || player.x > view.w + m) die();
}

/** Отрисовка кадра. */
function render() {
  const camY = camera.renderY;

  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

  // Фон: индиго с лёгким свечением к низу экрана.
  const bg = ctx.createLinearGradient(0, 0, 0, view.h);
  bg.addColorStop(0, CFG.colors.bg);
  bg.addColorStop(1, CFG.colors.bgGlow);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, view.w, view.h);

  drawStars(camY);

  // Мир: сдвигаем на камеру (с учётом тряски).
  ctx.save();
  ctx.translate(camera.offsetX, -camY);
  for (const p of spawner.planets) p.draw(ctx);
  player.draw(ctx, effectiveMaxJumpDistance(game.score));
  ctx.restore();

  drawHud();
}

/**
 * Параллакс-звёзды: каждый слой едет со своей долей скорости камеры и зациклен по высоте.
 * @param {number} camY
 */
function drawStars(camY) {
  ctx.fillStyle = CFG.colors.warmWhite;
  for (const layer of starLayers) {
    const off = ((camY * layer.factor) % layer.tileH + layer.tileH) % layer.tileH;
    ctx.globalAlpha = layer.alpha;
    for (const s of layer.stars) {
      let y = s.y - off;
      if (y < 0) y += layer.tileH;
      if (y > view.h) continue;
      ctx.beginPath();
      ctx.arc(s.x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/** Временный отладочный HUD: полноценные три экрана — следующий этап. */
function drawHud() {
  const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0;
  ctx.fillStyle = 'rgba(255,244,226,0.85)';
  ctx.font = '600 44px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(String(game.score), view.w / 2, top + 64);

  ctx.font = '500 14px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = CFG.colors.dim;
  ctx.fillText(`BEST ${game.best}`, view.w / 2, top + 88);

  if (game.screen === SCREEN_OVER) {
    ctx.fillStyle = 'rgba(11,16,38,0.72)';
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.fillStyle = CFG.colors.warmWhite;
    ctx.font = '700 64px system-ui, -apple-system, sans-serif';
    ctx.fillText(String(game.score), view.w / 2, view.h / 2 - 10);
    ctx.font = '500 16px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = CFG.colors.dim;
    ctx.fillText(`BEST ${game.best}`, view.w / 2, view.h / 2 + 22);
    ctx.fillText('ТАПНИ, ЧТОБЫ НАЧАТЬ ЗАНОВО', view.w / 2, view.h / 2 + 64);
  }
}

/** Тап: прыжок в игре, рестарт на экране поражения. */
function onTap() {
  if (game.screen === SCREEN_PLAY) {
    if (player.state === STATE_ORBIT) player.jump();
  } else {
    startRun();
  }
}

let last = 0;
let acc = 0;

/**
 * Главный цикл: рендер по rAF, физика — фиксированным шагом с аккумулятором.
 * @param {number} now метка времени rAF, мс
 */
function frame(now) {
  const raw = last === 0 ? 0 : (now - last) / 1000;
  last = now;
  acc += Math.min(raw, CFG.physics.maxFrame);
  while (acc >= CFG.physics.step) {
    update(CFG.physics.step);
    acc -= CFG.physics.step;
  }
  render();
  requestAnimationFrame(frame);
}

// Отладочный хук: удобно щупать состояние из консоли и из автотестов.
window.__oj = { game, player, spawner, camera, view };

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
new Input(canvas, onTap);

resize();
startRun();
requestAnimationFrame(frame);
