/**
 * Ввод: один тап в любой точке экрана. Координаты нужны, чтобы отличать
 * попадание по UI (шестерёнка, кнопки настроек) от игрового тапа.
 * Мышь и клавиатура — для отладки на десктопе.
 */
export class Input {
  /**
   * @param {HTMLCanvasElement} target канвас, слушающий указатель
   * @param {(x:number|null, y:number|null) => void} onTap координаты в CSS-пикселях
   *   относительно канваса; null — тап «без места» (клавиатура)
   * @param {() => void} [onEscape] запасной жест для десктопа: открыть/закрыть настройки
   */
  constructor(target, onTap, onEscape) {
    this.onTap = onTap;

    target.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = target.getBoundingClientRect();
      this.onTap(e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    // Контекстное меню по долгому тапу ломает залипательность — гасим.
    target.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        this.onTap(null, null);
      } else if (e.code === 'Escape' && onEscape) {
        e.preventDefault();
        onEscape();
      }
    });
  }
}
