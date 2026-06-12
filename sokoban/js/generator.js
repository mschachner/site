// Procedural Sokoban level generation.
//
// Pipeline per attempt:
//   1. Carve an organic room with a drunkard's walk, then drop pillars into
//      open areas (pillars create the corners that make Sokoban hard).
//   2. Pick goal cells, place boxes on them, and run a scored beam search of
//      *pulls* away from the goals. Pull-reachable states are pushable back,
//      so every generated start is solvable by construction.
//   3. Verify with the move-optimal solver and rate difficulty from the
//      optimal solution (pushes + box switches + search effort).
// Attempts repeat until a puzzle lands inside the requested difficulty band
// or the time budget runs out (then: closest candidate so far).

import { makeRng, randInt, shuffle, randomSeed } from './rng.js';
import { solve, computePushDist } from './solver.js';

export const SIZES = {
  s: { w: 9, h: 8, label: 'small' },
  m: { w: 11, h: 9, label: 'medium' },
  l: { w: 13, h: 10, label: 'large' },
  xl: { w: 15, h: 12, label: 'extra large' },
};

export const PROFILES = {
  easy: { pulls: 20, beam: 32, budget: 3000, maxNodes: 40000, solveMs: 1200, minPushes: 6 },
  medium: { pulls: 50, beam: 40, budget: 5000, maxNodes: 80000, solveMs: 1800, minPushes: 10 },
  hard: { pulls: 110, beam: 48, budget: 9000, maxNodes: 200000, solveMs: 2600, minPushes: 15 },
  expert: { pulls: 180, beam: 56, budget: 16000, maxNodes: 400000, solveMs: 3000, minPushes: 16 },
};

// Difficulty score bands; calibrated against measured generation runs.
export const BANDS = {
  easy: [8, 30],
  medium: [30, 60],
  hard: [60, 85],
  expert: [85, Infinity],
};

export function rateScore(sol) {
  return sol.pushes + 3 * sol.switches + 2 * Math.log2(sol.nodes + 1);
}

export function ratingOf(score) {
  for (const [name, [lo, hi]] of Object.entries(BANDS)) {
    if (score >= lo && score < hi) return name;
  }
  return score < BANDS.easy[0] ? 'easy' : 'expert';
}

const bandDist = (s, [lo, hi]) => (s < lo ? lo - s : s >= hi ? s - hi + 1 : 0);

function connected(walls, w, h) {
  const n = w * h;
  let start = -1;
  let floors = 0;
  for (let i = 0; i < n; i++) {
    if (!walls[i]) {
      floors++;
      if (start === -1) start = i;
    }
  }
  if (start === -1) return false;
  const seen = new Uint8Array(n);
  const q = [start];
  seen[start] = 1;
  let count = 0;
  const dirs = [-w, w, -1, 1];
  while (q.length) {
    const c = q.pop();
    count++;
    for (const d of dirs) {
      const t = c + d;
      if (!walls[t] && !seen[t]) {
        seen[t] = 1;
        q.push(t);
      }
    }
  }
  return count === floors;
}

function carve(w, h, rng) {
  const n = w * h;
  const walls = new Uint8Array(n).fill(1);
  const idx = (x, y) => y * w + x;
  let x = 1 + randInt(rng, w - 2);
  let y = 1 + randInt(rng, h - 2);
  let floors = 1;
  walls[idx(x, y)] = 0;
  const target = Math.round((w - 2) * (h - 2) * (0.5 + rng() * 0.15));
  const dxs = [0, 0, -1, 1];
  const dys = [-1, 1, 0, 0];
  let dir = randInt(rng, 4);
  let guard = 0;
  while (floors < target && guard++ < 30000) {
    if (rng() < 0.35) dir = randInt(rng, 4);
    const nx = x + dxs[dir];
    const ny = y + dys[dir];
    if (nx < 1 || nx > w - 2 || ny < 1 || ny > h - 2) {
      dir = randInt(rng, 4);
      continue;
    }
    x = nx;
    y = ny;
    const i = idx(x, y);
    if (walls[i]) {
      walls[i] = 0;
      floors++;
    }
  }
  // Break up wide-open areas with pillars (kept only if the floor stays
  // connected).
  const cand = [];
  for (let yy = 2; yy <= h - 3; yy++) {
    for (let xx = 2; xx <= w - 3; xx++) {
      const i = idx(xx, yy);
      if (walls[i]) continue;
      let openArea = true;
      for (let dy = -1; dy <= 1 && openArea; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (walls[idx(xx + dx, yy + dy)]) {
            openArea = false;
            break;
          }
        }
      }
      if (openArea) cand.push(i);
    }
  }
  shuffle(rng, cand);
  for (const i of cand) {
    if (rng() < 0.6) {
      walls[i] = 1;
      if (connected(walls, w, h)) floors--;
      else walls[i] = 0;
    }
  }
  return { walls, floors };
}

