import { RULESETS } from './rules.js';

// Game holds the live state of one puzzle attempt: player/box positions,
// plus full undo/redo history. Moves are counted as history.length, so
// undoing genuinely takes moves back.
export class Game {
  constructor(puzzle, rulesetId = 'classic') {
    const { w, h } = puzzle;
    const goalSet = new Uint8Array(w * h);
    for (const g of puzzle.goals) goalSet[g] = 1;
    this.level = {
      w,
      h,
      walls: Uint8Array.from(puzzle.walls),
      goals: puzzle.goals.slice(),
      goalSet,
    };
    this.rules = RULESETS[rulesetId] ?? RULESETS.classic;
    this.puzzle = puzzle;
    this.deltas = { up: -w, down: w, left: -1, right: 1 };
    this.reset();
  }

  reset() {
    this.player = this.puzzle.player;
    this.boxPos = this.puzzle.boxes.slice();
    this.boxAt = new Int16Array(this.level.w * this.level.h).fill(-1);
    this.boxPos.forEach((b, i) => (this.boxAt[b] = i));
    this.history = [];
    this.redoStack = [];
  }

  get moves() {
    return this.history.length;
  }

  move(dirName) {
    const delta = this.deltas[dirName];
    if (delta === undefined) return null;
    const fx = this.rules.tryMove(this.level, this, delta);
    if (!fx) return null;
    const entry = { dir: dirName, playerFrom: this.player, fx };
    this.#apply(fx);
    this.history.push(entry);
    this.redoStack.length = 0;
    return fx;
  }

  undo() {
    const entry = this.history.pop();
    if (!entry) return null;
    const { fx } = entry;
    if (fx.push) {
      const p = fx.push;
      this.boxAt[p.to] = -1;
      this.boxAt[p.from] = p.boxId;
      this.boxPos[p.boxId] = p.from;
    }
    this.player = entry.playerFrom;
    this.redoStack.push(entry);
    return entry;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.#apply(entry.fx);
    this.history.push(entry);
    return entry;
  }

  #apply(fx) {
    if (fx.push) {
      const p = fx.push;
      this.boxAt[p.from] = -1;
      this.boxAt[p.to] = p.boxId;
      this.boxPos[p.boxId] = p.to;
    }
    this.player = fx.playerTo;
  }

  isSolved() {
    return this.rules.isSolved(this.level, this);
  }
}
