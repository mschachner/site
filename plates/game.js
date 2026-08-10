/* game.js — Plates: all behavior.
 *
 * Loads after data.js, which defines DICT (dictionary), ELIG (eligible clues
 * with difficulty), and SCHED (the baked daily schedule).
 *
 * Sections:
 *   1.  Configuration
 *   2.  Small utilities (DOM, dates, storage)
 *   3.  Core game logic (validity, scoring, answer lists, schedule)
 *   4.  Game state
 *   5.  Persistence (today's progress, lifetime stats, dictionary decisions)
 *   6.  Wordlist rendering (the alphabetical column)
 *   7.  The plate (odometer + rank color)
 *   8.  The road-trip rank rail
 *   9.  Stats
 *   10. Messages & label flashes
 *   11. Play actions (submit, hint, rescue)
 *   12. Finish & sharing (confetti, plate image, copy paths)
 *   13. Modals
 *   14. Dev tools
 *   15. Event wiring & boot
 *
 * Conventions: state lives in module-level variables; every mutation ends by
 * calling render(), which repaints the plate, rail, and counters and persists
 * the day. Rendering reads state, never mutates it (except persistence).
 */

'use strict';

/* ================================================================
 * 1. Configuration
 * ================================================================ */

/** Scrabble-style letter values. */
const SCRABBLE = { a:1, b:3, c:3, d:2, e:1, f:4, g:2, h:4, i:1, j:8, k:5, l:1, m:3,
              n:1, o:1, p:3, q:10, r:1, s:1, t:1, u:1, v:4, w:4, x:8, y:4, z:10 };

/** 9 August 2026 (local time) is day 0 = Plates #1. */
const EPOCH = [2026, 7, 9];

/** Burial bonuses by tier: flat, half-buried, buried. See RULES.md. */
const TIER_BONUS = [0, 10, 25];

/** Points per letter beyond the clue's three. */
const LENGTH_POINTS = 5;

/** Snug (contiguous clue) and Vanity Plate bonuses. */
const SNUG_BONUS = 15;
const VP_BONUS = 250;

/** Rank ladder: name + fraction of the day's perfect score. */
const RANKS = [
  ['Pedestrian',       0],
  ["Learner's Permit", 0.02],
  ['Licensed',         0.095],
  ["Cruisin'",         0.24],
  ['Speeding',         0.38],
  ['Overdrive',        0.52],
  ['Liftoff',          2 / 3],
];

/** One color per rank; the plate (and share image) wear the current one. */
const RANK_COLORS = ['#8a8781', '#17151a', '#1e6b34', '#1b3a8c',
                     '#c05621', '#6b3fa0', '#a8781a'];

/** Liftoff is the show-off plate: gold lettering on this black face. */
const LIFTOFF_BG = '#17151a';

/** Deploy build number — keep in step with the ?v= query in index.html. */
const BUILD = 12;

/** Touch devices get "Tap" wording. */
const TAP = matchMedia('(pointer: coarse)').matches;
const GATE_TIP = (TAP ? 'Tap' : 'Click') + " Finish to share once you're done!";

/* ================================================================
 * 2. Small utilities
 * ================================================================ */

/** Shorthand for document.getElementById. */
function $(id) { return document.getElementById(id); }

/** Midnight-local Date for "today". */
function todayDate() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

/** YYYY-MM-DD key for a Date (local time). */
function dkey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
         '-' + String(d.getDate()).padStart(2, '0');
}

function todayKey() { return dkey(todayDate()); }

/** Days since the epoch; 0 on launch day. */
function dayIndex() {
  return Math.round((todayDate() - new Date(...EPOCH)) / 86400000);
}

/** "10 August" for the current local date. */
function dateStr() {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const d = new Date();
  return d.getDate() + ' ' + months[d.getMonth()];
}

/** localStorage helpers — best-effort: storage failures never break play. */
function store(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
}
function unstore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch (e) { return fallback; }
}

/* ================================================================
 * 3. Core game logic
 * ================================================================ */

/** Is `clue` an ordered (not necessarily contiguous) subsequence of `w`? */
function isValid(w, clue) {
  let i = 0;
  for (const ch of w) if (ch === clue[i] && ++i === clue.length) return true;
  return false;
}

/**
 * Score a valid word: length + burial tier + snug bonus (VP added separately).
 * Returns { p: points, s: 1 if snug }.
 */
function scoreWord(w, clue) {
  const tier = (w[0] !== clue[0] ? 1 : 0) +
               (w[w.length - 1] !== clue[clue.length - 1] ? 1 : 0);
  const snug = w.includes(clue);
  return {
    p: LENGTH_POINTS * (w.length - 3) + TIER_BONUS[tier] + (snug ? SNUG_BONUS : 0),
    s: snug ? 1 : 0,
  };
}

/** Mean Scrabble value per letter (for VP calculation) */
function density(w) {
  let s = 0;
  for (const ch of w) s += SCRABBLE[ch];
  return s / w.length;
}

/**
 * Full answer list for a clue: { answers: {word: {p, s, vp?}}, vp: word }.
 * The VP is the answer with the greatest Scrabble score density (ties: shorter, then
 * alphabetical).
 */
function computeAnswers(clue) {
  const ans = {};
  let best = null;                       // [negDensity, length, word, word]
  for (const w of DICT) {
    if (!isValid(w, clue)) continue;
    ans[w] = scoreWord(w, clue);
    const key = [-density(w), w.length, w];
    if (!best || key[0] < best[0] ||
        (key[0] === best[0] && (key[1] < best[1] ||
        (key[1] === best[1] && key[2] < best[2])))) {
      best = key.concat([w]);
    }
  }
  if (best) ans[best[3]].vp = 1;
  return { answers: ans, vp: best ? best[3] : null };
}

/** Today's scheduled clue (wraps if we ever outlive the schedule). */
function dailyClue() {
  const n = SCHED.length;
  return SCHED[((dayIndex() % n) + n) % n];
}

