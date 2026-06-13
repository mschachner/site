import { Game } from './engine.js';
import { Renderer } from './render.js';
import { bindKeys, bindTouch } from './input.js';
import { generateAsync, SIZES, rateScore, ratingOf } from './generator.js';
import { solve } from './solver.js';
import { encodeLevel, decodeLevel } from './share.js';
import {
  PRESETS, COLOR_KEYS, applyTheme, cssName,
  RANDOM_LIGHT, RANDOM_DARK, isRandom, presetsByGroup, pickRandomPreset,
} from './themes.js';
import {
  loadSettings, saveSettings, loadScores, clearScores, scoreKey, recordScore,
} from './storage.js';
import { randomSeed } from './rng.js';

// touch-first device: keyboard shortcuts are irrelevant in copy/help
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;

// ---------- state ----------

const settings = Object.assign(
  {
    difficulty: 'medium',
    size: 'm',
    boxes: 3,
    timer: true,
    theme: RANDOM_LIGHT,
    custom: null,
    austere: false,
  },
  loadSettings()
);

let game = null;
let renderer = null;
let phase = 'boot'; // boot | generating | ready | playing | paused | won
let lastRecords = { bestTime: false, bestMoves: false };

const clock = {
  acc: 0,
  since: null,
  get ms() {
    return this.acc + (this.since ? Date.now() - this.since : 0);
  },
  start() {
    if (!this.since) this.since = Date.now();
  },
  stop() {
    if (this.since) {
      this.acc += Date.now() - this.since;
      this.since = null;
    }
  },
  reset() {
    this.acc = 0;
    this.since = null;
  },
};

// ---------- dom ----------

const $ = (id) => document.getElementById(id);
const boardEl = $('board');
const overlayEl = $('overlay');
const panelEl = $('panel');

// ---------- generation service (worker with main-thread fallback) ----------

