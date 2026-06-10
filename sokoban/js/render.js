// DOM renderer. Static floor/goal tiles are built once per level; the
// player and boxes are persistent elements moved with CSS transforms, so
// all motion is a single composited transition per move.
//
// Cell positions go through per-element --x/--y custom properties and a
// shared --cell size, so a window resize only updates --cell.

export class Renderer {
  constructor(boardEl) {
    this.board = boardEl;
    this.tilesEl = boardEl.querySelector('#tiles');
    this.entitiesEl = boardEl.querySelector('#entities');
    this.boxEls = [];
    this.playerEl = null;
    this.game = null;
    window.addEventListener('resize', () => this.layout());
  }

  setLevel(game) {
    this.game = game;
    const { w, h, walls, goalSet } = game.level;
    this.tilesEl.replaceChildren();
    this.entitiesEl.replaceChildren();
    this.boxEls = [];

    const floor = (x, y) =>
      x >= 0 && x < w && y >= 0 && y < h && !walls[y * w + x];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (walls[i]) continue;
        const tile = el('div', 'tile');
        setCell(tile, x, y);
        // Round outer corners where the floor blob ends, for an organic
        // silhouette under the shared drop-shadow.
        if (!floor(x, y - 1) && !floor(x - 1, y)) tile.classList.add('r-tl');
        if (!floor(x, y - 1) && !floor(x + 1, y)) tile.classList.add('r-tr');
        if (!floor(x, y + 1) && !floor(x + 1, y)) tile.classList.add('r-br');
        if (!floor(x, y + 1) && !floor(x - 1, y)) tile.classList.add('r-bl');
        this.tilesEl.appendChild(tile);
        if (goalSet[i]) {
          const goal = el('div', 'goal');
          setCell(goal, x, y);
          this.tilesEl.appendChild(goal);
        }
      }
    }

    game.boxPos.forEach((_, id) => {
      const box = el('div', 'box');
      this.entitiesEl.appendChild(box);
      this.boxEls[id] = box;
    });
    this.playerEl = el('div', 'player');
    this.entitiesEl.appendChild(this.playerEl);

    this.layout();
    this.update({ instant: true });
  }

  layout() {
    if (!this.game) return;
    const { w, h } = this.game.level;
    const wrap = this.board.parentElement;
    const availW = wrap.clientWidth - 16;
    const availH = Math.max(240, window.innerHeight - wrap.getBoundingClientRect().top - 96);
    const cell = Math.max(22, Math.min(72, Math.floor(Math.min(availW / w, availH / h))));
    this.board.style.setProperty('--cell', cell + 'px');
    this.board.style.width = w * cell + 'px';
    this.board.style.height = h * cell + 'px';
  }

  update({ fx = null, instant = false } = {}) {
    const g = this.game;
    const { w, goalSet } = g.level;
    if (instant) this.board.classList.add('no-anim');
    g.boxPos.forEach((pos, id) => {
      const e = this.boxEls[id];
      setCell(e, pos % w, Math.floor(pos / w));
      e.classList.toggle('done', goalSet[pos] === 1);
    });
    setCell(this.playerEl, g.player % w, Math.floor(g.player / w));
    if (fx?.push != null) {
      const e = this.boxEls[fx.push.boxId];
      e.classList.remove('bump');
      void e.offsetWidth; // restart animation
      e.classList.add('bump');
    }
    if (instant) {
      void this.board.offsetWidth;
      this.board.classList.remove('no-anim');
    }
  }

  celebrate() {
    this.board.classList.remove('won');
    void this.board.offsetWidth;
    this.board.classList.add('won');
  }
}

function el(tag, cls) {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function setCell(e, x, y) {
  e.style.setProperty('--x', x);
  e.style.setProperty('--y', y);
}