/** Yesterday's clue/date/number, or null on day one. */
function yesterdayInfo() {
  const yIdx = dayIndex() - 1;
  if (yIdx < 0) return null;
  const n = SCHED.length;
  const d = todayDate();
  d.setDate(d.getDate() - 1);
  return { clue: SCHED[((yIdx % n) + n) % n], key: dkey(d), no: yIdx + 1 };
}

/* ================================================================
 * 4. Game state
 * ================================================================ */

let CLUE;                 // current clue, lowercase ("img")
let UP;                   // display form ("I-M-G")
let answers;              // word -> {p, s, vp?} for the current plate
let vpWord;               // the Vanity Plate word
let perfect;              // sum of all answer points + VP bonus
let ranks;                // RANKS resolved to point thresholds for this plate
let total = 0;            // player's score
let found = [];           // words found, in find order
let hinted = new Set();   // words revealed as hint masks
let hintsUsed = 0;
let finished = false;     // player pressed Finish (locks the day)
let isDaily = false;      // current plate is today's scheduled plate
let listOpen = false;     // dev wordlist visibility
let diff = 'easy';        // dev roll difficulty band
let tripPts = null;       // rail geometry, rebuilt on resize

/** Pending dictionary edits (dev): word -> 'add' | 'remove'. */
const decisions = new Map();

/* ================================================================
 * 5. Persistence
 * ================================================================ */

const DAY_KEY = 'plates-day';
const STATS_KEY = 'plates-stats';
const DECISIONS_KEY = 'plates-decisions';

/** Lifetime record: date -> {r: rank, s: score, w: words, h: hints, f: found[]}. */
let statsDays = unstore(STATS_KEY, {});

/* Today's saved progress is read ONCE before the first render can overwrite
 * it (the render/persist cycle writes plates-day continuously). */
const bootDay = unstore(DAY_KEY, null);
let bootUsed = false;

/** Persist today's progress; record stats only once the day is finished. */
function saveDay() {
  if (!isDaily) return;
  store(DAY_KEY, { date: todayKey(), clue: CLUE, found,
                   hinted: [...hinted], hintsUsed, finished });
  if (finished) {
    statsDays[todayKey()] = { r: rank(), s: total, w: found.length,
                              h: hintsUsed, f: found.slice() };
    store(STATS_KEY, statsDays);
  }
}

/** Rebuild found words, hint masks, and finished state from a day snapshot. */
function restoreDay(snap) {
  if (!snap || snap.date !== todayKey() || snap.clue !== CLUE) return;
  for (const w of snap.found) {
    const a = answers[w];
    const pts = a ? a.p + (a.vp ? VP_BONUS : 0) : scoreWord(w, CLUE).p;
    found.push(w);
    total += pts;
    addFoundRow(w, pts, a || { s: scoreWord(w, CLUE).s }, a ? '' : ' rescued');
  }
  hintsUsed = snap.hintsUsed || 0;
  if (snap.finished) { finished = true; applyFinished(); }
  for (const w of snap.hinted || []) {
    hinted.add(w);
    if (!found.includes(w)) insertRow(w, makeHintRow(w));
  }
  render();
}

function persistDecisions() {
  store(DECISIONS_KEY, [...decisions]);
}

/* ================================================================
 * 6. Wordlist rendering
 * ================================================================ */

/** Insert a row into the alphabetical column, keeping sort order. */
function insertRow(w, node) {
  const col = $('column');
  let placed = false;
  for (const child of col.children) {
    if (child.dataset.w > w) { col.insertBefore(node, child); placed = true; break; }
  }
  if (!placed) col.appendChild(node);
  updateColumns();
}

/** One column normally; two when the list would overflow the viewport AND
 *  there's enough width for two readable columns. */
function updateColumns() {
  const col = $('column');
  $('empty').style.display = col.childElementCount ? 'none' : 'block';
  col.classList.remove('two');
  const avail = window.innerHeight - col.getBoundingClientRect().top - 70;
  if (col.scrollHeight > avail && col.clientWidth >= 430) col.classList.add('two');
}

function makeRow(w, pts, cls, tags) {
  const row = document.createElement('div');
  row.className = 'row' + cls;
  row.dataset.w = w;
  row.innerHTML = w.toUpperCase() + (tags || '') + ' <b>+' + pts + '</b>';
  return row;
}

/** Hint mask: first letter plus the plate letters where they sit. */
function makeHintRow(w) {
  const emb = new Set();
  let j = 0;
  for (let i = 0; i < w.length && j < CLUE.length; i++) {
    if (w[i] === CLUE[j]) { emb.add(i); j++; }
  }
  const row = document.createElement('div');
  row.className = 'row hinted';
  row.dataset.w = w;
  row.textContent = [...w]
    .map((ch, i) => (i === 0 || emb.has(i)) ? ch.toUpperCase() : '_')
    .join(' ');
  return row;
}

/** Add a found word (replacing its hint mask if present). Rescued words are
 *  dev-mode dictionary additions; clicking one un-rescues it. */
function addFoundRow(w, pts, a, rescuedCls) {
  const old = document.querySelector('#column .row.hinted[data-w="' + w + '"]');
  if (old) old.remove();
  let tags = '';
  if (a && a.vp) tags += ' <span class="tag vp">VP</span>';
  if (a && a.s) tags += ' <span class="tag snug">SNUG</span>';
  const cls = rescuedCls || (a && a.vp ? ' vp' : '');
  const row = makeRow(w, pts, cls, tags);
  if (rescuedCls) {
    row.onclick = () => {
      if (!isDev()) return;
      decisions.delete(w);
      persistDecisions();
      total -= pts;
      found.splice(found.indexOf(w), 1);
      row.remove();
      updateColumns();
      say(w.toUpperCase() + ' un-rescued', 'err');
      render();
    };
  }
  insertRow(w, row);
}

/* ================================================================
 * 7. The plate
 * ================================================================ */

