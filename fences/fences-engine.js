/* Fences+ solver: exact backtracking enumeration of solutions made of exactly
   `loops` disjoint loops that together pass through every dot (2-factors of
   the grid graph with a fixed component count) and include all clue edges.
   Edge states: 0 unknown, 1 in, 2 out. Every vertex must end at degree 2.
   Loop structure is tracked per open path via its two endpoints (partner[])
   and vertex count (plen[]): an edge joining two ends of the same path closes
   a loop, allowed only while loops remain to be closed, only if enough dots
   remain for the rest (each grid loop needs at least 4), and, for the final
   loop, only if it covers every remaining dot.
   No loop may lie inside another, and all loops must enclose the same
   number of cells. Areas are computed by shoelace when a loop closes and
   unequal closes are rejected immediately (equal areas also rule out
   nesting, since a nested loop is strictly smaller); completions with a
   nested loop are additionally caught in record() as a safety net.
   Clue ids: 0..E-1 are edges; E + 2*cell marks cell indoors, E + 2*cell + 1
   outdoors. Cells are the grid's faces plus one outer face (always outdoors);
   indoors means inside a loop (exactly one, since nesting is forbidden, so
   crossing parity equals insideness). A loop edge must separate indoors from
   outdoors, a non-loop edge must not, so face values propagate across decided
   edges and force edges between two known faces. */
class Fences {
  constructor(R, C, clues, opts = {}) {
    this.R = R; this.C = C; this.N = R * C;
    this.rand = !!opts.rand;
    this.stopAtFirst = !!opts.stopAtFirst;
    this.maxSolutions = opts.maxSolutions || 0;
    this.L = Math.max(1, opts.loops | 0 || 1); // required number of loops
    const HE = R * (C - 1), E = HE + (R - 1) * C;
    this.HE = HE; this.E = E;

    const EU = new Int32Array(E), EV = new Int32Array(E);
    let k = 0;
    for (let r = 0; r < R; r++) for (let c = 0; c < C - 1; c++) { EU[k] = r * C + c; EV[k] = r * C + c + 1; k++; }
    for (let r = 0; r < R - 1; r++) for (let c = 0; c < C; c++) { EU[k] = r * C + c; EV[k] = (r + 1) * C + c; k++; }
    this.EU = EU; this.EV = EV;

    // faces: (R-1)*(C-1) cells plus the outer face F, permanently outdoors
    const FC = C - 1, F = (R - 1) * FC;
    this.F = F;
    const eFaceA = new Int32Array(E), eFaceB = new Int32Array(E);
    for (let r = 0; r < R; r++) for (let c = 0; c < C - 1; c++) {
      const e = r * (C - 1) + c;
      eFaceA[e] = r > 0 ? (r - 1) * FC + c : F;
      eFaceB[e] = r < R - 1 ? r * FC + c : F;
    }
    for (let r = 0; r < R - 1; r++) for (let c = 0; c < C; c++) {
      const e = HE + r * C + c;
      eFaceA[e] = c > 0 ? r * FC + (c - 1) : F;
      eFaceB[e] = c < C - 1 ? r * FC + c : F;
    }
    this.eFaceA = eFaceA; this.eFaceB = eFaceB;
    const faceEdges = new Int32Array(4 * F);
    for (let r = 0; r < R - 1; r++) for (let c = 0; c < FC; c++) {
      const f = r * FC + c;
      faceEdges[4 * f] = r * (C - 1) + c;
      faceEdges[4 * f + 1] = (r + 1) * (C - 1) + c;
      faceEdges[4 * f + 2] = HE + r * C + c;
      faceEdges[4 * f + 3] = HE + r * C + c + 1;
    }
    this.faceEdges = faceEdges;
    this.faceVal = new Int8Array(F + 1); // 0 unknown, 1 in, 2 out
    this.faceVal[F] = 2;
    this.fQueue = new Int32Array(F + 4); this.fqHead = 0; this.fqTail = 0;
    this.cellHeat = new Float64Array(F);

    const deg = new Int32Array(this.N);
    for (let e = 0; e < E; e++) { deg[EU[e]]++; deg[EV[e]]++; }
    const vStart = new Int32Array(this.N + 1);
    for (let v = 0; v < this.N; v++) vStart[v + 1] = vStart[v] + deg[v];
    const vList = new Int32Array(vStart[this.N]);
    const fill = vStart.slice(0, this.N);
    for (let e = 0; e < E; e++) { vList[fill[EU[e]]++] = e; vList[fill[EV[e]]++] = e; }
    this.vStart = vStart; this.vList = vList;

    this.state = new Int8Array(E);
    this.degIn = new Int8Array(this.N);
    this.degUnk = new Int8Array(this.N);
    for (let v = 0; v < this.N; v++) this.degUnk[v] = deg[v];
    this.partner = new Int32Array(this.N);
    this.plen = new Int32Array(this.N);
    for (let v = 0; v < this.N; v++) { this.partner[v] = v; this.plen[v] = 1; }
    this.closed = 0;  // loops closed so far
    this.closedV = 0; // dots used up by closed loops
    this.closedAreas = new Int32Array(this.L); // enclosed cells per closed loop

    this.trailE = new Int32Array(E + F + 4); this.teTop = 0; // edges + face records
    this.trailP = new Int32Array(12 * E); this.tpTop = 0;
    this.queue = new Int32Array(2 * E + this.N + 8); this.qHead = 0; this.qTail = 0;

    this.fEdge = new Int32Array(E + 2); this.fPhase = new Int8Array(E + 2);
    this.fMark = new Int32Array(E + 2); this.fVal = new Int8Array(E + 2);
    this.fTop = 0;

    this.heat = new Float64Array(E);
    this.solutions = 0; this.nodes = 0;
    this.done = false; this.mode = 0; // 0 branch, 1 backtrack
    this.solutionEdges = null;
    this.impossible = null;

    if (R < 2 || C < 2) { this.impossible = 'small'; this.done = true; return; }
    if (this.N % 2 === 1) { this.impossible = 'parity'; this.done = true; return; }
    if (4 * this.L > this.N) { this.impossible = 'loops'; this.done = true; return; }

    for (let v = 0; v < this.N; v++) this.queue[this.qTail++] = v;
    let ok = true;
    for (const id of clues) {
      if (id < E) {
        if (this.state[id] === 1) continue;
        if (this.state[id] === 2 || !this.setIn(id)) { ok = false; break; }
      } else { // cell dot clue
        const k = id - E, f = k >> 1, v = (k & 1) + 1;
        if (this.faceVal[f] === v) continue;
        if (this.faceVal[f] !== 0) { ok = false; break; } // both dots on one cell
        this.setFaceVal(f, v);
      }
    }
    if (ok && opts.exclude) {
      for (const e of opts.exclude) {
        if (this.state[e] === 2) continue;
        if (this.state[e] === 1 || !this.setOut(e)) { ok = false; break; }
      }
    }
    if (ok) ok = this.propagate();
    if (!ok) this.done = true;
  }