const genService = (() => {
  let worker = null;
  let reqId = 0;
  function makeWorker() {
    try {
      return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch {
      return null;
    }
  }
  return {
    cancel() {
      if (worker) {
        worker.terminate();
        worker = null;
      }
      reqId++;
    },
    generate(params, onProgress) {
      const id = ++reqId;
      worker = worker ?? makeWorker();
      if (!worker) return generateAsync(params, onProgress);
      return new Promise((resolve, reject) => {
        const w = worker;
        w.onmessage = (e) => {
          if (e.data.id !== id) return;
          if (e.data.type === 'progress') onProgress?.(e.data);
          else resolve(e.data.result);
        };
        w.onerror = (err) => {
          worker = null;
          reject(err);
        };
        w.postMessage({ id, params });
      });
    },
  };
})();

// ---------- puzzle lifecycle ----------

let genStart = 0;

async function newPuzzle() {
  genService.cancel();
  reshuffleTheme();
  phase = 'generating';
  genStart = Date.now();
  showOverlay('generating', { attempt: 1 });
  syncHud();
  const params = {
    difficulty: settings.difficulty,
    size: settings.size,
    boxes: Number(settings.boxes),
    seed: randomSeed(),
    austere: !!settings.austere,
  };
  let puzzle = null;
  try {
    puzzle = await genService.generate(params, ({ attempt }) =>
      showOverlay('generating', { attempt })
    );
    // Rare on expert+max boxes: every attempt timed out. One more try.
    if (!puzzle) {
      puzzle = await genService.generate({ ...params, seed: randomSeed() }, ({ attempt }) =>
        showOverlay('generating', { attempt })
      );
    }
  } catch (err) {
    console.error(err);
    puzzle = await generateAsync(params);
  }
  if (!puzzle) {
    showOverlay('error');
    phase = 'ready';
    return;
  }
  game = new Game(puzzle);
  renderer.setLevel(game);
  startAttempt();
}

function loadPuzzle(puzzle) {
  genService.cancel();
  game = new Game(puzzle);
  renderer.setLevel(game);
  startAttempt();
}

function startAttempt() {
  game.reset();
  renderer.update({ instant: true });
  clock.reset();
  phase = 'ready';
  hideOverlay();
  boardEl.classList.remove('won', 'paused');
  syncHud();
}

function finishWin() {
  phase = 'won';
  clock.stop();
  renderer.celebrate();
  // Shared levels don't belong to a difficulty/size/boxes category, so
  // they don't compete for records.
  lastRecords = game.puzzle.shared
    ? { bestTime: false, bestMoves: false }
    : recordScore(scoreKey(settings), {
        timeMs: settings.timer ? clock.ms : null,
        moves: game.moves,
        optimal: game.puzzle.optimal.moves,
      });
  setTimeout(() => showOverlay('won'), 350);
  syncHud();
}

// ---------- actions ----------

const actions = {
  move(dir) {
    if (phase !== 'ready' && phase !== 'playing') return;
    const fx = game.move(dir);
    if (!fx) return;
    if (phase === 'ready') {
      phase = 'playing';
      if (settings.timer) clock.start();
    }
    renderer.update({ fx });
    syncHud();
    if (game.isSolved()) finishWin();
  },
  undo() {
    if (phase !== 'playing' && phase !== 'ready') return;
    if (game.undo()) {
      renderer.update();
      syncHud();
    }
  },
  redo() {
    if (phase !== 'playing' && phase !== 'ready') return;
    if (game.redo()) {
      renderer.update();
      syncHud();
    }
  },
  reset() {
    if (!game || phase === 'generating') return;
    startAttempt();
  },
  pause() {
    if (!settings.timer) return;
    if (phase === 'playing') {
      phase = 'paused';
      clock.stop();
      boardEl.classList.add('paused');
      showOverlay('paused');
    } else if (phase === 'paused') {
      phase = 'playing';
      clock.start();
      boardEl.classList.remove('paused');
      hideOverlay();
    }
    syncHud();
  },
  newPuzzle,
  panel: togglePanel,
  escape() {
    if (!panelEl.classList.contains('hidden')) closePanel();
    else if (phase === 'paused') actions.pause();
  },
};

// ---------- hud ----------

function fmtTime(ms, precise = false) {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return precise
    ? `${m}:${sec.toFixed(1).padStart(4, '0')}`
    : `${m}:${String(Math.floor(sec)).padStart(2, '0')}`;
}

function syncHud() {
  const hasGame = !!game && phase !== 'generating';
  $('timer').textContent = settings.timer ? fmtTime(clock.ms) : '—';
  $('timer').classList.toggle('off', !settings.timer);
  $('timerToggle').classList.toggle('active', settings.timer);
  if (hasGame) {
    $('moveStat').textContent = `${game.moves} moves · optimal ${game.puzzle.optimal.moves}`;
    const r = game.puzzle.rating;
    $('rating').textContent = r;
    $('rating').dataset.rating = r;
  } else {
    $('moveStat').textContent = '…';
    $('rating').textContent = '';
  }
  $('undoBtn').disabled = !hasGame || !game.history.length || phase === 'paused' || phase === 'won';
  $('redoBtn').disabled = !hasGame || !game.redoStack.length || phase === 'paused' || phase === 'won';
  $('resetBtn').disabled = !hasGame;
  $('pauseBtn').disabled = !settings.timer || (phase !== 'playing' && phase !== 'paused');
  $('pauseBtn').textContent = phase === 'paused' ? '▶' : '⏸';
}

setInterval(() => {
  if (phase === 'playing' && settings.timer) {
    $('timer').textContent = fmtTime(clock.ms);
  }
  // Long generations (>5s) get an elapsed-time readout on the overlay.
  if (phase === 'generating' && overlayKind === 'generating') {
    const el = overlayEl.querySelector('.gen-time');
    const sec = (Date.now() - genStart) / 1000;
    if (el && sec >= 5) el.textContent = `${Math.floor(sec)}s elapsed`;
  }
}, 200);

// ---------- overlay ----------

let overlayKind = null;

function showOverlay(kind, data = {}) {
  overlayEl.classList.remove('hidden');
  if (kind === 'generating' && overlayKind === 'generating') {
    // just tick the attempt counter; don't restart the spinner
    const sub = overlayEl.querySelector('.gen-attempt');
    if (sub) sub.textContent = `attempt ${data.attempt ?? 1}`;
    return;
  }
  overlayKind = kind;
  overlayEl.replaceChildren();
  const card = document.createElement('div');
  card.className = 'card';
  if (kind === 'generating') {
    card.innerHTML = `
      <div class="spinner"><span></span><span></span><span></span></div>
      <p class="card-title">carving puzzle</p>
      <p class="card-sub gen-attempt">attempt ${data.attempt ?? 1}</p>
      <p class="card-sub gen-time"></p>`;
  } else if (kind === 'start') {
    card.innerHTML = `
      <p class="card-title">sokoban</p>
      <p class="card-sub">push every box onto a goal dot</p>
      <div class="card-form">
        <label>difficulty <select id="ovDifficulty"></select></label>
        <label>boxes <select id="ovBoxes"></select></label>
        <label>size <select id="ovSize"></select></label>
      </div>
      <div class="card-actions">
        <button class="primary" id="ovGen">generate <kbd>enter</kbd></button>
      </div>`;
    // mirror the topbar selects so either set of controls stays in sync
    for (const [ovId, srcId] of [
      ['ovDifficulty', 'difficulty'],
      ['ovBoxes', 'boxes'],
      ['ovSize', 'size'],
    ]) {
      const sel = card.querySelector('#' + ovId);
      const src = $(srcId);
      sel.innerHTML = src.innerHTML;
      sel.value = src.value;
      sel.onchange = () => {
        src.value = sel.value;
        src.onchange();
      };
      // Enter generates even while a dialog select holds focus
      sel.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          newPuzzle();
        }
      };
    }
    card.querySelector('#ovGen').onclick = newPuzzle;
  } else if (kind === 'paused') {
    card.innerHTML = `
      <p class="card-title">paused</p>
      <p class="card-sub">${IS_TOUCH ? 'tap to resume' : 'press <kbd>p</kbd> to resume'}</p>`;
  } else if (kind === 'error') {
    card.innerHTML = `
      <p class="card-title">couldn't find a puzzle</p>
      <p class="card-sub">try fewer boxes or a bigger board</p>
      <div class="card-actions"><button class="primary" id="ovNew">try again</button></div>`;
    card.querySelector('#ovNew').onclick = newPuzzle;
  } else if (kind === 'won') {
    const opt = game.puzzle.optimal.moves;
    const delta = game.moves - opt;
    const badges = [
      lastRecords.bestTime ? '<span class="badge">★ best time</span>' : '',
      lastRecords.bestMoves ? '<span class="badge">★ best moves</span>' : '',
    ].join('');
    card.innerHTML = `
      <p class="card-title">solved</p>
      <div class="stats">
        ${settings.timer ? `<div><span class="num">${fmtTime(clock.ms, true)}</span><span class="lbl">time</span></div>` : ''}
        <div><span class="num">${game.moves}</span><span class="lbl">moves</span></div>
        <div><span class="num">${delta === 0 ? 'perfect' : '+' + delta}</span><span class="lbl">vs optimal ${opt}</span></div>
      </div>
      ${badges ? `<p class="badges">${badges}</p>` : ''}
      <div class="card-actions">
        <button id="ovReplay">replay <kbd>r</kbd></button>
        <button class="primary" id="ovNew">new puzzle <kbd>enter</kbd></button>
      </div>`;
    card.querySelector('#ovReplay').onclick = startAttempt;
    card.querySelector('#ovNew').onclick = newPuzzle;
  }
  overlayEl.appendChild(card);
}