/** Current rank name for the player's total. */
function rank() {
  let r = RANKS[0][0];
  for (const [name, pts] of ranks) if (total >= pts) r = name;
  return r;
}

/** Roll the odometer reels to the (zero-padded, clamped) score. */
function setOdo(n) {
  const s = String(Math.max(0, Math.min(9999, n))).padStart(4, '0');
  document.querySelectorAll('.odo').forEach(o => {
    o.querySelectorAll('.reel').forEach((r, i) => {
      r.style.transform = 'translateY(-' + (+s[i]) + 'em)';
    });
  });
}

/** "PLATES #2 • 10 August" — the plate's top field. */
function plateTopText() {
  return 'PLATES #' + (dayIndex() + 1) + ' • ' + dateStr();
}

/** localStorage key for the mobile floating-plate preference. */
const FLOAT_KEY = 'plates-showplate';

/**
 * Build the floating copy of the score plate (mobile). Cloning the hero
 * plate's odometer keeps the two reels structurally identical; setOdo drives
 * every .odo on the page, so both always agree.
 */
function buildFloatPlate() {
  const p = document.createElement('div');
  p.className = 'plate';
  p.innerHTML = '<div class="ptop" id="fptop"></div>' +
                '<div class="pline"><span id="fclue"></span><span>-</span></div>';
  p.querySelector('.pline').appendChild(
    document.querySelector('.plate .odo').cloneNode(true));
  $('floatplate').appendChild(p);
}

/** Show or hide the floating plate, sync the button label, remember. */
function setFloatPlate(show) {
  $('floatplate').hidden = !show;
  $('floattoggle').textContent = (show ? 'Hide' : 'Show') + ' score plate';
  store(FLOAT_KEY, show);
  layoutMobileChrome();
}

/**
 * Position the mobile floating chrome: the plate rides just above the fixed
 * input bar, and the message pill rides above whichever of the two is taller.
 * The CSS variables are only consumed inside the <=980px regime.
 */
function layoutMobileChrome() {
  const fh = $('form').offsetHeight;
  document.documentElement.style.setProperty('--floatbot', (fh + 26) + 'px');
  const extra = $('floatplate').hidden ? 0 : $('floatplate').offsetHeight + 14;
  document.documentElement.style.setProperty('--msgbot', (fh + 24 + extra) + 'px');
}

/* ================================================================
 * 8. The road-trip rank rail
 * ================================================================ */

/** Wide screens put the rail beside the plate, vertically. */
function isVerticalTrip() { return matchMedia('(min-width: 1401px)').matches; }

/** (Re)build the zigzag route SVG and position the stop labels. */
function buildTrip() {
  const trip = document.querySelector('.trip');
  const W = trip.clientWidth, H = trip.clientHeight, n = ranks.length;
  tripPts = [];
  const vert = isVerticalTrip();
  if (vert) {
    const y0 = H - 16, y1 = 16, xA = 14, xB = 46;
    for (let i = 0; i < n; i++) {
      tripPts.push([i % 2 ? xB : xA, y0 + (y1 - y0) * i / (n - 1)]);
    }
  } else {
    const x0 = 22, x1 = W - 22, yA = 18, yB = 40;
    for (let i = 0; i < n; i++) {
      tripPts.push([x0 + (x1 - x0) * i / (n - 1), i % 2 ? yA : yB]);
    }
  }
  const svg = $('tripsvg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.innerHTML =
    '<polyline points="' + tripPts.map(p => p.join(',')).join(' ') + '" fill="none"' +
    ' stroke="var(--bar)" stroke-width="3" stroke-dasharray="0.5 8"' +
    ' stroke-linecap="round" stroke-linejoin="round"/>' +
    '<polyline id="tripprog" points="" fill="none" stroke="var(--accent)"' +
    ' stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    tripPts.map(p =>
      '<circle class="tripdot" cx="' + p[0] + '" cy="' + p[1] + '" r="5.5"' +
      ' fill="var(--card)" stroke="var(--bar)" stroke-width="2.5"/>').join('');
  const stops = $('stops');
  stops.innerHTML = '';
  ranks.forEach(([name], i) => {
    const s = document.createElement('span');
    s.className = 'sname';
    s.textContent = name;
    const [x, y] = tripPts[i];
    if (vert) {
      s.style.left = (x + 16) + 'px';
      s.style.top = y + 'px';
      s.style.transform = 'translateY(-50%)';
    } else {
      // Horizontal rails keep labels on a fixed baseline (no zigzag riding).
      s.style.left = x + 'px';
      s.style.top = '58px';
      s.style.transform = 'translateX(-50%)';
    }
    stops.appendChild(s);
  });
}

/** Paint progress along the route: solid road behind, dotted ahead. */
function renderTrip() {
  if (!tripPts) return;
  // Progress in "stop space": integer part = last rank reached, fraction =
  // interpolation toward the next threshold.
  let seg = 0;
  for (let i = 0; i < ranks.length; i++) if (total >= ranks[i][1]) seg = i;
  let frac = seg;
  if (seg < ranks.length - 1) {
    const lo = ranks[seg][1], hi = ranks[seg + 1][1];
    frac = seg + Math.min(1, (total - lo) / Math.max(1, hi - lo));
  }
  const i = Math.min(Math.floor(frac), tripPts.length - 1), t = frac - i;
  const cut = tripPts.slice(0, i + 1).map(p => p.slice());
  if (i < tripPts.length - 1 && t > 0) {
    const [ax, ay] = tripPts[i], [bx, by] = tripPts[i + 1];
    cut.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
  }
  $('tripprog').setAttribute('points', cut.map(p => p.join(',')).join(' '));
  const cur = rank();
  document.querySelectorAll('.tripdot').forEach((d, idx) => {
    const reached = total >= ranks[idx][1];
    d.setAttribute('fill', reached ? 'var(--accent)' : 'var(--card)');
    d.setAttribute('stroke', reached ? 'var(--accent)' : 'var(--bar)');
    d.setAttribute('r', ranks[idx][0] === cur ? 7 : 5.5);
  });
  document.querySelectorAll('.sname').forEach((s, idx) => {
    s.classList.toggle('reached', total >= ranks[idx][1]);
    s.classList.toggle('current', ranks[idx][0] === cur);
  });
  // Horizontal rails: nudge any label back inside the card. An end label
  // centered on its dot (especially when enlarged as current) would otherwise
  // poke past the card edge. Runs after the class toggles above, since
  // becoming current changes a label's width.
  if (!isVerticalTrip()) {
    const tr = document.querySelector('.trip').getBoundingClientRect();
    document.querySelectorAll('.sname').forEach(s => {
      s.style.marginLeft = '0px';
      const r = s.getBoundingClientRect();
      if (r.left < tr.left) s.style.marginLeft = (tr.left - r.left) + 'px';
      else if (r.right > tr.right) s.style.marginLeft = (tr.right - r.right) + 'px';
    });
  }
}

