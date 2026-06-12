// Level codes for sharing: "skb1.<w>x<h>.<cells>", where <cells> packs two
// cells per base64url character (3 bits each). Only the layout travels —
// the recipient re-solves the level for the optimal count and rating.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const WALL = 0, FLOOR = 1, GOAL = 2, BOX = 3, BOX_GOAL = 4, PLAYER = 5, PLAYER_GOAL = 6;

export function encodeLevel({ w, h, walls, goals, player, boxes }) {
  const n = w * h;
  const cells = new Uint8Array(n).fill(FLOOR);
  for (let i = 0; i < n; i++) if (walls[i]) cells[i] = WALL;
  for (const g of goals) cells[g] = GOAL;
  for (const b of boxes) cells[b] = cells[b] === GOAL ? BOX_GOAL : BOX;
  cells[player] = cells[player] === GOAL ? PLAYER_GOAL : PLAYER;
  let s = '';
  for (let i = 0; i < n; i += 2) s += B64[(cells[i] << 3) | (cells[i + 1] ?? 0)];
  return `skb1.${w}x${h}.${s}`;
}

// Throws with a human-readable message on anything malformed.
export function decodeLevel(code) {
  const m = /^skb1\.(\d+)x(\d+)\.([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m) throw new Error('not a level code');
  const w = +m[1];
  const h = +m[2];
  const s = m[3];
  if (w < 3 || h < 3 || w > 40 || h > 40) throw new Error('bad size');
  const n = w * h;
  if (s.length !== Math.ceil(n / 2)) throw new Error('bad length');
  const cells = new Uint8Array(n);
  for (let i = 0; i < s.length; i++) {
    const v = B64.indexOf(s[i]);
    cells[2 * i] = v >> 3;
    if (2 * i + 1 < n) cells[2 * i + 1] = v & 7;
  }
  const walls = new Array(n).fill(0);
  const goals = [];
  const boxes = [];
  let player = -1;
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    if (c > PLAYER_GOAL) throw new Error('bad cell');
    if (c === WALL) {
      walls[i] = 1;
      continue;
    }
    if (c === GOAL || c === BOX_GOAL || c === PLAYER_GOAL) goals.push(i);
    if (c === BOX || c === BOX_GOAL) boxes.push(i);
    if (c === PLAYER || c === PLAYER_GOAL) {
      if (player !== -1) throw new Error('two players');
      player = i;
    }
  }
  // The engine and solver index neighbours without bounds checks; a closed
  // wall border is the invariant that keeps them inside the grid.
  for (let x = 0; x < w; x++) {
    if (!walls[x] || !walls[n - w + x]) throw new Error('open border');
  }
  for (let y = 0; y < h; y++) {
    if (!walls[y * w] || !walls[y * w + w - 1]) throw new Error('open border');
  }
  if (player === -1) throw new Error('no player');
  if (!boxes.length || boxes.length !== goals.length) throw new Error('boxes/goals mismatch');
  return { w, h, walls, goals, player, boxes };
}
