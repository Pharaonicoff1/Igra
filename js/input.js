/**
 * Ввод: один тап в любой точке экрана. Мышь и клавиша пробел — для отладки на десктопе.
 */
export class Input {
  /**
   * @param {HTMLElement} target элемент, слушающий указатель
   * @param {() => void} onTap колбэк на каждый тап
   */
  constructor(target, onTap) {
    this.onTap = onTap;
    const handler = (e) => {
      e.preventDefault();
      this.onTap();
    };
    target.addEventListener('pointerdown', handler, { passive: false });
    // Контекстное меню по долгому тапу ломает залипательность — гасим.
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        this.onTap();
      }
    });
  }
}