/* ================================================================
 * 9. Stats
 * ================================================================ */

/** Repaint the stats modal from the lifetime record (finished days only). */
function renderStats() {
  const days = Object.entries(statsDays).filter(([, v]) => v.w > 0);
  const set = new Set(days.map(([k]) => k));

  // Current streak: walk back from today; an unfinished today doesn't break it.
  let streak = 0;
  for (let d = todayDate(); ; d.setDate(d.getDate() - 1)) {
    if (set.has(dkey(d))) streak++;
    else if (dkey(d) === todayKey()) continue;
    else break;
  }

  // Best streak: longest run of consecutive dates in the record.
  let best = 0, run = 0, prev = null;
  for (const k of [...set].sort()) {
    const cur = new Date(k + 'T12:00');
    run = (prev && (cur - prev) < 1.5 * 86400000) ? run + 1 : 1;
    best = Math.max(best, run);
    prev = cur;
  }

  $('statplayed').textContent = days.length;
  $('statstreak').textContent = streak;
  $('statbest').textContent = best;

  // Rank distribution, top rank first; today highlighted once finished.
  const counts = {};
  for (const [name] of RANKS) counts[name] = 0;
  for (const [, v] of days) if (counts[v.r] !== undefined) counts[v.r]++;
  const max = Math.max(1, ...Object.values(counts));
  const todayRank = (isDaily && finished) ? rank() : null;
  const box = $('dist');
  box.innerHTML = '';
  for (let i = RANKS.length - 1; i >= 0; i--) {
    const name = RANKS[i][0];
    const row = document.createElement('div');
    row.className = 'distrow' + (name === todayRank ? ' today' : '');
    row.innerHTML = '<span class="dname">' + name + '</span>' +
      '<span class="dbar"><i style="width:' + (100 * counts[name] / max) + '%"></i></span>' +
      '<b>' + counts[name] + '</b>';
    box.appendChild(row);
  }
}

/* ================================================================
 * 10. Messages & label flashes
 * ================================================================ */

let sayTimer = null;

/** Show feedback near the input; auto-expires (longer if it carries a button). */
function say(text, cls, extra) {
  const m = $('msg');
  m.textContent = text;
  m.className = 'msg ' + (cls || '');
  if (extra) m.appendChild(extra);
  clearTimeout(sayTimer);
  if (text) {
    sayTimer = setTimeout(() => { m.textContent = ''; m.className = 'msg'; },
                          extra ? 6000 : 3000);
  }
}

/** Swap a button's label briefly ("Copied") without changing its width —
 *  buttons reserve room in CSS via min-width. */
function flashLabel(el, text) {
  if (el.dataset.flashing) return;
  el.dataset.flashing = '1';
  const t = el.textContent;
  el.textContent = text;
  setTimeout(() => { el.textContent = t; delete el.dataset.flashing; }, 1200);
}

/* ================================================================
 * 11. Play actions
 * ================================================================ */

/** Set up a plate (today's or a dev roll) and reset per-plate state. */
function setPlate(clue) {
  CLUE = clue;
  isDaily = (clue === dailyClue());
  UP = clue.toUpperCase().split('').join('-');

  const ca = computeAnswers(clue);
  answers = ca.answers;
  vpWord = ca.vp;
  perfect = VP_BONUS;
  for (const w in answers) perfect += answers[w].p;
  ranks = RANKS.map(([n, f]) => [n, Math.round(perfect * f / 5) * 5]);

  total = 0; found = []; hinted = new Set();
  listOpen = false; hintsUsed = 0; finished = false;

  document.body.classList.remove('fin');
  $('inp').disabled = false;
  $('hintbtn').disabled = false;
  $('finishbtn').style.display = '';
  const sb = $('sharebtn');
  sb.classList.add('gated');
  sb.title = GATE_TIP;
  syncCover();

  $('clue').textContent = CLUE.toUpperCase();
  $('ptop').textContent = plateTopText();
  $('fclue').textContent = CLUE.toUpperCase();
  $('fptop').textContent = plateTopText();
  $('column').innerHTML = '';
  $('column').classList.remove('two');
  $('empty').style.display = 'block';
  $('reveal').innerHTML = '';
  $('revealcard').classList.remove('open');
  $('listbtn').textContent = 'Show wordlist';
  $('upcoming').value = '';

  buildTrip();
  say('', '');
  render();
}

/** Enter today's plate, restoring saved progress (boot cache first, then live
 *  storage — the initial render would otherwise clobber the snapshot). */
function goDaily() {
  const snap = bootUsed ? unstore(DAY_KEY, null) : bootDay;
  bootUsed = true;
  setPlate(dailyClue());
  restoreDay(snap);
  $('inp').focus();
}