  loopArea(u, v) {
    // cells enclosed by the open path u..v (edges already in) plus edge v-u,
    // by shoelace: for a rectilinear lattice loop, |sum|/2 = enclosed cells
    const C = this.C, vStart = this.vStart, vList = this.vList, state = this.state;
    const EU = this.EU, EV = this.EV;
    let sum = 0, prev = -1, a = u;
    while (a !== v) {
      let nxt = -1;
      for (let i = vStart[a]; i < vStart[a + 1]; i++) {
        const e = vList[i];
        if (state[e] !== 1) continue;
        const w = EU[e] === a ? EV[e] : EU[e];
        if (w !== prev) { nxt = w; break; }
      }
      sum += (a % C) * ((nxt / C) | 0) - (nxt % C) * ((a / C) | 0);
      prev = a; a = nxt;
    }
    sum += (v % C) * ((u / C) | 0) - (u % C) * ((v / C) | 0);
    return Math.abs(sum) / 2;
  }

  setFaceVal(f, v) { // caller guarantees faceVal[f] === 0 and f !== outer
    this.faceVal[f] = v;
    this.trailE[this.teTop++] = ~f; // negative trail records undo face values
    this.fQueue[this.fqTail++] = f;
  }

  setIn(e) {
    const u = this.EU[e], v = this.EV[e];
    const degIn = this.degIn;
    if (degIn[u] >= 2 || degIn[v] >= 2) return false;
    const partner = this.partner, plen = this.plen;
    const eu = partner[u], ev = partner[v];
    const closes = eu === v; // u and v are the two ends of one open path
    let area = 0;
    if (closes) {
      const left = this.L - this.closed - 1;       // loops still owed after this one
      const rem = this.N - this.closedV - plen[u]; // dots not on any closed loop
      if (left < 0) return false;
      if (left === 0 ? rem !== 0 : rem < 4 * left) return false;
      if (this.L > 1) { // all loops must enclose the same number of cells
        area = this.loopArea(u, v);
        if (this.closed > 0 && area !== this.closedAreas[0]) return false;
      }
    }
    const fa = this.eFaceA[e], fb = this.eFaceB[e];
    const fva = this.faceVal[fa], fvb = this.faceVal[fb];
    if (fva !== 0 && fva === fvb) return false; // loop edge must separate in from out
    const tp = this.trailP; let t = this.tpTop;
    tp[t++] = u;  tp[t++] = partner[u];  tp[t++] = plen[u];
    tp[t++] = v;  tp[t++] = partner[v];  tp[t++] = plen[v];
    tp[t++] = eu; tp[t++] = partner[eu]; tp[t++] = plen[eu];
    tp[t++] = ev; tp[t++] = partner[ev]; tp[t++] = plen[ev];
    this.tpTop = t;
    this.trailE[this.teTop++] = (e << 2) | (closes ? 3 : 1);
    this.state[e] = 1;
    degIn[u]++; degIn[v]++;
    this.degUnk[u]--; this.degUnk[v]--;
    if (closes) {
      this.closedAreas[this.closed] = area;
      this.closed++; this.closedV += plen[u];
    } else {
      const len = plen[eu] + plen[ev];
      partner[eu] = ev; partner[ev] = eu;
      plen[eu] = len; plen[ev] = len;
    }
    if (fva !== 0) { if (fvb === 0) this.setFaceVal(fb, 3 - fva); }
    else if (fvb !== 0) this.setFaceVal(fa, 3 - fvb);
    this.queue[this.qTail++] = u; this.queue[this.qTail++] = v;
    return true;
  }