// Goal cells must allow at least one pull, otherwise the box glued to them
// would never leave during scrambling.
function chooseGoals(level, k, rng) {
  const { w, walls } = level;
  const dirs = [-w, w, -1, 1];
  const opts = [];
  for (let i = 0; i < walls.length; i++) {
    if (walls[i]) continue;
    if (dirs.some((d) => !walls[i + d] && !walls[i + 2 * d])) opts.push(i);
  }
  if (opts.length < k + 2) return null;
  shuffle(rng, opts);
  return opts.slice(0, k);
}

function scramble(level, goals, rng, prof, pushDist) {
  const { w, walls } = level;
  const n = walls.length;
  const dirs = [-w, w, -1, 1];
  const goalSet = new Uint8Array(n);
  for (const g of goals) goalSet[g] = 1;

  const floors = [];
  for (let i = 0; i < n; i++) if (!walls[i] && !goalSet[i]) floors.push(i);
  if (!floors.length) return null;
  shuffle(rng, floors);

  const reach = new Int32Array(n);
  const boxMark = new Int32Array(n);
  const queue = new Int32Array(n);
  let stampId = 0;

  const flood = (player, boxes) => {
    stampId++;
    for (let i = 0; i < boxes.length; i++) boxMark[boxes[i]] = stampId;
    let qh = 0;
    let qt = 0;
    queue[qt++] = player;
    reach[player] = stampId;
    while (qh < qt) {
      const c = queue[qh++];
      for (const d of dirs) {
        const t = c + d;
        if (walls[t] || boxMark[t] === stampId || reach[t] === stampId) continue;
        reach[t] = stampId;
        queue[qt++] = t;
      }
    }
    return qt;
  };

  // Score favors states whose boxes are far (in push distance) from the
  // goals and off the goals entirely; mild depth bonus plus noise for
  // variety. Real difficulty is measured afterwards by the solver.
  const scoreOf = (boxes, pulls) => {
    let s = 0;
    let onGoal = 0;
    for (let i = 0; i < boxes.length; i++) {
      s += pushDist[boxes[i]];
      if (goalSet[boxes[i]]) onGoal++;
    }
    return s * 3 - onGoal * 4 + pulls * 0.25 + rng() * 2.5;
  };

  let beam = floors.slice(0, 3).map((p) => ({
    boxes: Int32Array.from(goals).sort(),
    player: p,
    pulls: 0,
  }));
  const visited = new Set();
  let best = null;
  let bestScore = -Infinity;

  for (let depth = 0; depth < prof.pulls; depth++) {
    const children = [];
    for (const s of beam) {
      flood(s.player, s.boxes);
      for (let i = 0; i < s.boxes.length; i++) {
        const b = s.boxes[i];
        for (const d of dirs) {
          const side = b + d; // box lands here, player was here
          const side2 = b + 2 * d; // player retreats here
          if (reach[side] !== stampId) continue;
          if (walls[side2] || boxMark[side2] === stampId) continue;
          const nb = s.boxes.slice();
          nb[i] = side;
          nb.sort();
          const key = nb.join(',') + '|' + side2;
          if (visited.has(key)) continue;
          visited.add(key);
          const st = { boxes: nb, player: side2, pulls: s.pulls + 1 };
          st.score = scoreOf(nb, st.pulls);
          children.push(st);
        }
      }
    }
    if (!children.length) break;
    children.sort((a, b) => b.score - a.score);
    beam = children.slice(0, prof.beam);
    // Only states with every box off its goal qualify: no box may start
    // already solved.
    const top = beam.find((s) => s.boxes.every((b) => !goalSet[b]));
    if (top && top.score > bestScore) {
      bestScore = top.score;
      best = top;
    }
  }
  if (!best) return null;

  // Drop the player anywhere in its reachable region so the start doesn't
  // telegraph the last pull.
  const size = flood(best.player, best.boxes);
  const cells = queue.slice(0, size);
  const player = cells[randInt(rng, cells.length)];
  return { boxes: Array.from(best.boxes), player };
}

