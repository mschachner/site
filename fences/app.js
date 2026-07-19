(() => {
  const $ = id => document.getElementById(id);
  const boardEl = $('board');

  // ---------- state ----------
  let R = 8, C = 8, L = 1;      // the visible board: dots down/across, loops
  let clues = new Set();        // edge and cell-dot clue ids
  let byline = '';              // optional creator attribution packaged with the puzzle
  let engine = null;
  let running = false, paused = false, stopped = false;
  let lastPaint = 0;

  // top-level mode: the Play tab or the Create workshop. Each keeps its own
  // board; the globals above always hold the visible tab's, swapped on switch.
  let tab = 'play';
  const tabState = { play: null, create: { R: 8, C: 8, L: 1, clues: new Set(), byline: '' } };

  let playPhase = 'setup';   // setup | run | won
  let playSolution = null;   // Set of solution edges, fixed once the puzzle verifies unique
  let playMarks = null;      // player marks per edge: 0 none, 1 fence, 2 ×
  let playUndo = [], playRedo = []; // actions contain one or more [edge, before, after] changes
  let timerIv = null, playT0 = 0, playMs = 0;
  let degreeHelperTimer = null;
  let sharedPuzzlePrompt = false;
  let returnToSharedPrompt = false;
  let returnToAboutPrompt = false;
  let autoStartPuzzle = false;

  const SAMPLE_CODE = '6x6:6.7.f.s.13.1j@TWFyaw';
  const HIDE_ABOUT_KEY = 'fences.hideAbout';
  const DEGREE_HELPER_DELAY_MS = 300;

  // solve-state cache: revisiting a clue configuration (incl. the empty board)
  // resumes its search where it left off instead of starting over
  const stateCache = new Map(); // key -> engine, insertion order = LRU
  const CACHE_MAX = 64;
  const cacheKey = () => `${R}x${C}~${L}|${[...clues].sort((a, b) => a - b).join(',')}`;

  // ---------- level codes ----------
  // "RxC:ids" ("RxC~L:ids" for multi-loop), ids = sorted clue ids in base36
  // joined by dots. An optional "@base64url" suffix carries the creator byline.
  function encodeText(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeText(str) {
    try {
      const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4);
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch { return null; }
  }
  const codeOf = () =>
    `${R}x${C}${L > 1 ? '~' + L : ''}:` +
    [...clues].sort((a, b) => a - b).map(i => i.toString(36)).join('.') +
    (byline ? '@' + encodeText(byline) : '');
  function parseCode(str) {
    let raw = String(str || '').trim(), parsedByline = '';
    const at = raw.lastIndexOf('@');
    if (at >= 0) {
      const encoded = raw.slice(at + 1);
      parsedByline = encoded && /^[0-9a-z_-]+$/i.test(encoded) ? decodeText(encoded) : null;
      if (!parsedByline || parsedByline.length > 80) return null;
      raw = raw.slice(0, at);
    }
    const m = /^\s*(\d+)\s*x\s*(\d+)\s*(?:~\s*(\d+))?\s*:\s*([0-9a-z.\s]*)$/i.exec(raw);
    if (!m) return null;
    const r = +m[1], c = +m[2], l = m[3] ? +m[3] : 1;
    if (r < 2 || r > 40 || c < 2 || c > 40 || l < 1 || l > 400) return null;
    const E = r * (c - 1) + (r - 1) * c, top = E + 2 * (r - 1) * (c - 1);
    const body = m[4].replace(/\s+/g, '');
    const ids = body ? body.split('.').map(s => s ? parseInt(s, 36) : NaN) : [];
    if (ids.some(i => !Number.isInteger(i) || i < 0 || i >= top)) return null;
    return { R: r, C: c, L: l, clues: new Set(ids), byline: parsedByline };
  }
  function shareUrl() {
    const url = new URL(location.href);
    url.search = '';
    url.hash = codeOf();
    return url.href;
  }
  function codeFromHash() {
    if (location.hash.length < 2) return null;
    try { return decodeURIComponent(location.hash.slice(1)); }
    catch { return null; }
  }

  // svg element caches, rebuilt on resize
  let heatEls = [], clueEls = [], neverEls = [], pctEls = [], bangEls = [];
  let dotClueEls = [], cellBangEls = [], cellHeatEls = [];
  let playEls = [], playXEls = [], dotEls = [];

  // ---------- geometry ----------
  const S = 40, PAD = 22;
  const HEcount = () => R * (C - 1);
  const Ecount = () => R * (C - 1) + (R - 1) * C;
  const Fcount = () => (R - 1) * (C - 1);
  // cell dot clues share the clue id space: ids past the edges
  const dotIn = f => Ecount() + 2 * f;
  const dotOut = f => Ecount() + 2 * f + 1;
  function edgeEnds(e) {
    const HE = HEcount();
    if (e < HE) {
      const r = (e / (C - 1)) | 0, c = e % (C - 1);
      return [c, r, c + 1, r];
    }
    const k = e - HE, r = (k / C) | 0, c = k % C;
    return [c, r, c, r + 1];
  }
  // ---------- board rendering ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  function el(name, attrs) {
    const n = document.createElementNS(SVGNS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function buildBoard() {
    const E = Ecount();
    const W = (C - 1) * S + 2 * PAD, H = (R - 1) * S + 2 * PAD;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Fences board, ${C} by ${R} dots` });
    const gTrack = el('g', { class: 'tracks' });
    const gHeat = el('g', {});
    const gNever = el('g', {});
    const gClue = el('g', {});
    const gPlay = el('g', {});
    const gDot = el('g', {});
    const gPct = el('g', {});
    const gBang = el('g', {});
    const gHit = el('g', {});
    const gCell = el('g', {});
    heatEls = new Array(E); clueEls = new Array(E); neverEls = new Array(E); pctEls = new Array(E); bangEls = new Array(E);
    playEls = new Array(E); playXEls = new Array(E);
    for (let e = 0; e < E; e++) {
      const [x1, y1, x2, y2] = edgeEnds(e);
      const a = { x1: PAD + x1 * S, y1: PAD + y1 * S, x2: PAD + x2 * S, y2: PAD + y2 * S };
      gTrack.appendChild(el('line', { ...a, class: 'track' }));
      const h = el('line', { ...a, class: 'heat', display: 'none' });
      heatEls[e] = h; gHeat.appendChild(h);
      const [mx, my] = [(a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2];
      const nx = el('path', {
        d: `M ${mx - 3.4} ${my - 3.4} L ${mx + 3.4} ${my + 3.4} M ${mx + 3.4} ${my - 3.4} L ${mx - 3.4} ${my + 3.4}`,
        class: 'never', display: 'none'
      });
      neverEls[e] = nx; gNever.appendChild(nx);
      const pt = el('text', { x: mx, y: my, dy: '0.34em', 'text-anchor': 'middle', class: 'pct', display: 'none' });
      pctEls[e] = pt; gPct.appendChild(pt);
      const cl = el('line', { ...a, class: 'clue', display: 'none' });
      clueEls[e] = cl; gClue.appendChild(cl);
      const pl = el('line', { ...a, class: 'pline', display: 'none' });
      playEls[e] = pl; gPlay.appendChild(pl);
      const px = el('path', {
        d: `M ${mx - 3.2} ${my - 3.2} L ${mx + 3.2} ${my + 3.2} M ${mx + 3.2} ${my - 3.2} L ${mx - 3.2} ${my + 3.2}`,
        class: 'pmark', display: 'none'
      });
      playXEls[e] = px; gPlay.appendChild(px);
      const horiz = y1 === y2;
      const bg = el('text', {
        x: horiz ? mx : mx + 9, y: horiz ? my - 8 : my,
        dy: '0.34em', 'text-anchor': 'middle', class: 'bang', display: 'none'
      });
      bg.textContent = '!';
      bangEls[e] = bg; gBang.appendChild(bg);
      const hit = el('line', { ...a, class: 'hit' });
      hit.dataset.e = e;
      gHit.appendChild(hit);
    }
    const gCHeat = el('g', {});
    const F = Fcount();
    dotClueEls = new Array(F); cellBangEls = new Array(F); cellHeatEls = new Array(F);
    for (let f = 0; f < F; f++) {
      const cx = PAD + (f % (C - 1) + 0.5) * S, cy = PAD + (((f / (C - 1)) | 0) + 0.5) * S;
      const hc = el('circle', { cx, cy, r: 5, class: 'cheat', display: 'none' });
      cellHeatEls[f] = hc; gCHeat.appendChild(hc);
      const dc = el('circle', { cx, cy, r: 6.2, class: 'celldot', display: 'none' });
      dotClueEls[f] = dc; gCell.appendChild(dc);
      const bg = el('text', { x: cx + 10, y: cy - 7, dy: '0.34em', 'text-anchor': 'middle', class: 'bang', display: 'none' });
      bg.textContent = '!';
      cellBangEls[f] = bg; gBang.appendChild(bg);
      const hit = el('circle', { cx, cy, r: 11.5, class: 'hitc' });
      hit.dataset.f = f;
      gHit.appendChild(hit);
    }
    dotEls = new Array(R * C);
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++) {
        const v = r * C + c;
        dotEls[v] = el('circle', { cx: PAD + c * S, cy: PAD + r * S, r: 3.6, class: 'dot' });
        gDot.appendChild(dotEls[v]);
      }
    svg.append(gTrack, gHeat, gCHeat, gNever, gClue, gPlay, gCell, gDot, gPct, gBang, gHit);
    gHit.addEventListener('click', ev => {
      const t = ev.target;
      if (tab === 'play' && playPhase !== 'setup') { // solving: edges cycle player marks
        if (t.dataset.e !== undefined) playToggle(+t.dataset.e);
        return;
      }
      if (t.dataset.e !== undefined) toggleClue(+t.dataset.e);
      else if (t.dataset.f !== undefined) toggleDot(+t.dataset.f);
    });
    gHit.addEventListener('mousedown', ev => {
      if (ev.button === 0) ev.preventDefault();
    });
    gHit.addEventListener('contextmenu', ev => {
      const t = ev.target;
      if (t.dataset.f === undefined || (tab === 'play' && playPhase !== 'setup')) return;
      ev.preventDefault();
      clearDot(+t.dataset.f);
    });
    gHit.addEventListener('pointermove', ev => {
      const t = ev.target;
      if (t.dataset.e !== undefined) { hoverEdge = +t.dataset.e; hoverCell = -1; }
      else if (t.dataset.f !== undefined) { hoverCell = +t.dataset.f; hoverEdge = -1; }
      else { hideTip(); return; }
      const tip = $('tip');
      tip.style.left = (ev.clientX + 14) + 'px';
      tip.style.top = (ev.clientY + 12) + 'px';
      refreshTip();
    });
    gHit.addEventListener('pointerleave', hideTip);
    boardEl.replaceChildren(svg);
    updatePctScale();
    paintClues();
    paintPlay();
  }
  function updatePctScale() {
    const svg = boardEl.querySelector('svg');
    if (!svg || !svg.clientWidth) return;
    const k = svg.viewBox.baseVal.width / svg.clientWidth; // user units per screen px
    svg.style.setProperty('--pct-size', (11 * k).toFixed(2) + 'px');
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updatePctScale).observe(boardEl);
  else window.addEventListener('resize', updatePctScale);
  function paintClues() {
    for (let e = 0; e < clueEls.length; e++)
      clueEls[e].setAttribute('display', clues.has(e) ? '' : 'none');
    for (let f = 0; f < dotClueEls.length; f++) {
      const dc = dotClueEls[f];
      const isIn = clues.has(dotIn(f));
      dc.setAttribute('display', isIn || clues.has(dotOut(f)) ? '' : 'none');
      dc.setAttribute('class', 'celldot ' + (isIn ? 'in' : 'out'));
    }
  }
  let showForced = true, showForcedDots = true;
  let showHeat = true, showCellHeat = true, highlightRare = false, highlightRareDots = false, showPct = false;
  let hoverEdge = -1, hoverCell = -1;
  function hideTip() { hoverEdge = -1; hoverCell = -1; $('tip').style.display = 'none'; }
  function refreshTip() {
    const tip = $('tip');
    const sols = engine && tab === 'create' ? engine.solutions : 0;
    if ((hoverEdge < 0 && hoverCell < 0) || sols === 0) { tip.style.display = 'none'; return; }
    if (hoverEdge >= 0) {
      if (clues.has(hoverEdge)) {
        tip.innerHTML = '<i>Given</i>';
      } else {
        const p = Math.round((engine.heat[hoverEdge] / sols) * 1000) / 10;
        tip.textContent = p + '% of solutions';
      }
    } else if (clues.has(dotIn(hoverCell)) || clues.has(dotOut(hoverCell))) {
      tip.innerHTML = '<i>Given</i>';
    } else {
      const p = Math.round((engine.cellHeat[hoverCell] / sols) * 1000) / 10;
      tip.textContent = 'inside ' + p + '% of solutions';
    }
    tip.style.display = 'block';
  }
  function paintHeat() {
    const E = heatEls.length;
    // the heat engine belongs to the Create board; never paint it in Play
    const sols = engine && tab === 'create' ? engine.solutions : 0;
    if (sols === 0) {
      for (let e = 0; e < E; e++) {
        heatEls[e].setAttribute('display', 'none');
        neverEls[e].setAttribute('display', 'none');
        pctEls[e].setAttribute('display', 'none');
      }
      for (let f = 0; f < cellHeatEls.length; f++) cellHeatEls[f].setAttribute('display', 'none');
      refreshTip();
      return;
    }
    // three independent edge overlays: forced (green / ×, certain only once
    // the search completes), unlikely (purple, rarest nonzero count), heatmap
    // (frequency gradient); the strongest applicable one wins per edge
    const heat = engine.heat;
    const complete = engine.done;
    let rareH = -1; // edges tied for the fewest solutions
    if (highlightRare) {
      let minH = Infinity;
      for (let e = 0; e < E; e++) { const h = heat[e]; if (h > 0 && h < minH) minH = h; }
      rareH = minH;
    }
    for (let e = 0; e < E; e++) {
      const h = heat[e], line = heatEls[e], mark = neverEls[e], pct = pctEls[e];
      if (showPct && h > 0) {
        const p = (h / sols) * 100;
        pct.textContent = clues.has(e) ? '-' : p >= 99.95 ? '100' : p < 1 ? '<1' : String(Math.round(p));
        pct.setAttribute('display', '');
      } else pct.setAttribute('display', 'none');
      if (h === 0) {
        line.setAttribute('display', 'none');
        mark.setAttribute('display', showForced && complete ? '' : 'none');
        continue;
      }
      mark.setAttribute('display', 'none');
      if (showForced && complete && h === sols) { // forced: in every solution
        line.setAttribute('display', '');
        line.setAttribute('stroke-width', '3.4');
        line.setAttribute('stroke-opacity', '0.95');
        line.style.stroke = 'var(--ok)';
        continue;
      }
      if (highlightRare && h === rareH && h < sols) { // tied for the fewest solutions
        line.setAttribute('display', '');
        line.setAttribute('stroke-width', '3.4');
        line.setAttribute('stroke-opacity', '0.95');
        line.style.stroke = 'var(--rare)';
        continue;
      }
      if (!showHeat) { line.setAttribute('display', 'none'); continue; }
      line.setAttribute('display', '');
      const f = h / sols;
      line.setAttribute('stroke-width', (1.4 + 2.0 * f).toFixed(2));
      line.setAttribute('stroke-opacity', (0.35 + 0.65 * f).toFixed(3));
      const p = Math.round(f * 100);
      line.style.stroke = `color-mix(in oklab, var(--heat-lo) ${100 - p}%, var(--heat-hi))`;
    }
    // cell dots get the same three overlays: filled circle = mostly indoors,
    // hollow = mostly outdoors, on the edge heat's opacity/color scale
    const ch = engine.cellHeat;
    let rareDotC = -1; // minority-side count tied for smallest: the percentage
    if (highlightRareDots) { // nearest 0% or 100% (either dot fits)
      let mn = Infinity;
      for (let f = 0; f < cellHeatEls.length; f++) {
        if (clues.has(dotIn(f)) || clues.has(dotOut(f))) continue;
        const mc = Math.min(ch[f], sols - ch[f]);
        if (mc > 0 && mc < mn) mn = mc;
      }
      if (mn < Infinity) rareDotC = mn;
    }
    for (let f = 0; f < cellHeatEls.length; f++) {
      const c = cellHeatEls[f];
      if (clues.has(dotIn(f)) || clues.has(dotOut(f))) {
        c.setAttribute('display', 'none');
        continue;
      }
      if (rareDotC > 0 && Math.min(ch[f], sols - ch[f]) === rareDotC) {
        // show the rare dot itself: the minority orientation
        const rareIn = 2 * ch[f] < sols;
        c.setAttribute('display', '');
        c.setAttribute('r', '5.60');
        c.setAttribute('opacity', '0.95');
        if (rareIn) { c.style.fill = 'var(--rare)'; c.style.stroke = 'none'; }
        else { c.style.fill = 'none'; c.style.stroke = 'var(--rare)'; c.setAttribute('stroke-width', '2'); }
        continue;
      }
      const isIn = 2 * ch[f] >= sols, m = (isIn ? ch[f] : sols - ch[f]) / sols;
      const forced = showForcedDots && complete && m === 1;
      if (!forced && !showCellHeat) { c.setAttribute('display', 'none'); continue; }
      c.setAttribute('display', '');
      c.setAttribute('r', (3.6 + 2.0 * m).toFixed(2));
      c.setAttribute('opacity', forced ? '0.95' : (0.35 + 0.65 * m).toFixed(3));
      const col = forced ? 'var(--ok)'
        : `color-mix(in oklab, var(--heat-lo) ${100 - Math.round(m * 100)}%, var(--heat-hi))`;
      if (isIn) { c.style.fill = col; c.style.stroke = 'none'; }
      else { c.style.fill = 'none'; c.style.stroke = col; c.setAttribute('stroke-width', '2'); }
    }
    refreshTip();
  }

  function paintBangs() {
    const set = tab === 'create' && waste.on && waste.result ? waste.result : null;
    for (let e = 0; e < bangEls.length; e++)
      bangEls[e].setAttribute('display', set && set.has(e) ? '' : 'none');
    for (let f = 0; f < cellBangEls.length; f++)
      cellBangEls[f].setAttribute('display', set && (set.has(dotIn(f)) || set.has(dotOut(f))) ? '' : 'none');
  }

  // ---------- wasteful-clue analysis ----------
  // A clue is "wasteful" when deleting it grows the solution count the least,
  // i.e. it minimizes N(c) = #solutions of (clues minus c). One sub-solver per
  // clue runs round-robin; a solver whose running count already exceeds the
  // best completed count can never be a minimizer and is dropped early.
  const waste = {
    on: false,
    key: null,
    result: null,      // Set of wasteful clue edges, or null while unknown
    note: '',
    solvers: null,     // in-flight analysis, or null
    minDone: Infinity,
    cache: new Map(),  // cacheKey -> { result, note }, insertion order = LRU
    sync() {
      if (!this.on) return;
      const key = cacheKey();
      if (key === this.key && (this.solvers || this.result || this.note)) return;
      this.key = key;
      this.solvers = null; this.result = null; this.note = ''; this.minDone = Infinity;
      if (clues.size === 0) return;
      const hit = this.cache.get(key);
      if (hit) {
        this.cache.delete(key); this.cache.set(key, hit); // LRU bump
        this.result = hit.result; this.note = hit.note;
        return;
      }
      if (clues.size > 400) { this.note = 'Too many clues to analyze'; return; }
      const all = [...clues];
      this.solvers = all.map(c => ({ c, eng: new Fences(R, C, all.filter(x => x !== c), { loops: L }), state: 'run' }));
    },
    step() {
      if (!this.on || !this.solvers) return false;
      const t0 = performance.now();
      for (;;) {
        let live = 0;
        for (const s of this.solvers) {
          if (s.state !== 'run') continue;
          live++;
          s.eng.run(1.2);
          if (s.eng.done) {
            s.state = 'done';
            if (s.eng.solutions < this.minDone) this.minDone = s.eng.solutions;
          }
          else if (s.eng.solutions > this.minDone) s.state = 'out';
          else if (s.eng.solutions > 20000 || s.eng.nodes > 8e6) s.state = 'cap';
          if (performance.now() - t0 > 6) return true;
        }
        if (live === 0) break;
      }
      // settled: minimum over completed counts; a capped solver whose partial
      // count is not above that minimum is genuinely unknown
      let result = null, note = '';
      if (this.minDone === Infinity) note = 'Too many solutions to analyze';
      else {
        result = new Set();
        let unknown = 0;
        for (const s of this.solvers) {
          if (s.state === 'done' && s.eng.solutions === this.minDone) result.add(s.c);
          else if (s.state === 'cap' && s.eng.solutions <= this.minDone) unknown++;
        }
        if (unknown) note = 'Approximate: some clues were too costly to score';
      }
      this.result = result; this.note = note; this.solvers = null;
      this.cache.set(this.key, { result, note });
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
      paintBangs();
      return false;
    },
  };

  // ---------- status ----------
  const fmtInt = n => n.toLocaleString('en-US');
  const fmtNodes = n => n < 1e6 ? fmtInt(n) : (n / 1e6).toFixed(1) + ' M';
  function fmtTime(ms) {
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + ' s';
    return `${(s / 60) | 0}:${String((s % 60) | 0).padStart(2, '0')} min`;
  }
  function setChip(kind, text) {
    $('chip').dataset.kind = kind;
    $('chipText').textContent = text;
  }
  function updateStatus() {
    const sols = engine ? engine.solutions : 0;
    $('stClues').textContent = fmtInt(clues.size);
    $('stSolutions').textContent = fmtInt(sols);
    $('stNodes').textContent = engine ? fmtNodes(engine.nodes) : '0';
    $('stTime').textContent = fmtTime(engine ? engine.elapsedMs : 0);
    $('freqScale').classList.toggle('off', !(sols > 1 && (showHeat || showCellHeat)));

    updateWasteUI();

    if (engine && engine.impossible)
      setChip('bad', engine.impossible === 'loops' ? 'Too many loops for this grid' : 'Impossible grid');
    else if (engine && engine.done) {
      if (sols === 0) setChip('bad', 'No solutions');
      else if (sols === 1) setChip('ok', 'Unique solution');
      else setChip('ok', `${fmtInt(sols)} solutions`);
    }
    else if (stopped) setChip('warn', 'Stopped');
    else if (paused) setChip('warn', 'Paused');
    else setChip('search', 'Searching…');
  }
  function updateButtons() {
    const searching = running && engine && !engine.done && !stopped && !paused;
    const play = $('playBtn');
    play.textContent = searching ? '⏸' : '▶';
    play.setAttribute('aria-label', searching ? 'Pause' : 'Play');
    $('stopBtn').disabled = !engine;
    // a board is only a shareable puzzle when its solution is unique
    const unique = engine && engine.done && engine.solutions === 1;
    $('shareBtn').disabled = !unique;
    $('shareBtn').title = unique ? '' : 'Share needs a unique solution';
  }
  function updateWasteUI() {
    const st = $('wasteStatus');
    $('keyBang').hidden = !(waste.on && waste.result && waste.result.size);
    if (!waste.on) { st.hidden = true; return; }
    let txt = '';
    if (waste.solvers) {
      const settled = waste.solvers.reduce((n, s) => n + (s.state !== 'run'), 0);
      txt = `Weighing clues… ${settled}/${waste.solvers.length}`;
    } else if (waste.note) txt = waste.note;
    else if (waste.result && waste.result.size)
      txt = `${waste.result.size} wasteful clue${waste.result.size > 1 ? 's' : ''}`;
    st.textContent = txt;
    st.hidden = !txt;
  }
  // ---------- solve loop ----------
  const mc = new MessageChannel();
  let scheduled = false;
  mc.port1.onmessage = () => { scheduled = false; tick(); };
  function schedule() { if (!scheduled) { scheduled = true; mc.port2.postMessage(0); } }

  function tick() {
    let more = false;
    if (tab === 'create' && running && !paused && !stopped && engine && !engine.done) {
      const t0 = performance.now();
      engine.run(12);
      engine.elapsedMs += performance.now() - t0;
      if (engine.done) running = false;
      else more = true;
    }
    if (tab === 'create' && waste.step()) more = true;
    if (pv.step()) more = true;
    const now = performance.now();
    if (now - lastPaint > 110 || !more) { paintHeat(); paintBangs(); lastPaint = now; }
    updateStatus(); updateButtons();
    if (more) schedule();
  }

  function restartSolve() {
    const key = cacheKey();
    let cached = stateCache.get(key);
    if (cached) {
      stateCache.delete(key); stateCache.set(key, cached); // LRU bump
    } else {
      cached = new Fences(R, C, clues, { loops: L });
      cached.elapsedMs = 0;
      stateCache.set(key, cached);
      if (stateCache.size > CACHE_MAX) stateCache.delete(stateCache.keys().next().value);
    }
    engine = cached;
    running = !engine.done;
    paused = false; stopped = false;
    lastPaint = 0;
    waste.sync();
    paintHeat(); paintBangs();
    updateStatus(); updateButtons();
    schedule();
  }

  // ---------- interactions ----------
  // clue edits feed the create solver or the play verifier, by tab
  function afterCluesChanged() {
    paintClues();
    if (tab === 'create') restartSolve();
    else { byline = ''; pv.key = null; pv.sync(); }
  }

  function toggleClue(e) {
    if (clues.has(e)) clues.delete(e); else clues.add(e);
    afterCluesChanged();
  }

  function toggleDot(f) { // cycle: none -> indoors -> outdoors -> none
    const a = dotIn(f), b = dotOut(f);
    if (clues.has(a)) { clues.delete(a); clues.add(b); }
    else if (clues.has(b)) clues.delete(b);
    else clues.add(a);
    afterCluesChanged();
  }

  function clearDot(f) { // right-click: drop whatever dot the cell carries
    const a = dotIn(f), b = dotOut(f);
    if (!clues.has(a) && !clues.has(b)) return;
    clues.delete(a); clues.delete(b);
    afterCluesChanged();
  }

  $('playBtn').addEventListener('click', () => {
    if (running && !stopped) { // pause / resume the live search
      paused = !paused;
      updateStatus(); updateButtons();
      if (!paused) schedule();
      return;
    }
    stateCache.delete(cacheKey()); // stopped or finished: fresh search
    restartSolve();
  });
  $('stopBtn').addEventListener('click', () => {
    stopped = true; running = false; paused = false;
    stateCache.delete(cacheKey()); // a later play starts from scratch
    engine = null;                 // stats and heat read as zero
    paintHeat(); paintBangs();
    updateStatus(); updateButtons();
  });
  // overlay toggles are independent; updateStatus keeps the gradient legend in step
  function bindOverlay(id, set) {
    $(id).addEventListener('change', () => {
      set($(id).checked);
      paintHeat();
      updateStatus();
    });
  }
  bindOverlay('forcedChk', v => showForced = v);
  bindOverlay('forcedDotChk', v => showForcedDots = v);
  bindOverlay('heatChk', v => showHeat = v);
  bindOverlay('cellHeatChk', v => showCellHeat = v);
  bindOverlay('rareChk', v => highlightRare = v);
  bindOverlay('rareDotChk', v => highlightRareDots = v);
  bindOverlay('pctChk', v => showPct = v);
  $('wasteChk').addEventListener('change', () => {
    waste.on = $('wasteChk').checked;
    waste.sync();
    paintBangs();
    updateStatus();
    schedule();
  });
  $('clearBtn').addEventListener('click', () => {
    clues.clear();
    paintClues();
    restartSolve();
  });

  function applySize() {
    const c = Math.min(40, Math.max(2, +$('colsIn').value || 10));
    const r = Math.min(40, Math.max(2, +$('rowsIn').value || 10));
    $('colsIn').value = c; $('rowsIn').value = r;
    if (r === R && c === C) return;
    R = r; C = c;
    clues.clear();
    buildBoard();
    restartSolve();
  }
  $('colsIn').addEventListener('change', applySize);
  $('rowsIn').addEventListener('change', applySize);

  function applyLoops() {
    const l = Math.min(400, Math.max(1, +$('loopsIn').value || 1));
    $('loopsIn').value = l;
    if (l === L) return;
    L = l; // clues stay: they mean the same thing under any loop count
    restartSolve();
  }
  $('loopsIn').addEventListener('change', applyLoops);

  // ---------- play mode ----------
  // setup-phase verifier: a puzzle is playable when it has exactly one
  // solution; two found solutions settle non-uniqueness, so stop there
  const pv = {
    key: null, eng: null, solution: null,
    sync() {
      if (tab !== 'play' || playPhase !== 'setup') return;
      const key = cacheKey();
      if (key === this.key) { updatePlayUI(); return; }
      this.key = key;
      this.solution = null;
      this.eng = new Fences(R, C, clues, { loops: L, maxSolutions: 2 });
      if (this.eng.done && this.eng.solutions === 1) this.solution = new Set(this.eng.lastSolution);
      updatePlayUI();
      updateSharedPrompt();
      schedule();
    },
    step() { // one budget slice per tick; true while more work remains
      if (tab !== 'play' || playPhase !== 'setup' || !this.eng || this.eng.done) return false;
      this.eng.run(12);
      if (this.eng.done && this.eng.solutions === 1) this.solution = new Set(this.eng.lastSolution);
      updatePlayUI();
      updateSharedPrompt();
      return !this.eng.done;
    },
  };

  function setPChip(kind, text) {
    $('pChip').dataset.kind = kind;
    $('pChipText').textContent = text;
  }
  function updatePlayUI() {
    if (tab !== 'play') return;
    const setup = playPhase === 'setup';
    $('playSetupCard').hidden = !setup;
    $('playRunCard').hidden = setup;
    if (setup) {
      const eng = pv.eng;
      if (!eng) setPChip('warn', 'Enter a puzzle');
      else if (eng.impossible) setPChip('bad', eng.impossible === 'loops' ? 'Too many loops for this grid' : 'Impossible grid');
      else if (!eng.done) setPChip('search', 'Checking…');
      else if (eng.solutions === 1) setPChip('ok', 'Unique solution — ready');
      else if (eng.solutions === 0) setPChip('bad', 'No solutions — remove a clue');
      else setPChip('bad', 'Multiple solutions — add clues');
      $('startBtn').disabled = !pv.solution;
    } else {
      $('runInfo').textContent =
        `${R}×${C} dots · ${L} loop${L > 1 ? 's' : ''} · ${clues.size} clue${clues.size === 1 ? '' : 's'}`;
      $('runByline').textContent = `Puzzle by ${byline || 'Anonymous'}`;
      $('timer').hidden = !$('timerChk').checked;
      $('pResetBtn').disabled = playPhase !== 'run';
      $('undoBtn').disabled = !playUndo.length;
      $('redoBtn').disabled = playPhase !== 'run' || !playRedo.length;
      $('degree2Chk').disabled = playPhase !== 'run';
    }
  }

  function vertexDegreeState(v) {
    return FencesRules.vertexDegreeState(R, C, v, clues, playMarks);
  }

  function applyDegree2Helper(action, protectedEdge = -1) {
    if (!$('degree2Chk').checked || !playMarks) return;
    const result = FencesRules.applyDegree2(R, C, clues, playMarks, protectedEdge);
    playMarks = result.marks;
    action.push(...result.changes);
  }

  function cancelDegree2Helper() {
    clearTimeout(degreeHelperTimer);
    degreeHelperTimer = null;
  }

  function scheduleDegree2Helper(action, protectedEdge) {
    cancelDegree2Helper();
    if (!$('degree2Chk').checked) return;
    degreeHelperTimer = setTimeout(() => {
      degreeHelperTimer = null;
      if (tab !== 'play' || playPhase !== 'run' || !$('degree2Chk').checked) return;
      applyDegree2Helper(action, protectedEdge);
      if (solvedNow()) { winGame(); return; }
      paintPlay();
      updatePlayUI();
    }, DEGREE_HELPER_DELAY_MS);
  }

  function paintPlay() {
    const solving = tab === 'play' && playPhase !== 'setup';
    boardEl.classList.toggle('playing', solving);
    for (let e = 0; e < playEls.length; e++) {
      const m = solving && playMarks ? playMarks[e] : 0;
      playEls[e].setAttribute('display', m === 1 ? '' : 'none');
      if (m === 1) playEls[e].style.stroke = playPhase === 'won' ? 'var(--ok)' : '';
      playXEls[e].setAttribute('display', m === 2 ? '' : 'none');
    }
    const showDegreeErrors = solving && playMarks && $('degree2Chk').checked;
    for (let v = 0; v < dotEls.length; v++) {
      const invalid = showDegreeErrors && vertexDegreeState(v).invalid;
      dotEls[v].classList.toggle('degree-error', invalid);
    }
  }

  function playToggle(e) { // cycle: none -> fence -> × -> none
    if (playPhase !== 'run' || clues.has(e)) return;
    const before = playMarks[e], after = (before + 1) % 3;
    playMarks[e] = after;
    const action = [[e, before, after]];
    playUndo.push(action);
    playRedo = [];
    if (solvedNow()) { winGame(); return; }
    paintPlay();
    updatePlayUI();
    scheduleDegree2Helper(action, e);
  }
  function solvedNow() {
    const E = Ecount();
    for (let e = 0; e < E; e++)
      if (playSolution.has(e) !== (playMarks[e] === 1 || clues.has(e))) return false;
    return true;
  }

  function startPlay() {
    if (!pv.solution) return;
    cancelDegree2Helper();
    sharedPuzzlePrompt = false;
    returnToSharedPrompt = false;
    returnToAboutPrompt = false;
    autoStartPuzzle = false;
    if ($('sharedDialog').open) $('sharedDialog').close();
    playSolution = pv.solution;
    playMarks = new Int8Array(Ecount());
    playUndo = []; playRedo = [];
    $('degree2Chk').checked = false;
    playPhase = 'run';
    playT0 = performance.now();
    clearInterval(timerIv);
    timerIv = setInterval(() => {
      if (playPhase === 'run') $('timer').textContent = fmtTime(performance.now() - playT0);
    }, 100);
    $('timer').textContent = '0.0 s';
    paintPlay();
    updatePlayUI();
    updateHint();
    if (solvedNow()) winGame(); // degenerate code: every solution edge given
  }
  function updateSharedPrompt() {
    const eng = pv.eng;
    if (autoStartPuzzle) {
      if (!eng || !eng.done) return;
      autoStartPuzzle = false;
      if (pv.solution) startPlay();
      return;
    }
    if (!sharedPuzzlePrompt) return;
    const start = $('sharedStartBtn'), status = $('sharedStatus');
    start.disabled = !pv.solution;
    if (!eng || !eng.done) {
      status.dataset.kind = '';
      status.textContent = 'Checking puzzle…';
    } else if (pv.solution) {
      status.dataset.kind = 'ok';
      status.textContent = 'Puzzle checked — ready to start.';
    } else {
      status.dataset.kind = 'bad';
      status.textContent = eng.solutions === 0
        ? 'This puzzle has no solution.'
        : 'This puzzle has more than one solution.';
    }
  }
  function winGame() {
    cancelDegree2Helper();
    playPhase = 'won';
    playMs = performance.now() - playT0;
    clearInterval(timerIv); timerIv = null;
    $('timer').textContent = fmtTime(playMs);
    $('winText').textContent =
      `${R}×${C} dots · ${L} loop${L > 1 ? 's' : ''} · solved in ${fmtTime(playMs)}`;
    $('winOverlay').hidden = false;
    paintPlay();
    updatePlayUI();
  }
  function quitPlay() { // back to setup; the verified puzzle stays loaded
    cancelDegree2Helper();
    playPhase = 'setup';
    playUndo = []; playRedo = [];
    clearInterval(timerIv); timerIv = null;
    $('winOverlay').hidden = true;
    paintPlay();
    updatePlayUI();
    updateHint();
  }

  function resumePlayAfterWin() {
    playPhase = 'run';
    $('winOverlay').hidden = true;
    playT0 = performance.now() - playMs;
    clearInterval(timerIv);
    timerIv = setInterval(() => {
      if (playPhase === 'run') $('timer').textContent = fmtTime(performance.now() - playT0);
    }, 100);
  }

  function applyPlayHistory(action, redo) {
    if (!action || !playMarks) return;
    if (playPhase === 'won') resumePlayAfterWin();
    const changes = redo ? action : action.slice().reverse();
    for (const [e, before, after] of changes) playMarks[e] = redo ? after : before;
    paintPlay();
    updatePlayUI();
    if (solvedNow()) winGame();
  }

  function undoPlay() {
    if ((playPhase !== 'run' && playPhase !== 'won') || !playUndo.length) return;
    cancelDegree2Helper();
    const action = playUndo.pop();
    playRedo.push(action);
    applyPlayHistory(action, false);
  }

  function redoPlay() {
    if (playPhase !== 'run' || !playRedo.length) return;
    cancelDegree2Helper();
    const action = playRedo.pop();
    playUndo.push(action);
    applyPlayHistory(action, true);
  }

  function updateHint() {
    $('hint').innerHTML = tab === 'play' && playPhase !== 'setup'
      ? 'Click an edge to draw a fence · click again for ×, again to clear'
      : 'Click an edge for a fence clue · click a cell&rsquo;s middle to mark it inside&nbsp;● or outside&nbsp;○ · right-click a dot to remove it';
  }

  // play setup: entry method, level code, manual dimensions
  document.querySelectorAll('input[name="entry"]').forEach(rb =>
    rb.addEventListener('change', () => {
      const manual = document.querySelector('input[name="entry"]:checked').value === 'manual';
      if (manual) byline = '';
      $('codeRow').hidden = manual;
      $('codeErr').hidden = true;
      $('manualRows').hidden = !manual;
    }));
  function setPuzzle(p) {
    R = p.R; C = p.C; L = p.L; clues = p.clues; byline = p.byline || '';
    $('pRowsIn').value = R; $('pColsIn').value = C; $('pLoopsIn').value = L;
  }
  function showCodeEntry(code, invalid = false) {
    document.querySelector('input[name="entry"][value="code"]').checked = true;
    $('codeIn').value = code;
    $('codeRow').hidden = false;
    $('manualRows').hidden = true;
    $('codeErr').hidden = !invalid;
  }
  function loadSharedPuzzle(code, showPrompt = true) {
    const p = parseCode(code);
    if (!p) {
      sharedPuzzlePrompt = false;
      returnToSharedPrompt = false;
      autoStartPuzzle = false;
      if ($('sharedDialog').open) $('sharedDialog').close();
      if (playPhase === 'setup') showCodeEntry(code, true);
      return false;
    }
    if (tab !== 'play') switchTab('play');
    if (playPhase !== 'setup') quitPlay();
    document.querySelectorAll('.export-overlay:not(#winOverlay)').forEach(el => el.remove());
    showCodeEntry(code);
    setPuzzle(p);
    buildBoard();
    sharedPuzzlePrompt = showPrompt;
    autoStartPuzzle = !showPrompt;
    $('sharedInfo').textContent =
      `${R}×${C} dots · ${L} loop${L > 1 ? 's' : ''} · ${clues.size} clue${clues.size === 1 ? '' : 's'}`;
    $('sharedByline').textContent = byline ? `by ${byline}` : '';
    $('sharedByline').hidden = !byline;
    $('sharedStartBtn').disabled = true;
    $('sharedStatus').dataset.kind = '';
    $('sharedStatus').textContent = 'Checking puzzle…';
    if (showPrompt && !$('sharedDialog').open) $('sharedDialog').showModal();
    else if (!showPrompt && $('sharedDialog').open) $('sharedDialog').close();
    pv.key = null; pv.sync();
    updateHint();
    return true;
  }
  function loadCode() {
    const p = parseCode($('codeIn').value);
    if (!p) { $('codeErr').hidden = false; return; }
    sharedPuzzlePrompt = false;
    returnToSharedPrompt = false;
    autoStartPuzzle = false;
    if ($('sharedDialog').open) $('sharedDialog').close();
    $('codeErr').hidden = true;
    setPuzzle(p);
    buildBoard();
    pv.key = null; pv.sync();
  }
  $('loadBtn').addEventListener('click', loadCode);
  $('codeIn').addEventListener('keydown', ev => { if (ev.key === 'Enter') loadCode(); });
  function pApplySize() {
    const c = Math.min(40, Math.max(2, +$('pColsIn').value || 8));
    const r = Math.min(40, Math.max(2, +$('pRowsIn').value || 8));
    $('pColsIn').value = c; $('pRowsIn').value = r;
    if (r === R && c === C) return;
    R = r; C = c;
    byline = '';
    clues.clear();
    buildBoard();
    pv.key = null; pv.sync();
  }
  $('pColsIn').addEventListener('change', pApplySize);
  $('pRowsIn').addEventListener('change', pApplySize);
  $('pLoopsIn').addEventListener('change', () => {
    const l = Math.min(400, Math.max(1, +$('pLoopsIn').value || 1));
    $('pLoopsIn').value = l;
    if (l === L) return;
    L = l;
    byline = '';
    pv.key = null; pv.sync();
  });
  $('pClearBtn').addEventListener('click', () => {
    clues.clear();
    afterCluesChanged();
  });
  $('startBtn').addEventListener('click', startPlay);
  $('timerChk').addEventListener('change', updatePlayUI);
  $('degree2Chk').addEventListener('change', () => {
    cancelDegree2Helper();
    if (playPhase !== 'run' || !playMarks) { paintPlay(); return; }
    const action = [];
    applyDegree2Helper(action);
    if (action.length) {
      playUndo.push(action);
      playRedo = [];
    }
    if (solvedNow()) { winGame(); return; }
    paintPlay();
    updatePlayUI();
  });
  $('undoBtn').addEventListener('click', undoPlay);
  $('redoBtn').addEventListener('click', redoPlay);
  $('pResetBtn').addEventListener('click', () => {
    if (playPhase !== 'run' || !playMarks) return;
    cancelDegree2Helper();
    const action = [];
    for (let e = 0; e < playMarks.length; e++)
      if (playMarks[e]) action.push([e, playMarks[e], 0]);
    for (const [e] of action) playMarks[e] = 0;
    applyDegree2Helper(action);
    if (!action.length) return;
    playUndo.push(action);
    playRedo = [];
    if (solvedNow()) { winGame(); return; }
    paintPlay();
    updatePlayUI();
  });
  const quitDialog = $('quitDialog');
  $('quitBtn').addEventListener('click', () => {
    if (!quitDialog.open) quitDialog.showModal();
  });
  $('quitCancelBtn').addEventListener('click', () => quitDialog.close());
  $('quitConfirmBtn').addEventListener('click', () => {
    quitDialog.close();
    quitPlay();
  });
  quitDialog.addEventListener('click', ev => { if (ev.target === quitDialog) quitDialog.close(); });
  document.addEventListener('keydown', ev => {
    if (tab !== 'play' || playPhase === 'setup' || document.querySelector('dialog[open]') || !(ev.metaKey || ev.ctrlKey)) return;
    const target = ev.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    const key = ev.key.toLowerCase();
    if (key === 'z' && ev.shiftKey) { ev.preventDefault(); redoPlay(); }
    else if (key === 'z') { ev.preventDefault(); undoPlay(); }
    else if (key === 'y') { ev.preventDefault(); redoPlay(); }
  });
  $('winCloseBtn').addEventListener('click', () => { $('winOverlay').hidden = true; });
  $('winOverlay').addEventListener('click', ev => { if (ev.target === $('winOverlay')) $('winOverlay').hidden = true; });

  // ---------- tab switching ----------
  function switchTab(t) {
    if (t === tab) return;
    cancelDegree2Helper();
    tabState[tab] = { R, C, L, clues, byline };
    tab = t;
    const s = tabState[t];
    R = s.R; C = s.C; L = s.L; clues = s.clues; byline = s.byline || '';
    $('tabPlay').setAttribute('aria-selected', String(t === 'play'));
    $('tabCreate').setAttribute('aria-selected', String(t === 'create'));
    $('createCard').hidden = t !== 'create';
    buildBoard();
    if (t === 'create') {
      $('playSetupCard').hidden = true;
      $('playRunCard').hidden = true;
      restartSolve();
    } else {
      pv.sync();
      updatePlayUI();
      schedule();
    }
    updateHint();
  }
  $('tabPlay').addEventListener('click', () => switchTab('play'));
  $('tabCreate').addEventListener('click', () => switchTab('create'));

  // ---------- rules ----------
  const aboutDialog = $('aboutDialog');
  const sharedDialog = $('sharedDialog');
  const rulesDialog = $('rulesDialog');
  function hideAboutMessage() {
    try { return localStorage.getItem(HIDE_ABOUT_KEY) === '1'; }
    catch { return false; }
  }
  function saveAboutPreference() {
    try {
      if ($('dontShowAboutChk').checked) localStorage.setItem(HIDE_ABOUT_KEY, '1');
      else localStorage.removeItem(HIDE_ABOUT_KEY);
    } catch { /* storage can be unavailable in private or sandboxed contexts */ }
  }
  function openRules() {
    $('rulesLede').textContent = L === 1
      ? 'Draw one continuous loop along the grid lines. It must pass through every dot.'
      : `Draw exactly ${L} separate loops along the grid lines. Every dot must belong to one of them.`;
    if (!rulesDialog.open) rulesDialog.showModal();
  }
  function closeRules() { if (rulesDialog.open) rulesDialog.close(); }
  $('rulesOpen').addEventListener('click', openRules);
  $('rulesClose').addEventListener('click', closeRules);
  $('rulesGotIt').addEventListener('click', closeRules);
  rulesDialog.addEventListener('click', ev => { if (ev.target === rulesDialog) closeRules(); });
  rulesDialog.addEventListener('close', () => {
    if (returnToSharedPrompt) {
      returnToSharedPrompt = false;
      if (sharedPuzzlePrompt && playPhase === 'setup' && !sharedDialog.open) sharedDialog.showModal();
    } else if (returnToAboutPrompt) {
      returnToAboutPrompt = false;
      if (playPhase === 'setup' && !aboutDialog.open) aboutDialog.showModal();
    }
  });
  $('sharedRulesBtn').addEventListener('click', () => {
    returnToSharedPrompt = true;
    sharedDialog.close();
    openRules();
  });
  $('sharedStartBtn').addEventListener('click', startPlay);
  $('dontShowAboutChk').addEventListener('change', saveAboutPreference);
  $('aboutRulesBtn').addEventListener('click', () => {
    returnToAboutPrompt = true;
    aboutDialog.close();
    openRules();
  });
  $('samplePuzzleBtn').addEventListener('click', () => {
    returnToAboutPrompt = false;
    aboutDialog.close();
    loadSharedPuzzle(SAMPLE_CODE, false);
  });

  // ---------- share ----------
  // one dialog for both modes: a direct puzzle link, the level code, and a high-res PNG puzzle
  // sheet (title, optional byline, the bare puzzle, rules underneath)
  function openShare() {
    // create shares its live board (unique only); play shares its verified puzzle
    if (tab === 'create' && !(engine && engine.done && engine.solutions === 1)) return;
    const CELL = 120, P = 80;
    const E = Ecount();
    const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
    const canvas = document.createElement('canvas');
    const img = document.createElement('img');
    function render(name) {
      const gridW = (C - 1) * CELL, gridH = (R - 1) * CELL;
      const W = Math.max(gridW + 2 * P, 760);
      const gridX = (W - gridW) / 2;
      const titleSize = 78, subSize = 40, ruleSize = 34, ruleLH = 48, ruleGap = 14, indent = 36;
      const gridY = 56 + titleSize + (name ? 16 + subSize : 0) + 64;
      // only the rules this puzzle needs
      let hasEdge = false, hasIn = false, hasOut = false;
      for (const id of clues) {
        if (id < E) hasEdge = true;
        else if ((id - E) & 1) hasOut = true;
        else hasIn = true;
      }
      const NUMS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
      const nLoops = L < 10 ? NUMS[L] : String(L);
      const rules = [L === 1
        ? 'Draw a single loop along the grid lines so that it passes through every dot.'
        : `Draw exactly ${nLoops} separate loops along the grid lines so that every dot lies on exactly one loop. No loop may lie inside another, and all loops must enclose the same number of cells.`];
      if (hasEdge) rules.push(L === 1 ? 'The teal edges are part of the loop.' : 'The teal edges are part of the loops.');
      if (hasIn && hasOut) rules.push(L === 1
        ? 'A filled circle marks a cell inside the loop; a hollow circle, a cell outside it.'
        : 'A filled circle marks a cell inside a loop; a hollow circle, a cell outside the loops.');
      else if (hasIn) rules.push(L === 1
        ? 'A filled circle marks a cell that lies inside the loop.'
        : 'A filled circle marks a cell that lies inside a loop.');
      else if (hasOut) rules.push(L === 1
        ? 'A hollow circle marks a cell that lies outside the loop.'
        : 'A hollow circle marks a cell that lies outside the loops.');
      // wrap each rule to the sheet width, with a hanging indent for its bullet
      let ctx = canvas.getContext('2d');
      ctx.font = `${ruleSize}px ${SERIF}`;
      const wrapW = W - 2 * P - indent;
      const items = rules.map(text => {
        const lines = [];
        let line = '';
        for (const w of text.split(' ')) {
          const t = line ? line + ' ' + w : w;
          if (line && ctx.measureText(t).width > wrapW) { lines.push(line); line = w; }
          else line = t;
        }
        lines.push(line);
        return lines;
      });
      const divY = gridY + gridH + 70;
      const rulesY = divY + 64;
      const nLines = items.reduce((n, ls) => n + ls.length, 0);
      const H = rulesY + (nLines - 1) * ruleLH + (items.length - 1) * ruleGap + ruleSize * 0.35 + 44;
      const k = Math.min(1, 4096 / Math.max(W, H));
      canvas.width = Math.round(W * k); canvas.height = Math.round(H * k);
      ctx = canvas.getContext('2d'); // resizing reset the context state
      ctx.scale(k, k);
      ctx.fillStyle = '#fdf9f1';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#33261a';
      ctx.font = `600 ${titleSize}px ${SERIF}`;
      ctx.fillText('Fences+', P, 56 + titleSize * 0.78);
      if (name) {
        ctx.fillStyle = '#8b7461';
        ctx.font = `italic ${subSize}px ${SERIF}`;
        ctx.fillText('by ' + name, P + 4, 56 + titleSize + 16 + subSize * 0.78);
      }
      ctx.strokeStyle = '#0e6e69';
      ctx.fillStyle = '#0e6e69';
      ctx.lineWidth = 13;
      ctx.lineCap = 'round';
      for (const id of clues) {
        if (id < E) {
          const [x1, y1, x2, y2] = edgeEnds(id);
          ctx.beginPath();
          ctx.moveTo(gridX + x1 * CELL, gridY + y1 * CELL);
          ctx.lineTo(gridX + x2 * CELL, gridY + y2 * CELL);
          ctx.stroke();
        } else { // cell dot: filled = indoors, hollow = outdoors
          const kd = id - E, f = kd >> 1;
          const cx = gridX + (f % (C - 1) + 0.5) * CELL, cy = gridY + (((f / (C - 1)) | 0) + 0.5) * CELL;
          ctx.beginPath();
          ctx.arc(cx, cy, kd & 1 ? 17 : 21, 0, 2 * Math.PI);
          if (kd & 1) ctx.stroke(); else ctx.fill();
        }
      }
      ctx.fillStyle = '#4a3a28';
      for (let r = 0; r < R; r++)
        for (let c = 0; c < C; c++) {
          ctx.beginPath();
          ctx.arc(gridX + c * CELL, gridY + r * CELL, 10, 0, 2 * Math.PI);
          ctx.fill();
        }
      ctx.strokeStyle = '#e3d5bc';
      ctx.lineWidth = 2;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(P, divY); ctx.lineTo(W - P, divY);
      ctx.stroke();
      ctx.font = `${ruleSize}px ${SERIF}`;
      let y = rulesY;
      for (const lines of items) {
        ctx.fillStyle = '#b3541e';
        ctx.fillText('•', P + 2, y);
        ctx.fillStyle = '#5c4a38';
        for (const l of lines) { ctx.fillText(l, P + indent, y); y += ruleLH; }
        y += ruleGap;
      }
      img.src = canvas.toDataURL('image/png');
    }
    render(byline);
    // sandboxed frames block the download API, so show the image instead:
    // right-click / long-press saves it at full resolution
    const ov = document.createElement('div');
    ov.className = 'export-overlay';
    const box = document.createElement('div');
    box.className = 'export-box';
    img.alt = `Fences+ puzzle, ${C} by ${R} dots`;
    const linkRow = document.createElement('div');
    linkRow.className = 'field-row';
    linkRow.style.margin = '0';
    const linkLbl = document.createElement('label');
    linkLbl.textContent = 'Puzzle link';
    const linkOut = document.createElement('input');
    linkOut.type = 'text';
    linkOut.readOnly = true;
    linkOut.setAttribute('aria-label', 'Puzzle link');
    linkOut.value = shareUrl();
    linkOut.addEventListener('focus', () => linkOut.select());
    const copyLink = document.createElement('button');
    copyLink.textContent = 'Copy link';
    copyLink.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(linkOut.value);
        copyLink.textContent = 'Copied ✓';
      } catch { linkOut.select(); copyLink.textContent = 'Copy failed'; }
    });
    linkRow.append(linkLbl, linkOut, copyLink);
    const codeRow = document.createElement('div');
    codeRow.className = 'field-row';
    codeRow.style.margin = '0';
    const codeLbl = document.createElement('label');
    codeLbl.textContent = 'Level code';
    const codeOut = document.createElement('input');
    codeOut.type = 'text';
    codeOut.readOnly = true;
    codeOut.setAttribute('aria-label', 'Level code');
    codeOut.value = codeOf();
    codeOut.addEventListener('focus', () => codeOut.select());
    const copyCode = document.createElement('button');
    copyCode.textContent = 'Copy';
    copyCode.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(codeOut.value);
        copyCode.textContent = 'Copied ✓';
      } catch { codeOut.select(); copyCode.textContent = 'Copy failed'; }
    });
    codeRow.append(codeLbl, codeOut, copyCode);
    let nameRow = null;
    if (tab === 'create') {
      nameRow = document.createElement('div');
      nameRow.className = 'field-row';
      nameRow.style.margin = '0';
      const nameLbl = document.createElement('label');
      nameLbl.textContent = 'By';
      const nameIn = document.createElement('input');
      nameIn.type = 'text';
      nameIn.maxLength = 80;
      nameIn.setAttribute('aria-label', 'Byline');
      nameIn.placeholder = 'optional — adds a “by …” byline';
      nameIn.value = byline;
      nameIn.addEventListener('input', () => {
        byline = nameIn.value.trim();
        codeOut.value = codeOf();
        linkOut.value = shareUrl();
        render(byline);
      });
      nameRow.append(nameLbl, nameIn);
    }
    const note = document.createElement('p');
    note.className = 'note';
    note.style.margin = '0';
    note.textContent = 'Right-click (or long-press) the image and choose “Save image as…”.';
    const row = document.createElement('div');
    row.className = 'btn-row';
    if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
      const copy = document.createElement('button');
      copy.textContent = 'Copy image';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.write([new ClipboardItem({
            'image/png': new Promise(res => canvas.toBlob(res, 'image/png')),
          })]);
          copy.textContent = 'Copied ✓';
        } catch { copy.textContent = 'Copy failed'; }
      });
      row.appendChild(copy);
    }
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.addEventListener('click', () => ov.remove());
    row.appendChild(close);
    ov.addEventListener('click', ev => { if (ev.target === ov) ov.remove(); });
    const contents = [linkRow, codeRow, img];
    if (nameRow) contents.push(nameRow);
    contents.push(note, row);
    box.append(...contents);
    ov.appendChild(box);
    document.body.appendChild(ov);
  }
  $('shareBtn').addEventListener('click', openShare);
  $('pShareBtn').addEventListener('click', openShare);
  $('winShareBtn').addEventListener('click', openShare);

  // ---------- boot ----------
  const sharedCode = codeFromHash();
  if (sharedCode === null) {
    buildBoard();
    updateHint();
    pv.sync();
    if (!hideAboutMessage()) aboutDialog.showModal();
  } else if (!loadSharedPuzzle(sharedCode)) {
    buildBoard();
    updateHint();
    pv.sync();
  }
  window.addEventListener('hashchange', () => {
    const code = codeFromHash();
    if (code !== null) loadSharedPuzzle(code);
  });
})();
