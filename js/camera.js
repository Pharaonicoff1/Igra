import { CFG, DEV } from './config.js';
import { STATE_ORBIT } from './player.js';

/**
 * Камера с переменным зумом.
 *
 * Кадр обязан удовлетворять двум условиям сразу: планета игрока прижата к низу
 * экрана, а следующая планета видна целиком вместе с ловушками. На длинных
 * прыжках это конфликт, поэтому камера отъезжает (scale < 1).
 *
 * x/y — мировые координаты левого верхнего угла ВИДИМОЙ области; при scale < 1
 * она больше экрана: view.w / scale на view.h / scale.
 * Экранная точка = (мир - camera) * scale.
 *
 * Тряска намеренно НЕ подмешивается в x/y: она живёт отдельно и складывается
 * с позицией только при рендере, иначе сглаживание её размажет.
 */
export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    /** Текущий (сглаженный) зум и цель, к которой он едет. */
    this.scale = 1;
    this.targetScale = 1;

    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeT = 0;
    /** Остаток окна ослабленного сглаживания позиции, с. */
    this.easeT = 0;

    /**
     * Режим влёта из меню: камера едет к игровому кадру издалека.
     * Держится до тех пор, пока вызывающий код не скажет endCinematic() —
     * в отличие от introT, который отмеряет только окно завышенного сглаживания.
     */
    this.cinematic = false;
    /** Остаток окна завышенного сглаживания на влёте, с. */
    this.introT = 0;
    /** Полная длительность текущего окна — по ней считается ease-out. */
    this.introDuration = CFG.camera.introSmoothTime;
    /**
     * Явная цель перелёта (левый верхний угол кадра). Пока задана, она
     * перекрывает кадрирование по планетам: сцены меню и магазина — не пара
     * планет, и вывести их положение из anchor/next нельзя.
     * @type {{x:number,y:number}|null}
     */
    this.flyTarget = null;

    /**
     * Пара планет, задающая кадр: anchor прижимается к низу, next обязана
     * влезть целиком. В полёте это уже СЛЕДУЮЩАЯ пара — кадр приезжает
     * правильным к моменту посадки, доводки после приземления нет.
     * @type {import('./planet.js').Planet|null}
     */
    this.anchor = null;
    /** @type {import('./planet.js').Planet|null} */
    this.next = null;
  }

  /**
   * Задать пару планет, задающую кадр. Зум пересчитывается ТОЛЬКО здесь —
   * при смене пары. Пересчёт каждый кадр заставил бы кадр «дышать» от
   * дрейфующих планет.
   * @param {import('./planet.js').Planet|null} anchor планета у нижнего края
   * @param {import('./planet.js').Planet|null} next планета, которая обязана влезть
   * @param {{w:number,h:number}} view
   */
  setPair(anchor, next, view) {
    if (this.anchor === anchor && this.next === next) return;
    this.anchor = anchor;
    this.next = next;
    this.targetScale = anchor && next ? this.computeScale(anchor, next, view) : CFG.camera.maxScale;
    this.startEase();
  }

  /**
   * Зум, при котором обе планеты помещаются в кадр с запасами.
   *
   * Бокс даёт первое приближение, но вертикаль считается не от центра бокса:
   * планета игрока принудительно сажается на currentPlanetScreenY. Поэтому
   * дальше идёт проверка «верх следующей планеты не обрезан» с дожимом зума.
   *
   * @param {import('./planet.js').Planet} cur
   * @param {import('./planet.js').Planet} next
   * @param {{w:number,h:number}} view
   * @returns {number}
   */
  computeScale(cur, next, view) {
    const C = CFG.camera;
    const left = Math.min(cur.x - cur.r, next.x - next.r) - C.marginX;
    const right = Math.max(cur.x + cur.r, next.x + next.r) + C.marginX;
    const top = next.y - next.r - C.marginTop;
    const bottom = cur.y + cur.r + C.marginBottom;

    let scale = Math.min(view.w / (right - left), view.h / (bottom - top), C.maxScale);
    scale = Math.max(scale, C.minScale);

    // Верхняя кромка следующей планеты в экранных координатах при этом зуме.
    // camY выводится из условия «anchor на currentPlanetScreenY», поэтому
    // screenTop = anchorScreenY - (cur.y - (next.y - next.r)) * scale.
    const anchorScreenY = view.h * C.currentPlanetScreenY;
    const drop = cur.y - (next.y - next.r);
    for (let i = 0; i < C.scaleFitIterations; i++) {
      if (anchorScreenY - drop * scale >= C.marginTop) return scale;
      if (scale <= C.minScale) break;
      scale = Math.max(C.minScale, scale * C.scaleFitStep);
    }

    if (DEV && anchorScreenY - drop * scale < C.marginTop) {
      console.warn(
        `[camera] следующая планета не влезает даже на минимальном зуме: `
        + `scale=${scale.toFixed(3)}, верх на ${(anchorScreenY - drop * scale).toFixed(1)}px `
        + `при требуемых ${C.marginTop}px`,
      );
    }
    return scale;
  }

  /**
   * Желаемое положение камеры при текущем зуме.
   * Вертикаль — строго из условия «anchor на currentPlanetScreenY».
   * Горизонталь — центр бокса пары. Без пары (промах в пустоту) ведём космонавта.
   * @param {import('./player.js').Player} player
   * @param {{w:number,h:number}} view
   * @returns {{x:number,y:number}}
   */
  desiredPosition(player, view) {
    const C = CFG.camera;
    const s = this.scale;

    // Кинематографический перелёт ведёт камеру в заданную точку, а не в кадр
    // по планетам: сцены меню и магазина живут вне цепочки.
    if (this.flyTarget) return this.flyTarget;

    if (!this.anchor) {
      return { x: player.x - view.w / 2 / s, y: player.y - view.h / 2 / s };
    }

    const cur = this.anchor;
    const next = this.next ?? cur;
    const left = Math.min(cur.x - cur.r, next.x - next.r) - C.marginX;
    const right = Math.max(cur.x + cur.r, next.x + next.r) + C.marginX;
    const centerX = (left + right) / 2;

    return {
      x: centerX - view.w / 2 / s,
      y: cur.y - (view.h * C.currentPlanetScreenY) / s,
    };
  }

  /**
   * Поставить камеру и зум в цель мгновенно — старт и рестарт не подъезжают.
   * @param {import('./player.js').Player} player
   * @param {{w:number,h:number}} view
   */
  snap(player, view) {
    this.scale = this.targetScale;
    const p = this.desiredPosition(player, view);
    this.x = p.x;
    this.y = p.y;
    // Те же гарантии, что и в update: иначе первый же кадр после старта
    // дёрнулся бы, доводя кадрирование.
    this.applyFramingClamps(player, view, null);
    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeT = 0;
    this.easeT = 0;
    this.endCinematic(); // мгновенная постановка отменяет любой влёт
  }

  /**
   * Текущий коэффициент сглаживания позиции. После смены пары он занижен и
   * возвращается к базовому по ease-out: цель скачком уходит на дальнюю
   * планету, и жёсткое сглаживание читалось бы как рывок.
   * @returns {number}
   */
  currentSmooth() {
    const C = CFG.camera;
    // Влёт из меню перекрывает обычную логику: там сглаживание не занижено,
    // а ЗАВЫШЕНО, и возвращается к базовому по тому же ease-out.
    if (this.introT > 0) {
      const k = 1 - this.introT / this.introDuration;
      const eased = 1 - (1 - k) * (1 - k);
      return C.introSmooth + (C.smooth - C.introSmooth) * eased;
    }
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
   * Кинематографический перелёт камеры в заданную точку мира.
   *
   * ЕДИНСТВЕННЫЙ механизм таких перелётов: им идут и влёт в игру, и переход
   * в магазин, и возврат обратно. Сглаживание на время duration ЗАВЫШЕНО
   * (резче базового) и возвращается к обычному по ease-out — длинный перелёт
   * на базовом коэффициенте читался бы как вялое всплытие.
   *
   * Гарантии кадрирования на время перелёта отключаются (см. applyFramingClamps):
   * они выведены из пары планет и тянули бы камеру прочь от заданной цели.
   *
   * @param {number} targetX мировой X левого верхнего угла кадра
   * @param {number} targetY мировой Y левого верхнего угла кадра
   * @param {number} targetScale зум, к которому едем
   * @param {number} duration с: длительность окна завышенного сглаживания
   */
  flyCameraTo(targetX, targetY, targetScale, duration) {
    this.flyTarget = { x: targetX, y: targetY };
    this.targetScale = targetScale;
    this.cinematic = true;
    this.introDuration = Math.max(duration, 1e-3);
    this.introT = this.introDuration;
    this.easeT = 0; // окно смены пары не должно бороться с окном перелёта
  }

  /**
   * Доехала ли камера до цели перелёта.
   * @param {number} tolerance порог в мировых px
   * @returns {boolean}
   */
  flightArrived(tolerance) {
    if (!this.flyTarget) return true;
    return Math.hypot(this.flyTarget.x - this.x, this.flyTarget.y - this.y) <= tolerance;
  }

  /** Завершить перелёт: камера снова обычная, с полными гарантиями кадра. */
  endCinematic() {
    this.cinematic = false;
    this.introT = 0;
    this.flyTarget = null;
  }

  /**
   * @param {number} dt секунды фиксированного шага
   * @param {import('./player.js').Player} player
   * @param {{w:number,h:number}} view
   */
  update(dt, player, view) {
    const fromX = this.x;
    const fromY = this.y;
    if (this.easeT > 0) this.easeT = Math.max(0, this.easeT - dt);
    if (this.introT > 0) this.introT = Math.max(0, this.introT - dt);

    // Зум едет к цели отдельно от позиции и асимметрично: отъезд быстрый
    // (иначе следующая планета останется обрезанной до конца полёта), наезд
    // медленный (именно он читается как глитч).
    const zoomRate = this.targetScale < this.scale
      ? CFG.camera.zoomSmoothOut
      : CFG.camera.zoomSmooth;
    const zt = 1 - Math.pow(1 - zoomRate, dt * 60);
    this.scale += (this.targetScale - this.scale) * zt;

    // Позицию считаем от УЖЕ обновлённого зума: так планета игрока держится на
    // своей строчке экрана и во время наезда, а не всплывает.
    const want = this.desiredPosition(player, view);

    const t = 1 - Math.pow(1 - this.currentSmooth(), dt * 60);
    let dx = (want.x - this.x) * t;
    let dy = (want.y - this.y) * t;

    // Потолок скорости задан в ЭКРАННЫХ px/s, поэтому в мире он делится на зум.
    const maxStep = (CFG.camera.maxSpeed / this.scale) * dt;
    const len = Math.hypot(dx, dy);
    if (len > maxStep && len > 0) {
      dx = (dx / len) * maxStep;
      dy = (dy / len) * maxStep;
    }

    this.x += dx;
    this.y += dy;

    this.applyFramingClamps(player, view, dt);

    // Потолок скорости считается по ИТОГОВОМУ смещению за кадр: сглаживание и
    // корректирующие клампы не должны складываться и пробивать ограничение.
    const totalX = this.x - fromX;
    const totalY = this.y - fromY;
    const total = Math.hypot(totalX, totalY);
    const budget = (CFG.camera.maxSpeed / this.scale) * dt;
    if (total > budget && total > 0) {
      this.x = fromX + (totalX / total) * budget;
      this.y = fromY + (totalY / total) * budget;
    }

    this.updateShake(dt);
  }

  /**
   * Сдвинуть камеру к точке, но не быстрее потолка скорости. Через это идут все
   * корректирующие клампы: иначе они ставили бы позицию напрямую и камера
   * телепортировалась бы в обход ограничения скорости.
   * @param {number} tx
   * @param {number} ty
   * @param {number} dt секунды; null — разрешить мгновенный сдвиг (старт игры)
   */
  moveTowards(tx, ty, dt) {
    if (dt === null) {
      this.x = tx;
      this.y = ty;
      return;
    }
    const budget = (CFG.camera.maxSpeed / this.scale) * dt;
    const dx = tx - this.x;
    const dy = ty - this.y;
    const len = Math.hypot(dx, dy);
    if (len <= budget || len === 0) {
      this.x = tx;
      this.y = ty;
      return;
    }
    this.x += (dx / len) * budget;
    this.y += (dy / len) * budget;
  }

  /**
   * Жёсткие гарантии кадра. Ограничения зависят ТОЛЬКО от планет, не от
   * мгновенной позиции космонавта — поэтому кадр остаётся неподвижным, пока
   * игрок крутится по орбите, никакого покачивания.
   *
   * Работают только в устоявшемся состоянии (игрок стоит на якорной планете).
   * В полёте камера намеренно едет к следующей паре, и дожимать её там значило
   * бы рвать кадр в движении.
   *
   * @param {import('./player.js').Player} player
   * @param {{w:number,h:number}} view
   * @param {number|null} dt секунды; null — мгновенно (старт игры)
   */
  applyFramingClamps(player, view, dt) {
    if (!this.anchor) return;
    // На влёте из меню клампы молчат. Камера идёт снизу, и «следующая планета
    // не обрезана» тянуло бы её ВЫШЕ установившегося кадра на полной скорости —
    // на подлёте это дало бы перелёт с откатом, ровно тот рывок, которого
    // влёт и должен избежать. В устоявшемся кадре клампы всё равно no-op.
    if (this.cinematic) return;
    if (player.state !== STATE_ORBIT || player.planet !== this.anchor) return;

    const tx = this.clampedX(view);
    const ty = this.clampedY(view);
    this.moveTowards(tx, ty, dt);
  }

  /**
   * Допустимый X: орбита якорной планеты целиком в кадре. Кадр центрируется по
   * боксу пары, и при сильном боковом разбросе планет якорь уезжает к краю —
   * вместе с ним туда ушла бы и орбита космонавта.
   * @param {{w:number,h:number}} view
   * @returns {number}
   */
  clampedX(view) {
    const C = CFG.camera;
    const s = this.scale;
    const reach = this.anchor.orbitRadius + C.playerMargin / s;

    const maxX = this.anchor.x - reach;                 // правее — срежется левый край орбиты
    const minX = this.anchor.x + reach - view.w / s;    // левее — срежется правый
    if (minX > maxX) return this.anchor.x - view.w / 2 / s; // орбита шире экрана: центрируем
    return Math.min(Math.max(this.x, minX), maxX);
  }

  /**
   * Допустимый Y: следующая планета видна целиком.
   *
   * Зум подобран так, что в установившемся кадре условие выполняется, но пока
   * камера ЕДЕТ к новой паре, верх следующей планеты может быть срезан — тогда
   * позиция подтягивается вверх ровно настолько, чтобы этого не случилось.
   * Ограничение снизу: нельзя утащить камеру так, что планета игрока (и он сам
   * на её орбите) уедет за нижнюю кромку — потерять игрока хуже.
   *
   * @param {{w:number,h:number}} view
   * @returns {number}
   */
  clampedY(view) {
    const C = CFG.camera;
    if (!this.next) return this.y;

    const s = this.scale;
    const wantY = (this.next.y - this.next.r) - C.marginTop / s;
    if (this.y <= wantY) return this.y; // верх и так не срезан

    const anchorBottom = this.anchor.y + this.anchor.orbitRadius;
    const minAllowed = anchorBottom - (view.h - C.playerMargin) / s;
    return Math.max(wantY, minAllowed);
  }

  /**
   * Не дать космонавту выпасть за кадр. Камера уезжает к планете назначения
   * раньше, чем игрок долетает. Отступ задан в экранных px, поэтому в мировых
   * координатах он делится на зум.
   * @param {import('./player.js').Player} player
   * @param {{w:number,h:number}} view
   */
  clampToPlayer(player, view, dt = null) {
    const s = this.scale;
    const m = CFG.camera.playerMargin / s;
    const visW = view.w / s;
    const visH = view.h / s;
    const tx = Math.min(Math.max(this.x, player.x - visW + m), player.x - m);
    const ty = Math.min(Math.max(this.y, player.y - visH + m), player.y - m);
    this.moveTowards(tx, ty, dt);
  }

  /**
   * Размеры видимой области мира. При scale < 1 она больше экрана — от неё
   * обязаны считаться границы спавна, иначе планеты умрут прямо в кадре.
   * @param {{w:number,h:number}} view
   * @returns {{w:number,h:number}}
   */
  visibleSize(view) {
    return { w: view.w / this.scale, h: view.h / this.scale };
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