function hideOverlay() {
  overlayEl.classList.add('hidden');
  overlayKind = null;
}

// ---------- side panel (settings / scores / help) ----------

let panelView = null;
let customizeOpen = false; // survives panel rebuilds (e.g. preset clicks)

function togglePanel(view) {
  if (panelView === view && !panelEl.classList.contains('hidden')) {
    closePanel();
    return;
  }
  panelView = view;
  panelEl.classList.remove('hidden');
  panelEl.replaceChildren();
  if (view === 'settings') buildSettingsPanel();
  else if (view === 'scores') buildScoresPanel();
  else buildHelpPanel();
}

function closePanel() {
  panelEl.classList.add('hidden');
  panelView = null;
}

function panelHeader(title) {
  const head = document.createElement('div');
  head.className = 'panel-head';
  head.innerHTML = `<h2>${title}</h2><button class="icon" aria-label="close">×</button>`;
  head.querySelector('button').onclick = closePanel;
  panelEl.appendChild(head);
  return head;
}

// When a "random" theme is active this holds the concrete preset currently
// showing, as an [id, preset] pair, so re-renders stay stable between the
// reshuffles that happen on each new puzzle.
let randomPick = null;

function currentTheme() {
  if (settings.theme === 'custom' && settings.custom) return settings.custom;
  if (isRandom(settings.theme)) {
    if (!randomPick) randomPick = pickRandomPreset(settings.theme === RANDOM_DARK);
    return randomPick[1];
  }
  return PRESETS[settings.theme] ?? PRESETS.moss;
}