/** Handle a word submission. */
function submitWord() {
  if (finished) return;
  const inp = $('inp');
  const w = inp.value.trim().toLowerCase();
  inp.value = '';
  if (!w) return;
  const W = w.toUpperCase();
  if (w.length < 4) return say('too short', 'err');
  if (!isValid(w, CLUE)) return say(W + " doesn't contain " + UP, 'err');
  if (found.includes(w)) return say('already found', 'err');

  const a = answers[w];
  if (!a) {
    // Not on the answer list: dev mode may rescue it into the dictionary.
    if (decisions.get(w) === 'add') return rescue(w);
    if (!isDev()) return say(W + ' is not in the word list', 'err');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '+ rescue ' + W;
    btn.onclick = () => rescue(w);
    return say(W + ' is not in the word list', 'err', btn);
  }

  found.push(w);
  const pts = a.p + (a.vp ? VP_BONUS : 0);
  const before = total;
  total += pts;
  if (a.vp) say('VANITY PLATE — ' + W + '  +' + pts, 'gold');
  else say(W + '  +' + pts, 'ok');
  addFoundRow(w, pts, a, '');
  syncReveal();
  render();
  // Crossing into the top rank mid-play earns the Liftoff celebration.
  const top = ranks[ranks.length - 1][1];
  if (before < top && total >= top) openLiftoff();
}

/** Reveal the shortest unfound word as a mask (cheapest remaining answer). */
function hint() {
  if (finished) return;
  const pool = Object.keys(answers).filter(w =>
    !found.includes(w) && !hinted.has(w) && decisions.get(w) !== 'remove');
  if (!pool.length) return say('nothing left to hint', 'err');
  pool.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const w = pool[0];
  hinted.add(w);
  hintsUsed++;
  insertRow(w, makeHintRow(w));
  say('', '');
  render();
}

/** Dev: accept an off-list word into the pending dictionary additions. */
function rescue(w) {
  const sc = scoreWord(w, CLUE);
  decisions.set(w, 'add');
  persistDecisions();
  found.push(w);
  total += sc.p;
  addFoundRow(w, sc.p, { s: sc.s }, ' rescued' + (sc.s ? ' snug' : ''));
  say(w.toUpperCase() + ' rescued  +' + sc.p, 'ok');
  render();
}

/* ================================================================
 * 12. Finish & sharing
 * ================================================================ */

/** Three-line text share card. */
function shareText() {
  return 'Plates #' + (dayIndex() + 1) + ': ' + dateStr() + '\n' +
         '[' + CLUE.toUpperCase() + ' - ' + total + '] ' + rank() + '\n' +
         'Hints used: ' + hintsUsed;
}

/** The plate's hover cover doubles as the share gate / copy affordance. */
function syncCover() {
  $('platecover').textContent =
    finished ? (TAP ? 'Tap to copy' : 'Click to copy') : GATE_TIP;
}

/** Lock the page into the finished ("trophy") state. */
function applyFinished() {
  $('inp').disabled = true;
  $('hintbtn').disabled = true;
  $('finishbtn').style.display = 'none';
  const sb = $('sharebtn');
  sb.classList.remove('gated');
  sb.title = '';
  document.body.classList.add('fin');
  $('pbot').textContent =
    (rank() + ' • hints used: ' + hintsUsed).toUpperCase();
  syncCover();
}

function finishGame(withConfetti) {
  finished = true;
  applyFinished();
  saveDay();
  if (withConfetti) confetti();
  openFinish();
}

/** Gold palette for the Liftoff burst. */
const GOLD_CONFETTI = ['#a8781a', '#c9971f', '#e0b32c', '#f0c94a',
                       '#f7e08a', '#fff3c4'];

/** Brief burst of confetti over everything (default: logo blues). */
function confetti(palette, count) {
  const cv = document.createElement('canvas');
  cv.style.cssText = 'position:fixed;inset:0;z-index:40;pointer-events:none;';
  cv.width = innerWidth;
  cv.height = innerHeight;
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  const cols = palette || ['#1a57c2', '#3f7ae0', '#6f9ae8', '#a5c2f5',
                           '#dce9ff', '#fffaf0'];
  const parts = Array.from({ length: count || 150 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.55,
    y: innerHeight * 0.32 + (Math.random() - 0.5) * 60,
    vx: (Math.random() - 0.5) * 9,
    vy: -(4 + Math.random() * 8),
    w: 5 + Math.random() * 7,
    h: 4 + Math.random() * 4,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: cols[Math.floor(Math.random() * cols.length)],
  }));
  const t0 = performance.now();
  (function tick(t) {
    const el = (t - t0) / 1000;
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.vy += 0.18; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.globalAlpha = Math.max(0, 1 - el / 2);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (el < 2.1) requestAnimationFrame(tick); else cv.remove();
  })(t0);
}

/**
 * Draw the share image: the page plate's twin (same top field, rank color,
 * stretched registration) plus the rank/hints bottom field.
 */
async function drawPlate() {
  try { await document.fonts.load('150px "License Plate"'); } catch (e) { /* draw anyway */ }
  const cv = $('plateimg');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const color = RANK_COLORS[Math.max(0, ranks.findIndex(([n]) => n === rank()))];
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = rank() === 'Liftoff' ? LIFTOFF_BG : '#fffaf0';
  ctx.beginPath(); ctx.roundRect(10, 10, W - 20, H - 20, 44); ctx.fill();
  ctx.lineWidth = 14;
  ctx.strokeStyle = color;
  ctx.beginPath(); ctx.roundRect(10, 10, W - 20, H - 20, 44); ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 30px "Atkinson Hyperlegible Next", "Avenir Next", "Segoe UI", sans-serif';
  try { ctx.letterSpacing = '5px'; } catch (e) { /* older engines */ }
  ctx.fillText(plateTopText(), W / 2, 62);
  ctx.save();
  ctx.translate(W / 2, H * 0.56);
  ctx.scale(1, 1.2);                     // same die-stretch as the page plate
  ctx.font = '176px "License Plate", "Avenir Next", sans-serif';
  try { ctx.letterSpacing = '18px'; } catch (e) { /* older engines */ }
  ctx.fillText(CLUE.toUpperCase() + '-' +
               String(Math.min(9999, total)).padStart(4, '0'), 0, 0);
  ctx.restore();
  ctx.font = '600 30px "Atkinson Hyperlegible Next", "Avenir Next", "Segoe UI", sans-serif';
  try { ctx.letterSpacing = '5px'; } catch (e) { /* older engines */ }
  ctx.fillText((rank() + ' • hints used: ' + hintsUsed).toUpperCase(),
               W / 2, H - 62);
  try { ctx.letterSpacing = '0px'; } catch (e) { /* older engines */ }
}

