// Settings + high scores in localStorage.
//
// High scores are kept per puzzle category (ruleset|difficulty|size|boxes),
// Minesweeper style: one best time and one best moves-vs-optimal entry each.

const SETTINGS_KEY = 'sokoban.settings.v1';
const SCORES_KEY = 'sokoban.scores.v1';

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function loadSettings() {
  return read(SETTINGS_KEY, {});
}

export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function loadScores() {
  return read(SCORES_KEY, {});
}

export function clearScores() {
  localStorage.removeItem(SCORES_KEY);
}

export function scoreKey({ ruleset = 'classic', difficulty, size, boxes }) {
  return [ruleset, difficulty, size, boxes].join('|');
}

// Returns { bestTime, bestMoves } booleans for "new record" badges.
export function recordScore(key, { timeMs, moves, optimal }) {
  const all = loadScores();
  const cur = all[key] ?? {};
  const res = { bestTime: false, bestMoves: false };
  if (timeMs != null && (!cur.time || timeMs < cur.time.ms)) {
    cur.time = { ms: timeMs, date: Date.now() };
    res.bestTime = true;
  }
  const delta = moves - optimal;
  if (
    !cur.moves ||
    delta < cur.moves.delta ||
    (delta === cur.moves.delta && moves < cur.moves.moves)
  ) {
    cur.moves = { moves, optimal, delta, date: Date.now() };
    res.bestMoves = true;
  }
  all[key] = cur;
  localStorage.setItem(SCORES_KEY, JSON.stringify(all));
  return res;
}