  setOut(e) {
    const u = this.EU[e], v = this.EV[e];
    if (this.degIn[u] + this.degUnk[u] <= 2) return false; // edge is needed at u
    if (this.degIn[v] + this.degUnk[v] <= 2) return false;
    const fa = this.eFaceA[e], fb = this.eFaceB[e];
    const fva = this.faceVal[fa], fvb = this.faceVal[fb];
    if (fva !== 0 && fvb !== 0 && fva !== fvb) return false; // sides differ: edge must be in
    this.trailE[this.teTop++] = e << 2;
    this.state[e] = 2;
    this.degUnk[u]--; this.degUnk[v]--;
    if (fva !== 0) { if (fvb === 0) this.setFaceVal(fb, fva); }
    else if (fvb !== 0) this.setFaceVal(fa, fvb);
    this.queue[this.qTail++] = u; this.queue[this.qTail++] = v;
    return true;
  }

  propagate() {
    const q = this.queue, degIn = this.degIn, degUnk = this.degUnk;
    const vStart = this.vStart, vList = this.vList, state = this.state;
    const fq = this.fQueue, faceVal = this.faceVal, fe = this.faceEdges;
    const eA = this.eFaceA, eB = this.eFaceB;
    for (;;) {
      while (this.qHead < this.qTail) {
        const v = q[this.qHead++];
        const di = degIn[v], du = degUnk[v];
        if (di + du < 2 || di > 2) return false;
        if (du === 0) continue;
        if (di === 2) {
          for (let i = vStart[v]; i < vStart[v + 1]; i++) {
            const e = vList[i];
            if (state[e] === 0 && !this.setOut(e)) return false;
          }
        } else if (di + du === 2) {
          for (let i = vStart[v]; i < vStart[v + 1]; i++) {
            const e = vList[i];
            if (state[e] === 0 && !this.setIn(e)) return false;
          }
        }
      }
      if (this.fqHead >= this.fqTail) return true;
      // a cell just became in/out: spread across decided edges, force edges
      // whose other side is already known
      const f = fq[this.fqHead++], v = faceVal[f];
      for (let i = 4 * f; i < 4 * f + 4; i++) {
        const e = fe[i];
        const g = eA[e] === f ? eB[e] : eA[e];
        const gv = faceVal[g], s = state[e];
        if (s === 0) {
          if (gv !== 0 && !(gv === v ? this.setOut(e) : this.setIn(e))) return false;
        } else {
          const want = s === 1 ? 3 - v : v;
          if (gv === 0) this.setFaceVal(g, want);
          else if (gv !== want) return false;
        }
      }
    }
  }

