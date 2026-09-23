// One stroke-based icon set so every control shares a design language:
// 24-unit grid, 2px round strokes, currentColor. `icon(name)` returns SVG
// markup; `mountIcons(root)` fills every element carrying `data-icon`.

const ATTRS =
  'viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

// Five-point star centered on (12,12.5): outer radius 8.5, inner 3.7.
const star = (() => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 3.7 : 8.5;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push((12 + r * Math.cos(a)).toFixed(2) + ' ' + (12.5 + r * Math.sin(a)).toFixed(2));
  }
  return `<path d="M${pts.join('L')}Z"/>`;
})();

const PATHS = {
  // three horizontal sliders with knobs
  sliders:
    '<path d="M4 7h3M13 7h7M4 12h9M19 12h1M4 17h5M15 17h5"/>' +
    '<circle cx="10" cy="7" r="2.5"/><circle cx="16" cy="12" r="2.5"/><circle cx="12" cy="17" r="2.5"/>',
  star,
  help:
    '<circle cx="12" cy="12" r="9"/>' +
    '<path d="M9.4 9.6a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1 .9-1 1.6"/>' +
    '<path d="M12 17h.01"/>',
  // stopwatch
  timer:
    '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9.5M12 6V3.5M9.5 3.5h5M18.5 7.5l1.5-1.5"/>',
  undo: '<path d="M3 10h10a5 5 0 0 1 0 10h-4"/><path d="M7 6l-4 4 4 4"/>',
  redo: '<path d="M21 10H11a5 5 0 0 0 0 10h4"/><path d="M17 6l4 4-4 4"/>',
  reset: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 3.5V9h5.5"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="2.6"/>',
  play: '<path d="M7.5 4.5v15l12-7.5z" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M6 9.5l6 6 6-6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  // arrows in four directions, stacked (help panel, touch)
  swipe:
    '<path d="M12 3v18M3 12h18"/>' +
    '<path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  // footprints-ish move counter: two chevrons
  moves: '<path d="M6 5l5 7-5 7M13 5l5 7-5 7"/>',
};

export function icon(name) {
  const body = PATHS[name];
  if (!body) throw new Error('unknown icon: ' + name);
  return `<svg class="ic ic-${name}" ${ATTRS}>${body}</svg>`;
}

export function mountIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.innerHTML = icon(el.dataset.icon);
  }
}