/** Copy a canvas as PNG to the clipboard, downloading as fallback. */
function copyCanvas(cb) {
  $('plateimg').toBlob(async blob => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      cb('Copied');
    } catch (e) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'plates-' + todayKey() + '.png';
      a.click();
      URL.revokeObjectURL(a.href);
      cb('Downloaded');
    }
  }, 'image/png');
}

/** Page plate click: gate reminder before finish, image copy after. */
async function plateClick() {
  const c = $('platecover');
  if (!finished) {
    c.classList.add('show');                     // touch devices have no hover
    setTimeout(() => c.classList.remove('show'), 1200);
    return;
  }
  await drawPlate();
  copyCanvas(result => {
    c.textContent = result;
    c.classList.add('show');
    setTimeout(() => { c.classList.remove('show'); syncCover(); }, 1200);
  });
}

/** Modal plate click: copy with an overlay flash on the plate itself. */
function copyPlate() {
  copyCanvas(result => {
    const f = $('plateflash');
    f.textContent = result;
    f.classList.add('show');
    setTimeout(() => f.classList.remove('show'), 1200);
  });
}

function copyText(ev) {
  navigator.clipboard.writeText(shareText())
    .then(() => flashLabel(ev.target, 'Copied'));
}

function shareClick() {
  const btn = $('sharebtn');
  if (!finished) return say(GATE_TIP, 'err');
  navigator.clipboard.writeText(shareText())
    .then(() => flashLabel(btn, 'Copied'));
}

/* ================================================================
 * 13. Modals
 * ================================================================ */

function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

async function openFinish() {
  $('finishscore').innerHTML = '<b>' + total + '</b> points &mdash; ' + rank();
  $('copynote').textContent = (TAP ? 'tap' : 'click') + ' the plate to copy it';
  await drawPlate();
  openModal('finishmodal');
}
function closeFinish() { closeModal('finishmodal'); }

/** The Liftoff celebration: gold confetti and a finish-or-continue choice. */
function openLiftoff() {
  openModal('liftoffmodal');
  confetti(GOLD_CONFETTI, 320);
}

/** Yesterday's full answer list: found words bolded, VP in gold. */
function openYesterday() {
  const info = yesterdayInfo();
  const sub = $('ysub');
  const box = $('ylist');
  box.innerHTML = '';
  if (!info) {
    sub.textContent = 'This is the very first Plates — no yesterday yet.';
  } else {
    const { answers: ya, vp } = computeAnswers(info.clue);
    const got = new Set((statsDays[info.key] && statsDays[info.key].f) || []);
    sub.textContent = 'Plates #' + info.no + ' • ' +
      info.clue.toUpperCase().split('').join('-') + ' • you found ' +
      [...got].filter(w => ya[w]).length + ' of ' + Object.keys(ya).length;
    for (const w of Object.keys(ya).sort()) {
      const row = document.createElement('div');
      row.className = 'yword' + (got.has(w) ? ' got' : '') + (w === vp ? ' vp' : '');
      row.innerHTML = w.toUpperCase() +
        (w === vp ? ' <span class="tag vp">VP</span>' : '') +
        ' <b>+' + (ya[w].p + (w === vp ? VP_BONUS : 0)) + '</b>';
      box.appendChild(row);
    }
  }
  openModal('yestmodal');
}

/* ================================================================
 * 14. Dev tools
 * ================================================================ */

function isDev() { return document.body.classList.contains('dev'); }

/**
 * Dev mode is gated by a password so players don't stumble into spoilers.
 * Only this SHA-256 hash of the password appears in source; a successful
 * unlock is remembered per browser (storing the hash, so changing the
 * password below revokes old unlocks).
 *
 * This is spoiler protection, not security: the site is fully client-side,
 * so a determined reader can see the answers in data.js regardless.
 *
 * To change the password, run this in the browser console and paste the
 * result here:
 *   await (async s => [...new Uint8Array(await crypto.subtle.digest(
 *     'SHA-256', new TextEncoder().encode(s)))].map(
 *     x => x.toString(16).padStart(2, '0')).join(''))('new password')
 */
const DEV_HASH = '6eaf141afb05baff85d459d00518f8503a680def287d9ccd25f24010210e4b2d';
const DEV_UNLOCK_KEY = 'plates-dev-ok';

function devUnlocked() { return unstore(DEV_UNLOCK_KEY, '') === DEV_HASH; }

/** SHA-256 hex digest of a string. */
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Difficulty band for dev rolls (gimme counts from ELIG). */
function inBand(g) {
  return diff === 'easy' ? g >= 6 :
         diff === 'medium' ? (g >= 3 && g <= 5) : g <= 2;
}

function setDiff(d) {
  diff = d;
  document.querySelectorAll('#seg button').forEach(b =>
    b.classList.toggle('active', b.dataset.d === d));
  roll();
}

/** Roll a random eligible clue in the current band (never persists/stats). */
function roll() {
  const pool = ELIG.filter(([c, g]) => inBand(g) && c !== CLUE);
  setPlate(pool[Math.floor(Math.random() * pool.length)][0]);
  $('inp').focus();
}

