/* Random puzzle generation for Fences+. A puzzle is built backwards: draw a
   random solution (an L-loop 2-factor, straight from the engine's randomized
   search), take every solution edge — plus, when dot clues are wanted, every
   cell's inside/outside dot — as a maximal clue set, then greedily delete
   clues in a shuffled order, keeping each deletion only while the puzzle
   stays decidable at the requested difficulty:
     easy    the two one-step rules below still finish the board
     medium  those rules plus a depth-1 what-if still finish it
     hard    the solution stays unique (exact search, so the player may need
             real search too)
     expert  hard, restarted from several shuffles; the fewest clues win
   A medium, hard, or expert result that happens to fall to the one-step
   rules alone (checkable only for single-loop, edge-only boards) is a dud:
   it is thrown away and generation restarts from a fresh solution, a couple
   of times at most. Deletions only shrink the clue set and shrinking never removes solutions,
   so a clue kept because its deletion broke the test stays unremovable in
   every later, smaller set: hard results are locally minimal, and easy /
   medium results are minimal with respect to their solver. A board decided
   by sound rules alone is automatically unique, so easy and medium never
   need the exact search. */
const FencesSolver = typeof module !== 'undefined' ? require('./fences-engine.js').Fences : globalThis.Fences;

function genGridEdges(R, C) {
  const HE = R * (C - 1), E = HE + (R - 1) * C;
  const EU = new Int32Array(E), EV = new Int32Array(E);
  let k = 0;
  for (let r = 0; r < R; r++) for (let c = 0; c < C - 1; c++) { EU[k] = r * C + c; EV[k] = r * C + c + 1; k++; }
  for (let r = 0; r < R - 1; r++) for (let c = 0; c < C; c++) { EU[k] = r * C + c; EV[k] = (r + 1) * C + c; k++; }
  return { HE, E, EU, EV };
}

/* The one-step solver: repeated application of exactly two rules a player
   uses without any search. Degree-2 rule: a dot that already has two fences
   excludes its other edges; a dot with only two usable edges left includes
   them. No-closed-loop rule: an edge joining the two ends of one open path
   would close a loop, so it is out while the path misses any dot, and in
   once the path covers them all. Both rules are sound, so if every edge gets
   decided the result is the clue set's unique solution; returns whether that
   happened. Single loop, edge clues only. */
function easySolves(R, C, clueEdges) {
  const N = R * C;
  const { E, EU, EV } = genGridEdges(R, C);
  const vAdj = Array.from({ length: N }, () => []);
  for (let e = 0; e < E; e++) { vAdj[EU[e]].push(e); vAdj[EV[e]].push(e); }
  const state = new Int8Array(E); // 0 unknown, 1 fence, 2 out
  const degIn = new Int8Array(N), degUnk = new Int8Array(N);
  const partner = new Int32Array(N), plen = new Int32Array(N);
  for (let v = 0; v < N; v++) { degUnk[v] = vAdj[v].length; partner[v] = v; plen[v] = 1; }
  let closed = false;
  const setIn = e => {
    if (state[e]) return state[e] === 1;
    const u = EU[e], v = EV[e];
    if (closed || degIn[u] >= 2 || degIn[v] >= 2) return false;
    if (partner[u] === v) { // the two ends of one open path
      if (plen[u] !== N) return false;
      closed = true;
    } else {
      const eu = partner[u], ev = partner[v], len = plen[eu] + plen[ev];
      partner[eu] = ev; partner[ev] = eu;
      plen[eu] = len; plen[ev] = len;
    }
    state[e] = 1;
    degIn[u]++; degIn[v]++; degUnk[u]--; degUnk[v]--;
    return true;
  };
  const setOut = e => {
    if (state[e]) return state[e] === 2;
    const u = EU[e], v = EV[e];
    if (degIn[u] + degUnk[u] <= 2 || degIn[v] + degUnk[v] <= 2) return false;
    state[e] = 2;
    degUnk[u]--; degUnk[v]--;
    return true;
  };
  for (const e of clueEdges) if (!setIn(e)) return false;
  for (let changed = true; changed;) {
    changed = false;
    for (let v = 0; v < N; v++) {
      if (!degUnk[v]) continue;
      if (degIn[v] === 2) {
        for (const e of vAdj[v]) if (!state[e]) { if (!setOut(e)) return false; changed = true; }
      } else if (degIn[v] + degUnk[v] === 2) {
        for (const e of vAdj[v]) if (!state[e]) { if (!setIn(e)) return false; changed = true; }
      }
    }
    for (let e = 0; e < E; e++) {
      if (state[e]) continue;
      const u = EU[e], v = EV[e];
      if (degIn[u] !== 1 || degIn[v] !== 1 || partner[u] !== v) continue;
      if (!(plen[u] === N ? setIn(e) : setOut(e))) return false;
      changed = true;
    }
  }
  for (let e = 0; e < E; e++) if (!state[e]) return false;
  return true;
}

