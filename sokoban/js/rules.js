// Ruleset abstraction. A ruleset decides how a directional input transforms
// the state and what "solved" means. The engine and renderer stay
// rule-agnostic, so alternative Sokoban variants (multiban, pull-only,
// numbered boxes, ...) can be added by registering a new entry in RULESETS.
//
// tryMove returns null for an illegal move, otherwise an effect object:
//   { playerTo: cell, push: null | { boxId, from, to } }

export const ClassicRules = {
  id: 'classic',
  name: 'Classic',
  tryMove(level, state, delta) {
    const target = state.player + delta;
    if (level.walls[target]) return null;
    const boxId = state.boxAt[target];
    if (boxId === -1) return { playerTo: target, push: null };
    const beyond = target + delta;
    if (level.walls[beyond] || state.boxAt[beyond] !== -1) return null;
    return { playerTo: target, push: { boxId, from: target, to: beyond } };
  },
  isSolved(level, state) {
    return state.boxPos.every((b) => level.goalSet[b] === 1);
  },
};

export const RULESETS = { classic: ClassicRules };