/** Dev wordlist (its own card below the play card), click-to-mark-removal. */
function toggleList() {
  const box = $('reveal');
  listOpen = !listOpen;
  $('listbtn').textContent = listOpen ? 'Hide wordlist' : 'Show wordlist';
  $('revealcard').classList.toggle('open', listOpen);
  if (!listOpen) return;
  if (!box.childElementCount) {
    for (const w of Object.keys(answers).sort()) {
      const a = answers[w];
      const row = document.createElement('div');
      row.dataset.w = w;
      let tags = '';
      if (a.vp) tags += ' <span class="tag vp">VP</span>';
      if (a.s) tags += ' <span class="tag snug">SNUG</span>';
      row.innerHTML = w.toUpperCase() + tags +
        ' <b>' + (a.p + (a.vp ? VP_BONUS : 0)) + '</b>';
      row.onclick = () => {
        if (decisions.get(w) === 'remove') decisions.delete(w);
        else decisions.set(w, 'remove');
        persistDecisions();
        syncReveal();
        render();
      };
      box.appendChild(row);
    }
  }
  syncReveal();
}

function syncReveal() {
  document.querySelectorAll('#reveal div[data-w]').forEach(row => {
    const w = row.dataset.w;
    row.className = 'rword' + (found.includes(w) ? '' : ' missed') +
                    (decisions.get(w) === 'remove' ? ' removed' : '');
  });
}

/* ---- dictionary commits ----
 *
 * Pending decisions (rescues and removals) are committed straight to the
 * repo via the GitHub contents API: DICT inside data.js is edited in place
 * (ELIG and SCHED stay frozen, so no past or future plate changes), and
 * dictionary.txt is regenerated to match. The site deploy workflow then
 * ships the new dictionary automatically.
 *
 * Needs a fine-grained personal access token (contents read/write on
 * mschachner/plates), asked for once and kept in this browser only.
 */

const GH_TOKEN_KEY = 'plates-gh-token';
const GH_API = 'https://api.github.com/repos/mschachner/plates/contents/';

function ghHeaders() {
  return { Authorization: 'Bearer ' + unstore(GH_TOKEN_KEY, ''),
           Accept: 'application/vnd.github+json' };
}

/** UTF-8-safe base64 codecs for the contents API. */
function b64encode(s) { return btoa(unescape(encodeURIComponent(s))); }
function b64decode(s) { return decodeURIComponent(escape(atob(s.replace(/\n/g, '')))); }

async function ghGet(file) {
  const r = await fetch(GH_API + file, { headers: ghHeaders() });
  if (!r.ok) throw new Error(file + ': HTTP ' + r.status);
  return r.json();
}

async function ghPut(file, text, sha, message) {
  const r = await fetch(GH_API + file, {
    method: 'PUT',
    headers: ghHeaders(),
    body: JSON.stringify({ message, content: b64encode(text), sha }),
  });
  if (!r.ok) throw new Error(file + ': HTTP ' + r.status);
}

async function commitDictionary() {
  if (!decisions.size) return say('no pending dictionary changes', 'err');
  if (!unstore(GH_TOKEN_KEY, '')) return openModal('ghmodal');
  const btn = $('commitbtn');
  btn.disabled = true;
  say('committing\u2026', 'ok');
  try {
    const data = await ghGet('data.js');
    const text = b64decode(data.content);
    const m = text.match(/const DICT = "([^"]*)"/);
    if (!m) throw new Error('DICT not found in data.js');
    const words = new Set(m[1].split(' '));
    let added = 0, removed = 0;
    for (const [w, c] of decisions) {
      if (c === 'add' && !words.has(w)) { words.add(w); added++; }
      else if (c === 'remove' && words.delete(w)) removed++;
    }
    const list = [...words].sort();
    const msg = 'Dictionary: +' + added + ' \u2212' + removed +
                ' (in-game curation)';
    await ghPut('data.js',
                text.replace(m[0], 'const DICT = "' + list.join(' ') + '"'),
                data.sha, msg);
    const dict = await ghGet('dictionary.txt');
    await ghPut('dictionary.txt', list.join('\n') + '\n', dict.sha, msg);
    decisions.clear();
    persistDecisions();
    syncReveal();
    render();
    say('committed +' + added + ' \u2212' + removed +
        ' \u2014 live after the next deploy', 'ok');
  } catch (e) {
    // A 401 means the stored token is bad or expired: forget it and re-ask.
    if (String(e.message).includes('401')) {
      store(GH_TOKEN_KEY, '');
      openModal('ghmodal');
    }
    say('commit failed \u2014 ' + e.message, 'err');
  }
  btn.disabled = false;
}

/** Dev: set the score one short word from Liftoff, to test the celebration. */
function nearLiftoff() {
  if (finished) return say('reset finish first', 'err');
  total = Math.max(0, ranks[ranks.length - 1][1] - LENGTH_POINTS);
  render();
  say('one word from Liftoff', 'ok');
}

/** Dev: unlock a finished day (also un-records it from stats). */
function resetFinish(ev) {
  finished = false;
  document.body.classList.remove('fin');
  delete statsDays[todayKey()];
  store(STATS_KEY, statsDays);
  $('inp').disabled = false;
  $('hintbtn').disabled = false;
  $('finishbtn').style.display = '';
  const sb = $('sharebtn');
  sb.classList.add('gated');
  sb.title = GATE_TIP;
  syncCover();
  saveDay();
  flashLabel(ev.target, 'Done');
}

/** Dev: wipe today back to a blank slate. */
function resetToday(ev) {
  delete statsDays[todayKey()];
  store(STATS_KEY, statsDays);
  setPlate(dailyClue());
  saveDay();
  flashLabel(ev.target, 'Done');
}

/* ================================================================
 * 15. Rendering root, event wiring & boot
 * ================================================================ */

/** Repaint everything score-dependent and persist. Called after any change. */
function render() {
  setOdo(total);
  renderTrip();
  const nRem = [...decisions.values()].filter(v => v === 'remove').length;
  const parts = [];
  if (found.length) {
    parts.push(found.length + ' of ' + Object.keys(answers).length + ' words');
  }
  if (decisions.size) {
    parts.push((decisions.size - nRem) + ' rescued · ' +
               nRem + ' marked for removal');
  }
  $('count').textContent = parts.join(' · ');
  $('commitbtn').textContent = decisions.size
    ? 'Commit changes (' + decisions.size + ')' : 'Commit changes';
  document.documentElement.style.setProperty('--rankc',
    RANK_COLORS[Math.max(0, ranks.findIndex(([n]) => n === rank()))]);
  document.body.classList.toggle('liftoff', rank() === 'Liftoff');
  saveDay();
  renderStats();
}