/* The medium solver: the engine's own propagation (degree forcing plus cell
   parity), the no-closed-loop rule, and a depth-1 what-if — try each
   undecided edge both ways, and when exactly one way survives propagation,
   keep it. No deduction looks past one edge, but chains of them can run
   long. `cap` bounds total applies so a pathological board answers "not
   solvable" instead of stalling. Single loop, edge clues only. */
function mediumSolves(R, C, clueEdges, cap = 4e6) {
  const eng = new FencesSolver(R, C, clueEdges, { loops: 1 });
  if (eng.impossible || eng.done) return false;
  const N = R * C, E = eng.E, EU = eng.EU, EV = eng.EV, state = eng.state;
  let work = 0;
  for (;;) {
    let fired = false;
    for (let e = 0; e < E; e++) { // no-closed-loop deductions
      if (state[e]) continue;
      const u = EU[e], v = EV[e];
      if (eng.degIn[u] !== 1 || eng.degIn[v] !== 1 || eng.partner[u] !== v) continue;
      if (!eng.apply(e, eng.plen[u] === N ? 1 : 2)) return false;
      fired = true;
    }
    if (fired) continue;
    let open = 0;
    for (let e = 0; e < E; e++) if (!state[e]) open++;
    if (!open) return true;
    for (let e = 0; e < E; e++) { // depth-1 what-if
      if (state[e]) continue;
      if ((work += 2) > cap) return false;
      const mark = eng.teTop;
      const okIn = eng.apply(e, 1); eng.undoTo(mark);
      const okOut = eng.apply(e, 2); eng.undoTo(mark);
      if (!okIn && !okOut) return false;
      if (okIn === okOut) continue; // no information
      if (!eng.apply(e, okIn ? 1 : 2)) return false;
      fired = true;
    }
    if (!fired) return false;
  }
}

function genInsideCells(R, C, solutionEdges) {
  // cell insideness by crossing parity, exactly as the engine tallies it
  const HE = R * (C - 1), FC = C - 1;
  const inSol = new Set(solutionEdges);
  const inside = new Uint8Array((R - 1) * FC);
  for (let r = 0; r < R - 1; r++) {
    let flag = 0;
    for (let c = 0; c < FC; c++) {
      if (inSol.has(HE + r * C + c)) flag ^= 1;
      if (flag) inside[r * FC + c] = 1;
    }
  }
  return inside;
}

/* Incremental generator. step(budgetMs) advances the work and returns
   whether any remains; when done, either `error` holds a short message or
   `result` (clue ids) and `solution` (the solution's edges) are set.
   progress() is a 0..1 fraction of reduction candidates settled. Uniqueness
   checks that outgrow their node cap conservatively keep their clue, so the
   result stays unique no matter what. */
