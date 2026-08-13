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
   */
  tone(spec) {
    if (!this.enabled || !this.ctx) return;
    const now = this.ctx.currentTime;
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

  /** Смерть. */
  death() {
    this.tone(CFG.audio.death);
  }
}
