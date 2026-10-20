// Movie-night tooltips.
//
// Each movie link is authored with a title="…" attribute. At load, that text is
// moved into a <span role="tooltip"> right after the link and the link gets
// aria-describedby pointing at it. The tooltip then opens on:
//   - mouse hover (and stays open while the pointer is over the tooltip itself),
//   - keyboard focus,
//   - long-press on touch screens (the release does not follow the link).
// Escape closes it. Without this script the browser's own title tooltip remains.

(function () {
  const LONG_PRESS_MS = 500;
  const MOVE_SLOP_PX = 10;
  const CLOSE_DELAY_MS = 150;
  const GAP_PX = 8;          // between the link and a right-side tooltip
  const EDGE_PX = 8;         // keep this far from the viewport edge
  const hasHover = window.matchMedia && window.matchMedia('(hover: hover)').matches;

  const links = document.querySelectorAll('.movie a[title]');
  if (!links.length) return;

  let current = null;        // the open tooltip, if any
  let closeTimer = null;
  let pressTimer = null;
  let pressStart = null;
  let suppressNextClick = null;

  // Put the tooltip to the right of the link's first line when it fits;
  // otherwise leave the stylesheet's below-the-link placement.
  function place(link, tip) {
    tip.style.left = '';
    tip.style.top = '';
    if (!hasHover) return;
    const movieRect = link.closest('.movie').getBoundingClientRect();
    const rects = link.getClientRects();
    const linkRect = rects.length ? rects[0] : link.getBoundingClientRect();
    const left = linkRect.right + GAP_PX;
    if (left + tip.offsetWidth > window.innerWidth - EDGE_PX) return;
    tip.style.left = (left - movieRect.left) + 'px';
    tip.style.top = (linkRect.top - movieRect.top + (linkRect.height - tip.offsetHeight) / 2) + 'px';
  }

  function open(link) {
    clearTimeout(closeTimer);
    if (current && current !== link.tip) close();
    link.tip.setAttribute('data-open', '');
    place(link, link.tip);
    current = link.tip;
  }

  function close() {
    clearTimeout(closeTimer);
    if (current) current.removeAttribute('data-open');
    current = null;
  }

  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, CLOSE_DELAY_MS);
  }

  function cancelPress() {
    clearTimeout(pressTimer);
    pressTimer = null;
    pressStart = null;
  }

  links.forEach((link, i) => {
    const tip = document.createElement('span');
    tip.className = 'tip';
    tip.id = 'tip-' + (i + 1);
    tip.setAttribute('role', 'tooltip');
    tip.textContent = link.getAttribute('title');
    link.removeAttribute('title');
    link.setAttribute('aria-describedby', tip.id);
    link.insertAdjacentElement('afterend', tip);
    link.tip = tip;

    // Mouse
    link.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') open(link);
    });
    link.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') scheduleClose();
    });
    tip.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') clearTimeout(closeTimer);
    });
    tip.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') scheduleClose();
    });

    // Keyboard
    link.addEventListener('focus', () => open(link));
    link.addEventListener('blur', close);

    // Touch: long-press opens; the release that follows must not navigate
    link.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      cancelPress();
      pressStart = { x: e.clientX, y: e.clientY };
      pressTimer = setTimeout(() => {
        pressTimer = null;
        open(link);
        suppressNextClick = link;
      }, LONG_PRESS_MS);
    });
    link.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || !pressStart) return;
      if (Math.abs(e.clientX - pressStart.x) > MOVE_SLOP_PX ||
          Math.abs(e.clientY - pressStart.y) > MOVE_SLOP_PX) cancelPress();
    });
    link.addEventListener('pointerup', cancelPress);
    link.addEventListener('pointercancel', cancelPress);
    link.addEventListener('click', (e) => {
      if (suppressNextClick === link) {
        e.preventDefault();
        suppressNextClick = null;
      }
    });
    // Android fires contextmenu on long-press; keep it from covering the tooltip
    link.addEventListener('contextmenu', (e) => {
      if (current === link.tip) e.preventDefault();
    });
  });

  // Escape closes
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) close();
  });

  // Touching anywhere else closes
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && current && !e.target.closest('.movie')) close();
  });
})();
