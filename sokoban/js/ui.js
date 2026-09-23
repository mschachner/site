// Themed replacements for native popup UI. A picker is a list of options
// anchored under its trigger on wide screens and a bottom sheet on narrow
// ones; the same markup serves both, CSS decides the placement.

import { icon } from './icons.js';

export const narrow = matchMedia('(max-width: 640px)');

let current = null; // { close } for the open picker, if any

export function closePicker() {
  current?.close();
}

export function openPicker({ trigger, title, options, value, onSelect }) {
  closePicker();

  const scrim = document.createElement('div');
  scrim.className = 'picker-scrim';
  const menu = document.createElement('div');
  menu.className = 'picker';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', title);
  menu.innerHTML =
    `<div class="picker-head"><span class="picker-title">${title}</span></div>` +
    options
      .map(
        (o) =>
          `<button class="picker-opt${o.value === value ? ' selected' : ''}" role="option" ` +
          `aria-selected="${o.value === value}" data-value="${o.value}">` +
          `<span>${o.label}</span>${icon('check')}</button>`
      )
      .join('');

  // Anchor under the trigger; the narrow-screen stylesheet ignores these and
  // docks the menu to the bottom edge instead.
  const r = trigger.getBoundingClientRect();
  const menuW = Math.max(r.width, 168);
  const left = Math.min(r.left, window.innerWidth - menuW - 12);
  menu.style.setProperty('--px', Math.max(12, left) + 'px');
  menu.style.setProperty('--py', r.bottom + 6 + 'px');
  menu.style.setProperty('--pw', menuW + 'px');

  const close = () => {
    if (current?.close !== close) return;
    current = null;
    scrim.remove();
    menu.remove();
    trigger.setAttribute('aria-expanded', 'false');
    window.removeEventListener('resize', close);
    trigger.focus({ preventScroll: true });
  };
  current = { close };

  scrim.addEventListener('click', close);
  menu.addEventListener('click', (e) => {
    const opt = e.target.closest('.picker-opt');
    if (!opt) return;
    onSelect(opt.dataset.value);
    close();
  });
  // The picker owns keyboard focus while open; nothing leaks to the game.
  menu.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const opts = [...menu.querySelectorAll('.picker-opt')];
    const i = opts.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = opts.length;
      opts[(i + (e.key === 'ArrowDown' ? 1 : n - 1) + n) % n].focus();
    } else if (e.key === 'Tab') {
      // keep focus inside
      e.preventDefault();
      const n = opts.length;
      opts[(i + (e.shiftKey ? n - 1 : 1) + n) % n].focus();
    }
  });
  window.addEventListener('resize', close);

  document.body.append(scrim, menu);
  trigger.setAttribute('aria-expanded', 'true');
  (menu.querySelector('.picker-opt.selected') ?? menu.querySelector('.picker-opt')).focus({
    preventScroll: true,
  });
  return close;
}
