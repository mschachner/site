import { Game } from './engine.js';
import { Renderer } from './render.js';
import { bindKeys } from './input.js';
import { generateAsync, SIZES } from './generator.js';
import { PRESETS, COLOR_KEYS, applyTheme, cssName } from './themes.js';
import {
  loadSettings, saveSettings, loadScores, clearScores, scoreKey, recordScore,
} from './storage.js';
import { randomSeed } from './rng.js';

// ---------- state ----------

const settings = Object.assign(
  {
    difficulty: 'medium',
    size: 'm',
    boxes: 3,
    timer: true,
    theme: 'moss',
    custom: null,
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
  phase = 'generating';
  genStart = Date.now();
  showOverlay('generating', { attempt: 1 });
  syncHud();
  const params = {
    difficulty: settings.difficulty,
    size: settings.size,
    boxes: Number(settings.boxes),
    seed: randomSeed(),
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
  const key = scoreKey(settings);
  lastRecords = recordScore(key, {
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
      <p class="card-sub">press <kbd>p</kbd> to resume</p>`;
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

// ---------- side panel (theme / scores / help) ----------

let panelView = null;

function togglePanel(view) {
  if (panelView === view && !panelEl.classList.contains('hidden')) {
    closePanel();
    return;
  }
  panelView = view;
  panelEl.classList.remove('hidden');
  panelEl.replaceChildren();
  if (view === 'theme') buildThemePanel();
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

function currentTheme() {
  if (settings.theme === 'custom' && settings.custom) return settings.custom;
  return PRESETS[settings.theme] ?? PRESETS.moss;
}

function buildThemePanel() {
  panelHeader('theme');
  const body = document.createElement('div');
  body.className = 'panel-body';

  for (const dark of [false, true]) {
    const sub = document.createElement('p');
    sub.className = 'panel-sub';
    sub.textContent = dark ? 'dark' : 'light';
    body.appendChild(sub);
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const [id, p] of Object.entries(PRESETS)) {
      if (!!p.dark !== dark) continue;
      const chip = document.createElement('button');
      chip.className = 'chip' + (settings.theme === id ? ' active' : '');
      chip.innerHTML = `<span class="dot" style="background:${p.colors.player}"></span><span class="dot" style="background:${p.colors.box}"></span>${p.name}`;
      chip.onclick = () => {
        settings.theme = id;
        saveSettings(settings);
        applyTheme(p);
        buildThemePanel.refresh();
      };
      chips.appendChild(chip);
    }
    body.appendChild(chips);
  }

  const sub = document.createElement('p');
  sub.className = 'panel-sub';
  sub.textContent = 'customize';
  body.appendChild(sub);

  const theme = currentTheme();
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
  body.appendChild(grid);

  body.appendChild(
    slider('roundness', theme.organic, 0, 1, 0.05, (v) => editCustom((c) => (c.organic = v)))
  );
  body.appendChild(
    slider('animation speed (ms)', theme.anim, 50, 280, 10, (v) => editCustom((c) => (c.anim = v)))
  );

  panelEl.appendChild(body);
  buildThemePanel.refresh = () => {
    panelEl.replaceChildren();
    buildThemePanel();
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
  // de-highlight preset chips without rebuilding (keeps slider focus)
  panelEl.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
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
  body.innerHTML = `
    <p class="panel-sub">push every box onto a goal dot.</p>
    <div class="key-list">
      <div><kbd>↑↓←→</kbd> / <kbd>wasd</kbd> / <kbd>hjkl</kbd><span>move</span></div>
      <div><kbd>z</kbd> / <kbd>u</kbd><span>undo</span></div>
      <div><kbd>y</kbd> / <kbd>shift z</kbd><span>redo</span></div>
      <div><kbd>r</kbd><span>reset puzzle</span></div>
      <div><kbd>p</kbd> / <kbd>space</kbd><span>pause (timer on)</span></div>
      <div><kbd>enter</kbd><span>new puzzle</span></div>
      <div><kbd>t</kbd><span>theme</span></div>
      <div><kbd>g</kbd><span>scores</span></div>
      <div><kbd>?</kbd><span>this help</span></div>
    </div>
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
  $('themeBtn').onclick = () => togglePanel('theme');
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

  bindKeys(actions);
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
