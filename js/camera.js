import { CFG } from './config.js';
import { STATE_ORBIT } from './player.js';

/**
 * Камера центрируется на планете, где стоит игрок, по обеим осям.
 * x/y — мировые координаты ЛЕВОГО ВЕРХНЕГО угла экрана.
 *
 * Тряска намеренно НЕ подмешивается в x/y: она живёт отдельными shakeX/shakeY
 * и складывается с позицией только на этапе рендера. Иначе сглаживание начнёт
 * догонять смещение тряски и размажет её в вялое качание.
 */
export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    /** Аддитивное смещение тряски, применяется только при отрисовке. */
    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeT = 0;
    /** Остаток окна ослабленного сглаживания, с. */
    this.easeT = 0;
    /**
     * Планета, к которой камера едет в текущем полёте (предсказание в момент
     * отрыва). null — предсказание не нашло цели, ведём самого космонавта.
     * @type {import('./planet.js').Planet|null}
     */
    this.flightTarget = null;
  }

  /**
   * Задать цель полёта и мягко «повести взгляд» на неё.
   * @param {import('./planet.js').Planet|null} planet
   */
  setFlightTarget(planet) {
    this.flightTarget = planet;
    this.startEase();
  }

  /**
   * Куда камера хочет смотреть.
   * На планете — её ЦЕНТР: пока космонавт крутится по орбите, цель неподвижна
   * и кадр стоит намертво. В полёте — центр планеты назначения, чтобы игрок
   * заранее видел зону приземления; если цели нет (промах в пустоту) — ведём
   * космонавта, иначе кадр замрёт и смерть будет выглядеть багом.
   * @param {import('./player.js').Player} player
   * @param {{w:number,h:number}} view
   * @returns {{x:number,y:number}} мировая точка, которую держим в центре экрана
   */
  targetFor(player, view) {
    const lookAhead = view.h * CFG.camera.lookAhead;
    if (player.state === STATE_ORBIT && player.planet) {
      return { x: player.planet.x, y: player.planet.y - lookAhead };
    }
    if (this.flightTarget) {
      return { x: this.flightTarget.x, y: this.flightTarget.y - lookAhead };
    }
    return { x: player.x, y: player.y - lookAhead };
  }

  /**
   * Поставить камеру в целевую точку мгновенно — старт и рестарт не должны
   * начинаться с подъезда камеры.
   * @param {{x:number,y:number}} target
   * @param {{w:number,h:number}} view
   */
  snapTo(target, view) {
    this.x = target.x - view.w / 2;
    this.y = target.y - view.h / 2;
    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeT = 0;
    this.easeT = 0;
    this.flightTarget = null;
  }

  /**
   * Текущий коэффициент сглаживания. После подмены цели он занижен и
   * возвращается к базовому по ease-out: цель скачком уезжает на дальнюю
   * планету, и жёсткое сглаживание читалось бы как рывок.
   * @returns {number}
   */
  currentSmooth() {
    const C = CFG.camera;
    if (this.easeT <= 0) return C.smooth;
    const k = 1 - this.easeT / C.jumpSmoothTime; // 0 в момент подмены -> 1 в конце
    const eased = 1 - (1 - k) * (1 - k);         // ease-out
    return C.jumpSmooth + (C.smooth - C.jumpSmooth) * eased;
  }

  /** Открыть окно ослабленного сглаживания. */
  startEase() {
    this.easeT = CFG.camera.jumpSmoothTime;
  }

  /**
   * @param {number} dt секунды фиксированного шага
   * @param {{x:number,y:number}} target мировая точка, которую держим в центре
   * @param {{w:number,h:number}} view
   */
  update(dt, target, view) {
    const wantX = target.x - view.w / 2;
    const wantY = target.y - view.h / 2;

    if (this.easeT > 0) this.easeT = Math.max(0, this.easeT - dt);

    // Экспоненциальное сглаживание, не зависящее от частоты кадров: коэффициент
    // задан для 60 FPS, на просадках камера не дёргается.
    const t = 1 - Math.pow(1 - this.currentSmooth(), dt * 60);
    let dx = (wantX - this.x) * t;
    let dy = (wantY - this.y) * t;

    // Потолок скорости: на респавне и длинных прыжках камера не телепортируется.
    const maxStep = CFG.camera.maxSpeed * dt;
    const len = Math.hypot(dx, dy);
    if (len > maxStep && len > 0) {
      dx = (dx / len) * maxStep;
      dy = (dy / len) * maxStep;
    }

    this.x += dx;
    this.y += dy;

    this.updateShake(dt);
  }

  /**
   * Не дать космонавту выпасть за кадр. Камера уезжает к планете назначения
   * раньше, чем игрок долетает, и на самых длинных прыжках он отстаёт —
   * здесь позиция камеры подтягивается назад ровно настолько, чтобы космонавт
   * остался в кадре с отступом. Вызывать только в полёте: на планете это
   * сдвинуло бы неподвижный кадр.
   * @param {import('./player.js').Player} player
   * @param {{w:number,h:number}} view
   */
  clampToPlayer(player, view) {
    const m = CFG.camera.playerMargin;
    const minX = player.x - view.w + m;
    const maxX = player.x - m;
    const minY = player.y - view.h + m;
    const maxY = player.y - m;
    if (this.x < minX) this.x = minX;
    if (this.x > maxX) this.x = maxX;
    if (this.y < minY) this.y = minY;
    if (this.y > maxY) this.y = maxY;
  }

  /**
   * @param {number} dt
   */
  updateShake(dt) {
    if (this.shakeT > 0) {
      this.shakeT = Math.max(0, this.shakeT - dt);
      const amp = CFG.camera.shakeAmp * (this.shakeT / CFG.camera.shakeTime);
      this.shakeX = (Math.random() * 2 - 1) * amp;
      this.shakeY = (Math.random() * 2 - 1) * amp;
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  /** Короткий шейк при приземлении. */
  shake() {
    this.shakeT = CFG.camera.shakeTime;
  }
}