// Pick a fresh preset for the active random theme and apply it. No-op for
// concrete/custom themes.
function reshuffleTheme() {
  if (!isRandom(settings.theme)) return;
  randomPick = pickRandomPreset(settings.theme === RANDOM_DARK, randomPick?.[0]);
  applyTheme(randomPick[1]);
}

function buildSettingsPanel() {
  panelHeader('settings');
  const body = document.createElement('div');
  body.className = 'panel-body';

  const section = (title) => {
    const h = document.createElement('h3');
    h.className = 'panel-section';
    h.textContent = title;
    body.appendChild(h);
  };

  section('theme');
  for (const dark of [false, true]) {
    const sub = document.createElement('p');
    sub.className = 'panel-sub';
    sub.textContent = dark ? 'dark' : 'light';
    body.appendChild(sub);
    const grid = document.createElement('div');
    grid.className = 'preset-grid';

    // "random" comes first in each group: a new puzzle reshuffles to a random
    // preset of this light/dark group.
    const randomId = dark ? RANDOM_DARK : RANDOM_LIGHT;
    const rcard = document.createElement('button');
    rcard.className = 'preset' + (settings.theme === randomId ? ' active' : '');
    // Player colors are toned for the *other* group's lightness (light themes
    // use dark dots, dark themes use light dots), so pull from the opposite
    // group to get a vivid gradient that still reads light vs. dark.
    const stops = presetsByGroup(!dark).map(([, p]) => p.colors.player);
    rcard.innerHTML =
      `<span class="swatch" style="background:conic-gradient(from 135deg, ${stops.join(', ')}, ${stops[0]})">` +
      `</span>random`;
    rcard.onclick = () => {
      settings.theme = randomId;
      randomPick = null;
      saveSettings(settings);
      applyTheme(currentTheme());
      buildSettingsPanel.refresh();
    };
    grid.appendChild(rcard);

    for (const [id, p] of Object.entries(PRESETS)) {
      if (!!p.dark !== dark) continue;
      const card = document.createElement('button');
      card.className = 'preset' + (settings.theme === id ? ' active' : '');
      card.innerHTML =
        `<span class="swatch" style="background:${p.colors.bg}">` +
        `<span class="swatch-floor" style="background:${p.colors.surface}">` +
        `<span class="dot" style="background:${p.colors.player}"></span>` +
        `<span class="dot" style="background:${p.colors.box}"></span>` +
        `</span></span>${p.name}`;
      card.onclick = () => {
        settings.theme = id;
        saveSettings(settings);
        applyTheme(p);
        buildSettingsPanel.refresh();
      };
      grid.appendChild(card);
    }
    body.appendChild(grid);
  }

  const theme = currentTheme();
  const customize = document.createElement('details');
  customize.className = 'customize';
  customize.open = customizeOpen;
  customize.innerHTML = '<summary>customize</summary>';
  customize.addEventListener('toggle', () => (customizeOpen = customize.open));
  const grid = document.createElement('div');
  grid.className = 'color-grid';
  for (const [key, label] of COLOR_KEYS) {
    const row = document.createElement('label');
    row.className = 'color-row';
    row.innerHTML = `<input type="color" value="${toHex(theme.colors[key])}"><span>${label}</span>`;
    row.querySelector('input').addEventListener('input', (e) => {
      editCustom((c) => (c.colors[key] = e.target.value));
    });
    grid.appendChild(row);
  }
  customize.appendChild(grid);

  customize.appendChild(
    slider('roundness', theme.organic, 0, 1, 0.05, (v) => editCustom((c) => (c.organic = v)))
  );
  body.appendChild(customize);

  section('advanced settings');
  body.appendChild(
    slider('animation speed (ms)', theme.anim, 50, 280, 10, (v) => editCustom((c) => (c.anim = v)))
  );
  const check = document.createElement('label');
  check.className = 'check-row';
  check.innerHTML = `<input type="checkbox"${settings.austere ? ' checked' : ''}><span>austere mode</span>`;
  check.querySelector('input').onchange = (e) => {
    settings.austere = e.target.checked;
    saveSettings(settings);
  };
  body.appendChild(check);
  const note = document.createElement('p');
  note.className = 'panel-sub';
  note.textContent =
    'austere puzzles keep only the floor cells the optimal solution uses. applies to the next puzzle.';
  body.appendChild(note);

  const shareSub = document.createElement('p');
  shareSub.className = 'panel-sub';
  shareSub.textContent = 'level code';
  body.appendChild(shareSub);
  const row = document.createElement('div');
  row.className = 'share-row';
  row.innerHTML = `
    <input type="text" spellcheck="false" autocomplete="off" placeholder="paste level code" aria-label="level code">
    <button class="share-load" disabled>load</button>
    <button class="share-copy">copy</button>`;
  const codeInput = row.querySelector('input');
  const loadBtn = row.querySelector('.share-load');
  const status = document.createElement('p');
  status.className = 'panel-sub share-status';
  const loadCode = () => {
    const code = codeInput.value.trim();
    if (!code) return;
    let level;
    try {
      level = decodeLevel(code);
    } catch {
      status.textContent = "that doesn't look like a valid level code.";
      return;
    }
    status.textContent = 'solving…';
    setTimeout(() => {
      // budget beyond generator profiles: pasted levels get one honest try
      const sol = solve(level, level.player, level.boxes, { maxNodes: 600000, maxMs: 8000 });
      if (!sol) {
        status.textContent = "couldn't solve that level — it may be broken or too hard.";
        return;
      }
      if (!sol.moves) {
        status.textContent = 'that level is already solved.';
        return;
      }
      const score = rateScore(sol);
      loadPuzzle({
        ...level,
        optimal: { moves: sol.moves, pushes: sol.pushes, switches: sol.switches },
        score: Math.round(score),
        rating: ratingOf(score),
        shared: true,
      });
      closePanel();
    });
  };
  codeInput.onkeydown = (e) => {
    if (e.key === 'Enter') loadCode();
  };
  codeInput.addEventListener('input', () => {
    loadBtn.disabled = !codeInput.value.trim();
  });
  loadBtn.onclick = loadCode;
  row.querySelector('.share-copy').onclick = async () => {
    if (!game) {
      status.textContent = 'no level yet — generate one first.';
      return;
    }
    const code = encodeLevel(game.puzzle);
    codeInput.value = code;
    loadBtn.disabled = false;
    try {
      await navigator.clipboard.writeText(code);
      status.textContent = 'copied to clipboard.';
    } catch {
      codeInput.select();
      status.textContent = 'clipboard unavailable — code is in the field, copy it there.';
    }
  };
  body.appendChild(row);
  body.appendChild(status);

  panelEl.appendChild(body);
  buildSettingsPanel.refresh = () => {
    panelEl.replaceChildren();
    buildSettingsPanel();
  };
}