  undoTo(mark) {
    const trailE = this.trailE, state = this.state, EU = this.EU, EV = this.EV;
    while (this.teTop > mark) {
      const rec = trailE[--this.teTop];
      if (rec < 0) { this.faceVal[~rec] = 0; continue; }
      const e = rec >> 2, u = EU[e], v = EV[e];
      state[e] = 0;
      this.degUnk[u]++; this.degUnk[v]++;
      if (rec & 1) {
        this.degIn[u]--; this.degIn[v]--;
        const tp = this.trailP, t = this.tpTop - 12;
        for (let i = 0; i < 12; i += 3) {
          const x = tp[t + i];
          this.partner[x] = tp[t + i + 1];
          this.plen[x] = tp[t + i + 2];
        }
        this.tpTop = t;
        if (rec & 2) { this.closed--; this.closedV -= this.plen[u]; } // reopen the loop
      }
    }
  }

  apply(e, val) {
    this.qHead = 0; this.qTail = 0;
    this.fqHead = 0; this.fqTail = 0;
    let ok = val === 1 ? this.setIn(e) : this.setOut(e);
    if (ok) ok = this.propagate();
    return ok;
  }

  unkEdgeOf(v) {
    const s = this.vStart[v], t = this.vStart[v + 1];
    const state = this.state, vList = this.vList;
    if (this.rand) {
      let pick = -1, n = 0;
      for (let i = s; i < t; i++) {
        const e = vList[i];
        if (state[e] === 0) { n++; if (Math.random() * n < 1) pick = e; }
      }
      return pick;
    }
    for (let i = s; i < t; i++) { const e = vList[i]; if (state[e] === 0) return e; }
    return -1;
  }

  chooseEdge() {
    const N = this.N, degIn = this.degIn, degUnk = this.degUnk;
    const off = this.rand ? (Math.random() * N) | 0 : 0;
    let fb = -1;
    for (let i = 0; i < N; i++) {
      const v = off === 0 ? i : (i + off) % N;
      if (degUnk[v] === 0) continue;
      if (degIn[v] === 1) return this.unkEdgeOf(v); // extend an open path end
      if (fb < 0) fb = v;
    }
    return fb < 0 ? -1 : this.unkEdgeOf(fb);
  }

  nested() {
    // label each dot's loop, then row-scan: crossing a vertical edge toggles
    // its loop open/closed. Two loops open at once = a cell enclosed twice,
    // which happens iff some loop lies inside another (loops cannot cross).
    const N = this.N, C = this.C, HE = this.HE, state = this.state;
    const vStart = this.vStart, vList = this.vList, EU = this.EU, EV = this.EV;
    if (!this.loopIdBuf) {
      this.loopIdBuf = new Int32Array(N);
      this.openBuf = new Int32Array(N);
      this.stamp = 0;
    }
    const loopId = this.loopIdBuf, open = this.openBuf;
    loopId.fill(-1);
    let nid = 0;
    for (let v0 = 0; v0 < N; v0++) {
      if (loopId[v0] !== -1) continue;
      let prev = -1, v = v0;
      do {
        loopId[v] = nid;
        let next = -1;
        for (let i = vStart[v]; i < vStart[v + 1]; i++) {
          const e = vList[i];
          if (state[e] !== 1) continue;
          const w = EU[e] === v ? EV[e] : EU[e];
          if (w !== prev) { next = w; break; }
        }
        prev = v; v = next;
      } while (v !== v0);
      nid++;
    }
    const stamp = ++this.stamp; // stale openBuf entries never match a new stamp
    for (let r = 0; r < this.R - 1; r++) {
      let depth = 0;
      for (let c = 0; c < C; c++) {
        if (state[HE + r * C + c] !== 1) continue;
        const id = loopId[r * C + c];
        if (open[id] === stamp) { open[id] = 0; depth--; }
        else { open[id] = stamp; depth++; if (depth >= 2) return true; }
      }
    }
    return false;
  }

