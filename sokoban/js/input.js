// Keyboard handling. Holding an arrow key repeats via native key repeat.
const MOVES = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
  k: 'up', j: 'down', h: 'left', l: 'right',
};

// Touch handling. A swipe moves one step; keeping the finger down and
// dragging keeps moving, since the origin resets after each step fires.
const SWIPE_MIN = 28; // px of travel per step

export function bindTouch(el, actions) {
  let id = null;
  let sx = 0;
  let sy = 0;

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    id = e.pointerId;
    sx = e.clientX;
    sy = e.clientY;
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) return;
    actions.move(
      Math.abs(dx) > Math.abs(dy)
        ? (dx > 0 ? 'right' : 'left')
        : (dy > 0 ? 'down' : 'up')
    );
    sx = e.clientX;
    sy = e.clientY;
  });
  const end = (e) => {
    if (e.pointerId === id) id = null;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

export function bindKeys(actions) {
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if ((e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault();
      (e.shiftKey ? actions.redo : actions.undo)();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k === 'y') {
      e.preventDefault();
      actions.redo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (MOVES[k]) {
      e.preventDefault();
      actions.move(MOVES[k]);
      return;
    }
    switch (k) {
      case 'z':
        e.preventDefault();
        (e.shiftKey ? actions.redo : actions.undo)();
        break;
      case 'u': e.preventDefault(); actions.undo(); break;
      case 'y': e.preventDefault(); actions.redo(); break;
      case 'r': e.preventDefault(); actions.reset(); break;
      case 'p': case ' ': e.preventDefault(); actions.pause(); break;
      case 'Enter':
        // let a focused button receive its native click instead
        if (e.target instanceof HTMLButtonElement) return;
        e.preventDefault();
        actions.newPuzzle();
        break;
      case 't': actions.panel('settings'); break;
      case 'g': actions.panel('scores'); break;
      case '?': actions.panel('help'); break;
      case 'Escape': actions.escape(); break;
    }
  });
}