function wireEvents() {
  // Play
  $('form').addEventListener('submit', e => { e.preventDefault(); submitWord(); });
  $('inp').addEventListener('input', () => {
    const inp = $('inp');
    const clean = inp.value.replace(/[^a-zA-Z]/g, '');   // letters only
    if (clean !== inp.value) inp.value = clean;
  });
  $('hintbtn').addEventListener('click', hint);
  $('finishbtn').addEventListener('click', () => finishGame(true));
  // Liftoff modal: Finish skips the blue confetti (gold already fell).
  $('lofinish').addEventListener('click', () => {
    closeModal('liftoffmodal');
    finishGame(false);
  });
  $('lokeep').addEventListener('click', () => closeModal('liftoffmodal'));
  $('sharebtn').addEventListener('click', shareClick);
  $('copytextbtn').addEventListener('click', copyText);
  document.querySelector('.plate').addEventListener('click', plateClick);

  // Header
  $('rulesbtn').addEventListener('click', () => openModal('rulesmodal'));
  $('statsbtn').addEventListener('click', () => { renderStats(); openModal('statsmodal'); });
  $('yestbtn').addEventListener('click', openYesterday);
  // The dev switch shows only where it's relevant: on a browser that has
  // unlocked dev mode before, or when the page is visited with #dev.
  const syncDevVisibility = () => document.body.classList.toggle('devvis',
    devUnlocked() || location.hash === '#dev');
  window.addEventListener('hashchange', syncDevVisibility);
  syncDevVisibility();
  $('devtoggle').addEventListener('change', e => {
    if (e.target.checked && !devUnlocked()) {
      e.target.checked = false;
      $('devpass').value = '';
      $('devpassmsg').textContent = '';
      openModal('devmodal');
      $('devpass').focus();
      return;
    }
    document.body.classList.toggle('dev', e.target.checked);
  });
  $('devform').addEventListener('submit', async e => {
    e.preventDefault();
    if (await sha256hex($('devpass').value) !== DEV_HASH) {
      $('devpassmsg').textContent = 'Wrong password.';
      $('devpass').select();
      return;
    }
    store(DEV_UNLOCK_KEY, DEV_HASH);
    syncDevVisibility();
    closeModal('devmodal');
    $('devtoggle').checked = true;
    document.body.classList.add('dev');
  });
  // Floating score plate (mobile): built once, toggled by its button, with
  // the choice remembered across visits.
  buildFloatPlate();
  $('floattoggle').addEventListener('click', () => setFloatPlate($('floatplate').hidden));
  window.addEventListener('resize', layoutMobileChrome);
  setFloatPlate(unstore(FLOAT_KEY, false));
  $('buildtag').textContent = 'b' + BUILD;

  // Welcome
  $('welcomego').addEventListener('click', () => closeModal('welcomemodal'));
  $('welcomehow').addEventListener('click', () => {
    closeModal('welcomemodal');
    openModal('rulesmodal');
  });

  // Finish modal
  $('plateimg').addEventListener('click', copyPlate);

  // Dev tools
  $('rollbtn').addEventListener('click', roll);
  $('todaybtn').addEventListener('click', goDaily);
  $('listbtn').addEventListener('click', toggleList);
  $('commitbtn').addEventListener('click', commitDictionary);
  $('ghform').addEventListener('submit', e => {
    e.preventDefault();
    const t = $('ghtoken').value.trim();
    if (!t) return;
    store(GH_TOKEN_KEY, t);
    closeModal('ghmodal');
    commitDictionary();
  });
  // Upcoming plates: the next 14 scheduled days, playable ahead of time.
  const up = $('upcoming');
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (let k = 1; k <= 14; k++) {
    const idx = dayIndex() + k, n = SCHED.length;
    const d = todayDate();
    d.setDate(d.getDate() + k);
    const o = document.createElement('option');
    o.value = SCHED[((idx % n) + n) % n];
    o.textContent = '#' + (idx + 1) + ' \u2014 ' + d.getDate() + ' ' +
                    MO[d.getMonth()] + ' \u2014 ' + o.value.toUpperCase();
    up.appendChild(o);
  }
  up.addEventListener('change', () => {
    if (up.value) { setPlate(up.value); $('inp').focus(); }
  });
  $('resetfinbtn').addEventListener('click', resetFinish);
  $('resettodaybtn').addEventListener('click', resetToday);
  $('nearliftbtn').addEventListener('click', nearLiftoff);
  document.querySelectorAll('#seg button').forEach(b =>
    b.addEventListener('click', () => setDiff(b.dataset.d)));

  // Modals: any .close button or backdrop click closes; Escape closes all.
  document.querySelectorAll('.overlay').forEach(ov => {
    ov.addEventListener('click', e => {
      if (e.target === ov) ov.classList.remove('open');
    });
    const x = ov.querySelector('.close');
    if (x) x.addEventListener('click', () => ov.classList.remove('open'));
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.overlay.open').forEach(ov =>
        ov.classList.remove('open'));
    }
  });

  // Layout reactions
  window.addEventListener('resize', () => {
    updateColumns();
    if (tripPts) { buildTrip(); renderTrip(); }
  });
  new ResizeObserver(() => {
    if (tripPts) { buildTrip(); renderTrip(); }
  }).observe(document.querySelector('.trip'));
}

function boot() {
  // Restore pending dictionary decisions.
  for (const [w, c] of unstore(DECISIONS_KEY, [])) decisions.set(w, c);
  // The welcome modal reuses the header logo's embedded image.
  $('welcomelogo').src = document.querySelector('.logo').src;
  wireEvents();
  goDaily();
}

boot();