class FencesGen {
  constructor(R, C, opts = {}) {
    this.R = R; this.C = C;
    this.diff = opts.difficulty || 'hard';
    const ruled = this.diff === 'easy' || this.diff === 'medium';
    this.L = ruled ? 1 : Math.max(1, opts.loops | 0 || 1);
    this.dots = !ruled && !!opts.dots;
    this.attempts = this.diff === 'expert' ? 3 : 1;
    this.done = false; this.error = null;
    this.result = null; this.solution = null;
    this.retries = 2;
    this.restart();
  }

  restart() {
    this.phase = 'solution';
    this.solution = null;
    this.eng = new FencesSolver(this.R, this.C, [], { loops: this.L, rand: true, stopAtFirst: true });
  }

  fail() {
    this.done = true;
    this.error = 'No puzzle fits these settings';
    this.eng = this.check = null;
    return false;
  }

  beginPass() {
    const order = this.full.slice(); // Fisher–Yates
    for (let i = order.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [order[i], order[j]] = [order[j], order[i]];
    }
    this.order = order;
    this.cur = new Set(this.full);
    this.idx = 0;
    this.check = null;
  }

  step(budgetMs) {
    if (this.done) return false;
    const t0 = performance.now();
    do {
      if (this.phase === 'solution') {
        this.eng.run(budgetMs - (performance.now() - t0));
        if (!this.eng.done) {
          if (this.eng.nodes > 6e7) return this.fail();
          continue;
        }
        if (!this.eng.solutionEdges) return this.fail();
        this.solution = this.eng.solutionEdges.slice();
        this.E = this.eng.E;
        this.full = this.solution.slice();
        if (this.dots) {
          const inside = genInsideCells(this.R, this.C, this.solution);
          for (let f = 0; f < inside.length; f++) this.full.push(this.E + 2 * f + (inside[f] ? 0 : 1));
        }
        this.eng = null;
        this.pass = 0; this.best = null;
        this.beginPass();
        this.phase = 'reduce';
        continue;
      }
      if (this.idx >= this.order.length) { // pass finished
        if (!this.best || this.cur.size < this.best.size) this.best = this.cur;
        if (++this.pass < this.attempts) { this.beginPass(); continue; }
        this.result = [...this.best];
        if (this.diff !== 'easy' && this.L === 1 && this.retries > 0 &&
            this.result.every(id => id < this.E) && easySolves(this.R, this.C, this.result)) {
          this.retries--; // a dud: the one-step rules alone crack it
          this.restart();
          continue;
        }
        this.done = true;
        return false;
      }
      const cand = this.order[this.idx];
      if (this.diff === 'easy' || this.diff === 'medium') {
        this.cur.delete(cand);
        const solves = this.diff === 'easy'
          ? easySolves(this.R, this.C, this.cur)
          : mediumSolves(this.R, this.C, this.cur);
        if (!solves) this.cur.add(cand);
        this.idx++;
        continue;
      }
      if (!this.check) { // hard/expert: exact uniqueness without cand
        const test = new Set(this.cur);
        test.delete(cand);
        this.check = new FencesSolver(this.R, this.C, test, { loops: this.L, maxSolutions: 2 });
      }
      this.check.run(budgetMs - (performance.now() - t0));
      if (!this.check.done) {
        if (this.check.nodes > 4e6) { this.check = null; this.idx++; } // too costly: keep the clue
        continue;
      }
      if (this.check.solutions === 1) this.cur.delete(cand);
      this.check = null;
      this.idx++;
    } while (performance.now() - t0 < budgetMs);
    return !this.done;
  }

  progress() {
    if (this.phase !== 'reduce' || !this.full.length) return 0;
    return (this.pass * this.full.length + this.idx) / (this.attempts * this.full.length);
  }
}

globalThis.FencesGen = FencesGen;
globalThis.FencesGenRules = Object.freeze({ easySolves, mediumSolves, insideCells: genInsideCells });
if (typeof module !== 'undefined') module.exports = { FencesGen, easySolves, mediumSolves, insideCells: genInsideCells };
