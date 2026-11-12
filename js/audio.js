import { CFG } from './config.js';

/**
 * Процедурные SFX на WebAudio: ни одного файла-ассета, только осцилляторы.
 * AudioContext создаётся лениво — по первому тапу, иначе мобильные браузеры
 * блокируют звук политикой автоплея.
 */
export class Sfx {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.enabled = true;
  }

  /**
   * Включить/выключить звук. Выключение мгновенно затыкает все будущие SFX.
   * @param {boolean} on
   */
  setEnabled(on) {
    this.enabled = on;
  }

  /**
   * Разблокировать аудио — вызывать из обработчика реального пользовательского
   * жеста. Повторные вызовы безопасны.
   */
  unlock() {
    if (!this.enabled) return;
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch {
      // Аудио недоступно — игра должна работать и без него.
      this.ctx = null;
    }
  }

  /**
   * Короткий тон со скольжением частоты и экспоненциальным затуханием.
   * @param {{from:number,to:number,dur:number,type:OscillatorType}} spec
   * @param {number} [delay] с: отложить начало — для звуков из нескольких нот
   */
  tone(spec, delay = 0) {
    if (!this.enabled || !this.ctx) return;
    const now = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.from, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(spec.to, 1), now + spec.dur);

    gain.gain.setValueAtTime(CFG.audio.masterGain, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.dur);

    osc.connect(gain).connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + spec.dur);
  }

  /** Отрыв от планеты. */
  jump() {
    this.tone(CFG.audio.jump);
  }

  /** Приземление. */
  land() {
    this.tone(CFG.audio.land);
  }

  /**
   * Точная посадка: тон тем выше, чем длиннее серия.
   *
   * Частоты сдвигаются обе — и начальная, и конечная: если поднимать только
   * старт, скольжение становится всё круче и к концу серии звучит как сбой,
   * а не как та же нота выше.
   *
   * @param {number} step сколько точных прыжков подряд уже набрано
   */
  landPrecise(step) {
    const spec = CFG.audio.landPrecise;
    const up = Math.min(step, CFG.streak.toneMaxSteps) * CFG.streak.toneStep;
    // Новый объект на каждый вызов не аллоцируется в горячем цикле: звук
    // играет раз в посадку, а не в кадре.
    this.tone({ from: spec.from + up, to: spec.to + up, dur: spec.dur, type: spec.type });
  }

  /** Серия оборвалась: короткий нисходящий вздох. */
  streakBreak() {
    this.tone(CFG.audio.streakBreak);
  }

  /** Задание выполнено посреди забега: тихий звон, не спорит с посадкой. */
  missionDone() {
    this.tone(CFG.audio.missionDone);
  }

  /** Награда за задание забрана: две ноты вверх. */
  missionClaim() {
    const A = CFG.audio;
    this.tone(A.missionClaim);
    this.tone(A.missionClaim2, A.missionClaimDelay);
  }

  /** Побит рекорд: три ноты вверх. */
  record() {
    const A = CFG.audio;
    this.tone(A.record);
    this.tone(A.record2, A.recordStep);
    this.tone(A.record3, A.recordStep * 2);
  }

  /** Вход в новый сектор: две мягкие ноты вверх. */
  sector() {
    const A = CFG.audio;
    this.tone(A.sector);
    this.tone(A.sector2, A.sectorDelay);
  }

  /** Окно для прыжка открылось: короткий щелчок. */
  tick() {
    this.tone(CFG.audio.tick);
  }

  /** Смерть. */
  death() {
    this.tone(CFG.audio.death);
  }
}