function editCustom(mutate) {
  const base = currentTheme();
  const custom = settings.custom && settings.theme === 'custom'
    ? settings.custom
    : { name: 'Custom', organic: base.organic, anim: base.anim, colors: { ...base.colors } };
  mutate(custom);
  settings.custom = custom;
  settings.theme = 'custom';
  saveSettings(settings);
  applyTheme(custom);
  // de-highlight preset cards without rebuilding (keeps slider focus)
  panelEl.querySelectorAll('.preset').forEach((c) => c.classList.remove('active'));
}

function slider(label, value, min, max, step, onInput) {
  const wrap = document.createElement('label');
  wrap.className = 'slider-row';
  wrap.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}">`;
  wrap.querySelector('input').addEventListener('input', (e) => onInput(Number(e.target.value)));
  return wrap;
}

function toHex(c) {
  if (c.startsWith('#')) return c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c;
  return c;
}

function buildScoresPanel() {
  panelHeader('best scores');
  const body = document.createElement('div');
  body.className = 'panel-body';
  const all = loadScores();
  const keys = Object.keys(all).sort();
  if (!keys.length) {
    body.innerHTML = '<p class="panel-sub">no scores yet — solve a puzzle.</p>';
  } else {
    const curKey = scoreKey(settings);
    for (const k of keys) {
      const [, diff, size, boxes] = k.split('|');
      const s = all[k];
      const row = document.createElement('div');
      row.className = 'score-row' + (k === curKey ? ' current' : '');
      row.innerHTML = `
        <div class="score-cat">${diff} · ${SIZES[size]?.label ?? size} · ${boxes} box${boxes === '1' ? '' : 'es'}</div>
        <div class="score-vals">
          <span title="best time">⏱ ${s.time ? fmtTime(s.time.ms, true) : '—'}</span>
          <span title="best moves vs optimal">⇄ ${s.moves ? `${s.moves.moves} (+${s.moves.delta})` : '—'}</span>
        </div>`;
      body.appendChild(row);
    }
    const clear = document.createElement('button');
    clear.className = 'danger';
    clear.textContent = 'clear all scores';
    clear.onclick = () => {
      clearScores();
      buildScoresPanel.refresh();
    };
    body.appendChild(clear);
  }
  panelEl.appendChild(body);
  buildScoresPanel.refresh = () => {
    panelEl.replaceChildren();
    buildScoresPanel();
  };
}