  record() {
    if (this.L > 1 && this.nested()) return; // a loop inside another: not a solution
    this.solutions++;
    const state = this.state, heat = this.heat, E = this.E;
    for (let e = 0; e < E; e++) if (state[e] === 1) heat[e]++;
    // count indoors cells: parity of loop edges crossed walking in from the left
    const ch = this.cellHeat, C = this.C, HE = this.HE;
    for (let r = 0; r < this.R - 1; r++) {
      let inside = 0;
      const base = r * (C - 1);
      for (let c = 0; c < C - 1; c++) {
        if (state[HE + r * C + c] === 1) inside ^= 1;
        if (inside) ch[base + c]++;
      }
    }
    if (this.stopAtFirst || this.maxSolutions) { // bounded runs keep the latest solution
      const sol = [];
      for (let e = 0; e < E; e++) if (state[e] === 1) sol.push(e);
      this.lastSolution = sol;
      if (this.stopAtFirst) { this.solutionEdges = sol; this.done = true; }
      if (this.maxSolutions && this.solutions >= this.maxSolutions) this.done = true;
    }
  }

  run(budgetMs) {
    if (this.done) return;
    const t0 = performance.now();
    const fEdge = this.fEdge, fPhase = this.fPhase, fMark = this.fMark, fVal = this.fVal;
    let mode = this.mode;
    for (;;) {
      if ((this.nodes & 2047) === 0 && performance.now() - t0 >= budgetMs) break;
      this.nodes++;
      if (mode === 0) {
        const e = this.chooseEdge();
        if (e < 0) {
          this.record();
          if (this.done) break;
          mode = 1;
          continue;
        }
        const v0 = this.rand ? (Math.random() < 0.5 ? 1 : 2) : 1;
        const f = this.fTop++;
        fEdge[f] = e; fPhase[f] = 0; fMark[f] = this.teTop; fVal[f] = v0;
        if (this.apply(e, v0)) continue;
        this.undoTo(fMark[f]);
        fPhase[f] = 1;
        if (this.apply(e, v0 === 1 ? 2 : 1)) continue;
        this.undoTo(fMark[f]);
        this.fTop--;
        mode = 1;
      } else {
        if (this.fTop === 0) { this.done = true; break; }
        const f = this.fTop - 1;
        this.undoTo(fMark[f]);
        if (fPhase[f] === 0) {
          fPhase[f] = 1;
          if (this.apply(fEdge[f], fVal[f] === 1 ? 2 : 1)) { mode = 0; continue; }
          this.undoTo(fMark[f]);
          this.fTop--;
        } else {
          this.fTop--;
        }
      }
    }
    this.mode = mode;
  }
}

function vertexEdges(R, C, v) {
  const r = (v / C) | 0, c = v % C, edges = [];
  const horizontalEdges = R * (C - 1);
  if (c > 0) edges.push(r * (C - 1) + c - 1);
  if (c < C - 1) edges.push(r * (C - 1) + c);
  if (r > 0) edges.push(horizontalEdges + (r - 1) * C + c);
  if (r < R - 1) edges.push(horizontalEdges + r * C + c);
  return edges;
}

function vertexDegreeState(R, C, v, clues, marks) {
  const edges = vertexEdges(R, C, v);
  let fences = 0, blocked = 0;
  for (const e of edges) {
    if (clues.has(e) || marks[e] === 1) fences++;
    else if (marks[e] === 2) blocked++;
  }
  return { edges, fences, blocked, invalid: fences > 2 || blocked > edges.length - 2 };
}

function applyDegree2(R, C, clues, marks, protectedEdge = -1) {
  const nextMarks = Int8Array.from(marks);
  const changes = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let v = 0; v < R * C; v++) {
      const { edges, fences, blocked, invalid } = vertexDegreeState(R, C, v, clues, nextMarks);
      if (invalid) continue;
      const forcedMark = fences === 2 ? 2 : edges.length - blocked === 2 ? 1 : 0;
      if (!forcedMark) continue;
      for (const e of edges) {
        if (e === protectedEdge || clues.has(e) || nextMarks[e] !== 0) continue;
        nextMarks[e] = forcedMark;
        changes.push([e, 0, forcedMark]);
        changed = true;
      }
    }
  }
  return { marks: nextMarks, changes };
}

const FencesRules = Object.freeze({ vertexEdges, vertexDegreeState, applyDegree2 });
globalThis.Fences = Fences;
globalThis.FencesRules = FencesRules;
if (typeof module !== 'undefined') module.exports = { Fences, FencesRules };
