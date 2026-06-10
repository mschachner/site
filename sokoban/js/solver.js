// Move-optimal Sokoban solver.
//
// A* over (box configuration, player position after last push). Edges are
// single pushes; edge cost = player walking distance to the push square + 1.
// Because only pushes change box state and walking between pushes is taken
// at BFS-optimal length, the result is optimal in total *moves*.
//
// Heuristic: sum over boxes of the wall-only minimal push distance to the
// nearest goal (admissible: every push is a move). Cells with no push path
// to any goal are "dead squares" and pruned.

class MinHeap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// Minimal number of pushes to bring a box from each cell to the nearest
// goal, considering walls only (multi-source reverse BFS from the goals).
// -1 means unreachable (dead square, unless it is a goal).
export function computePushDist(level) {
  const { w, walls, goals } = level;
  const n = walls.length;
  const dist = new Int32Array(n).fill(-1);
  const dirs = [-w, w, -1, 1];
  const q = [];
  for (const g of goals) {
    if (dist[g] === -1) {
      dist[g] = 0;
      q.push(g);
    }
  }
  let head = 0;
  while (head < q.length) {
    const to = q[head++];
    for (const d of dirs) {
      const from = to - d;
      const playerAt = from - d;
      if (walls[from] || walls[playerAt]) continue;
      if (dist[from] === -1) {
        dist[from] = dist[to] + 1;
        q.push(from);
      }
    }
  }
  return dist;
}

export function solve(level, player, boxesIn, opts = {}) {
  const maxNodes = opts.maxNodes ?? 200000;
  const maxMs = opts.maxMs ?? 3000;
  const { w, walls } = level;
  const n = walls.length;
  const dirs = [-w, w, -1, 1];

  const goalSet = new Uint8Array(n);
  for (const g of level.goals) goalSet[g] = 1;
  const pushDist = opts.pushDist ?? computePushDist(level);

  const heur = (boxes) => {
    let s = 0;
    for (let i = 0; i < boxes.length; i++) {
      const d = pushDist[boxes[i]];
      if (d < 0) return Infinity;
      s += d;
    }
    return s;
  };
  const solved = (boxes) => {
    for (let i = 0; i < boxes.length; i++) if (!goalSet[boxes[i]]) return false;
    return true;
  };

  const boxes0 = Int32Array.from(boxesIn).sort();
  if (solved(boxes0)) return { moves: 0, pushes: 0, switches: 0, nodes: 0 };
  const h0 = heur(boxes0);
  if (h0 === Infinity) return null;

  // Scratch arrays with stamping to avoid reallocation per node.
  const reach = new Int32Array(n);
  const wdist = new Int32Array(n);
  const boxMark = new Int32Array(n);
  const queue = new Int32Array(n);
  let stampId = 0;

  const keyOf = (boxes, player) => boxes.join(',') + '|' + player;

  const open = new MinHeap();
  const bestG = new Map();
  const parent = new Map();
  const k0 = keyOf(boxes0, player);
  bestG.set(k0, 0);
  open.push({ f: h0, g: 0, boxes: boxes0, player, key: k0 });

  let nodes = 0;
  const t0 = Date.now();

  while (open.size) {
    const cur = open.pop();
    if (cur.g > (bestG.get(cur.key) ?? Infinity)) continue;
    if (solved(cur.boxes)) {
      // Reconstruct push chain to count pushes and box "switches"
      // (how often the solver has to change which box it works on).
      const chain = [];
      let k = cur.key;
      while (parent.has(k)) {
        const p = parent.get(k);
        chain.push(p);
        k = p.pk;
      }
      chain.reverse();
      let switches = 0;
      for (let i = 1; i < chain.length; i++) {
        if (chain[i].from !== chain[i - 1].to) switches++;
      }
      return { moves: cur.g, pushes: chain.length, switches, nodes };
    }
    nodes++;
    if (nodes > maxNodes) return null;
    if ((nodes & 1023) === 0 && Date.now() - t0 > maxMs) return null;

    // BFS walking distances from the current player position, boxes solid.
    stampId++;
    const bs = cur.boxes;
    for (let i = 0; i < bs.length; i++) boxMark[bs[i]] = stampId;
    let qh = 0;
    let qt = 0;
    queue[qt++] = cur.player;
    reach[cur.player] = stampId;
    wdist[cur.player] = 0;
    while (qh < qt) {
      const c = queue[qh++];
      const dc = wdist[c];
      for (const d of dirs) {
        const t = c + d;
        if (walls[t] || reach[t] === stampId || boxMark[t] === stampId) continue;
        reach[t] = stampId;
        wdist[t] = dc + 1;
        queue[qt++] = t;
      }
    }

    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      for (const d of dirs) {
        const src = b - d;
        const dst = b + d;
        if (reach[src] !== stampId) continue;
        if (walls[dst] || boxMark[dst] === stampId) continue;
        if (pushDist[dst] < 0) continue; // dead square
        const nb = bs.slice();
        nb[i] = dst;
        nb.sort();
        const ng = cur.g + wdist[src] + 1;
        const nkey = keyOf(nb, b);
        if (ng >= (bestG.get(nkey) ?? Infinity)) continue;
        const nh = heur(nb);
        if (nh === Infinity) continue;
        bestG.set(nkey, ng);
        parent.set(nkey, { pk: cur.key, from: b, to: dst });
        open.push({ f: ng + nh, g: ng, boxes: nb, player: b, key: nkey });
      }
    }
  }
  return null; // unsolvable
}