function buildHelpPanel() {
  panelHeader('help');
  const body = document.createElement('div');
  body.className = 'panel-body';
  const controls = IS_TOUCH
    ? `
      <div><kbd>swipe</kbd><span>move — hold &amp; drag to keep moving</span></div>
      <div><kbd>↶ ↷</kbd><span>undo / redo</span></div>
      <div><kbd>⟲</kbd><span>reset puzzle</span></div>
      <div><kbd>⏸</kbd><span>pause (timer on)</span></div>
      <div><kbd>◐</kbd><span>settings</span></div>
      <div><kbd>★</kbd><span>scores</span></div>`
    : `
      <div><kbd>↑↓←→</kbd> / <kbd>wasd</kbd> / <kbd>hjkl</kbd><span>move</span></div>
      <div><kbd>swipe</kbd><span>move (touch) — hold &amp; drag to keep moving</span></div>
      <div><kbd>z</kbd> / <kbd>u</kbd><span>undo</span></div>
      <div><kbd>y</kbd> / <kbd>shift z</kbd><span>redo</span></div>
      <div><kbd>r</kbd><span>reset puzzle</span></div>
      <div><kbd>p</kbd> / <kbd>space</kbd><span>pause (timer on)</span></div>
      <div><kbd>enter</kbd><span>new puzzle</span></div>
      <div><kbd>t</kbd><span>settings</span></div>
      <div><kbd>g</kbd><span>scores</span></div>
      <div><kbd>?</kbd><span>this help</span></div>`;
  body.innerHTML = `
    <p class="panel-sub">push every box onto a goal dot.</p>
    <div class="key-list">${controls}</div>
    <p class="panel-sub">puzzles are generated and verified solvable; the
    move counter shows the optimal solution length found by the solver.
    high scores are kept per difficulty · size · box-count category, by
    fastest time and by fewest moves over optimal.</p>`;
  panelEl.appendChild(body);
}

// ---------- wiring ----------

function init() {
  renderer = new Renderer(boardEl);
  applyTheme(currentTheme());

  const diffSel = $('difficulty');
  const sizeSel = $('size');
  const boxSel = $('boxes');
  diffSel.value = settings.difficulty;
  sizeSel.value = settings.size;
  boxSel.value = String(settings.boxes);
  const onParam = () => {
    settings.difficulty = diffSel.value;
    settings.size = sizeSel.value;
    settings.boxes = Number(boxSel.value);
    saveSettings(settings);
  };
  diffSel.onchange = onParam;
  sizeSel.onchange = onParam;
  boxSel.onchange = onParam;

  $('newBtn').onclick = () => {
    newPuzzle();
    $('newBtn').blur();
  };
  $('undoBtn').onclick = actions.undo;
  $('redoBtn').onclick = actions.redo;
  $('resetBtn').onclick = actions.reset;
  $('pauseBtn').onclick = actions.pause;
  $('themeBtn').onclick = () => togglePanel('settings');
  $('scoresBtn').onclick = () => togglePanel('scores');
  $('helpBtn').onclick = () => togglePanel('help');
  $('timerToggle').onclick = () => {
    if (phase === 'paused') actions.pause();
    settings.timer = !settings.timer;
    saveSettings(settings);
    if (phase === 'playing') {
      if (settings.timer) clock.start();
      else clock.stop();
    }
    syncHud();
  };

  window.addEventListener('blur', () => {
    if (phase === 'playing' && settings.timer) actions.pause();
  });

  // tap/click anywhere on the paused overlay to resume (no keyboard on touch)
  overlayEl.addEventListener('click', () => {
    if (phase === 'paused') actions.pause();
  });

  bindKeys(actions);
  bindTouch($('boardWrap'), actions);
  // First puzzle is generated from the start dialog, not automatically.
  showOverlay('start');
  syncHud();

  // debug/testing hook
  window.__sokoban = {
    get phase() {
      return phase;
    },
    state() {
      if (!game) return null;
      const { w, h, walls } = game.level;
      return {
        w, h,
        walls: Array.from(walls),
        goals: game.level.goals.slice(),
        player: game.player,
        boxes: game.boxPos.slice(),
        moves: game.moves,
      };
    },
  };
}

init();