// Austere mode: wall off every floor cell the optimal solution never
// touches. The optimal stays exact — its own cells are all kept, and the
// reduced level admits only a subset of the original's solutions, so no
// shorter one can appear.
function austereWalls(level, player, boxes, chain) {
  const { w, walls } = level;
  const n = walls.length;
  const dirs = [-w, w, -1, 1];
  const used = new Uint8Array(n);
  const prev = new Int32Array(n);
  const boxSet = new Set(boxes);
  let at = player;
  used[at] = 1;
  for (const b of boxes) used[b] = 1;
  for (const { from, to } of chain) {
    const src = from - (to - from); // player pushes from behind the box
    if (at !== src) {
      // shortest walk to the push square, boxes solid; mark its cells
      prev.fill(-2);
      prev[at] = -1;
      const q = [at];
      let head = 0;
      while (head < q.length && prev[src] === -2) {
        const c = q[head++];
        for (const d of dirs) {
          const t = c + d;
          if (walls[t] || boxSet.has(t) || prev[t] !== -2) continue;
          prev[t] = c;
          q.push(t);
        }
      }
      for (let c = src; c !== -1; c = prev[c]) used[c] = 1;
    }
    used[to] = 1;
    boxSet.delete(from);
    boxSet.add(to);
    at = from; // player ends where the box was
  }
  for (let i = 0; i < n; i++) if (!walls[i] && !used[i]) walls[i] = 1;
}

// Generator-as-iterator so callers can drive it synchronously (worker) or
// with yields back to the event loop (main-thread fallback).
export function* generateIter(params) {
  const prof = PROFILES[params.difficulty] ?? PROFILES.medium;
  const band = BANDS[params.difficulty] ?? BANDS.medium;
  const size = SIZES[params.size] ?? SIZES.m;
  const nBoxes = Math.max(1, Math.min(8, params.boxes ?? 3));
  const seed = params.seed ?? randomSeed();
  const rng = makeRng(seed);
  const budget = params.budget ?? prof.budget;
  const { w, h } = size;

  let best = null;
  let bestDist = Infinity;
  const t0 = Date.now();
  let attempt = 0;

  while (Date.now() - t0 < budget && attempt < 400) {
    attempt++;
    const cand = tryOnce();
    if (cand) {
      const d = bandDist(cand.score, band);
      if (d === 0) {
        cand.attempts = attempt;
        return cand;
      }
      if (d < bestDist) {
        bestDist = d;
        best = cand;
      }
    }
    yield { attempt };
  }
  if (best) best.attempts = attempt;
  return best;

  function tryOnce() {
    const { walls, floors } = carve(w, h, rng);
    if (floors < nBoxes * 3 + 4) return null;
    const level = { w, h, walls, goals: [] };
    const goals = chooseGoals(level, nBoxes, rng);
    if (!goals) return null;
    level.goals = goals;
    const pushDist = computePushDist(level);
    const scr = scramble(level, goals, rng, prof, pushDist);
    if (!scr) return null;
    const sol = solve(level, scr.player, scr.boxes, {
      maxNodes: prof.maxNodes,
      maxMs: prof.solveMs,
      pushDist,
    });
    if (!sol || sol.pushes < prof.minPushes) return null;
    const score = rateScore(sol);
    if (params.austere) austereWalls(level, scr.player, scr.boxes, sol.chain);
    return {
      w,
      h,
      walls: Array.from(walls),
      goals,
      player: scr.player,
      boxes: scr.boxes,
      optimal: { moves: sol.moves, pushes: sol.pushes, switches: sol.switches },
      score: Math.round(score),
      rating: ratingOf(score),
      seed,
    };
  }
}

export function generate(params, onProgress) {
  const it = generateIter(params);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    onProgress?.(r.value);
  }
}

export async function generateAsync(params, onProgress) {
  const it = generateIter(params);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    onProgress?.(r.value);
    await new Promise((res) => setTimeout(res));
  }
}
