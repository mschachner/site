// Theme presets + application. A theme is a set of colors plus two shape
// knobs: `organic` (0..1, how blobby tiles/entities are) and `anim`
// (movement transition in ms). Custom themes are edited live in the panel
// and persisted in settings.

export const COLOR_KEYS = [
  ['bg', 'background'],
  ['surface', 'floor'],
  ['player', 'player'],
  ['box', 'box'],
  ['boxDone', 'box on goal'],
  ['goal', 'goal'],
  ['text', 'text'],
  ['muted', 'muted text'],
  ['accent', 'accent'],
];

export const PRESETS = {
  moss: {
    name: 'Moss',
    organic: 0.8,
    anim: 120,
    colors: {
      bg: '#eee9dc', surface: '#fbf8f0', player: '#5d7a52', box: '#c0784e',
      boxDone: '#7da06d', goal: '#cfc6ad', text: '#3c372d', muted: '#999076',
      accent: '#5d7a52',
    },
  },
  paper: {
    name: 'Paper',
    organic: 0.35,
    anim: 100,
    colors: {
      bg: '#f4f4f2', surface: '#ffffff', player: '#2b2b2b', box: '#a8a29a',
      boxDone: '#2b2b2b', goal: '#d9d6d0', text: '#262626', muted: '#9a968f',
      accent: '#e2574c',
    },
  },
  midnight: {
    name: 'Midnight',
    organic: 0.6,
    anim: 120,
    dark: true,
    colors: {
      bg: '#171a21', surface: '#242935', player: '#8ab4f8', box: '#d8a657',
      boxDone: '#89b482', goal: '#3b4254', text: '#e3e6ec', muted: '#79808f',
      accent: '#8ab4f8',
    },
  },
  sand: {
    name: 'Sand',
    organic: 0.95,
    anim: 140,
    colors: {
      bg: '#f0e4d0', surface: '#faf3e6', player: '#b3593c', box: '#8c6f4e',
      boxDone: '#9c8a3c', goal: '#ddcdac', text: '#4a3b2a', muted: '#a8916f',
      accent: '#b3593c',
    },
  },
  ocean: {
    name: 'Ocean',
    organic: 0.7,
    anim: 110,
    colors: {
      bg: '#e3edee', surface: '#f7fbfb', player: '#246a73', box: '#e0a458',
      boxDone: '#5da27d', goal: '#c2d6d8', text: '#23393c', muted: '#7d9a9e',
      accent: '#246a73',
    },
  },
  sakura: {
    name: 'Sakura',
    organic: 0.85,
    anim: 130,
    colors: {
      bg: '#f6ecec', surface: '#fdf7f7', player: '#7a5c61', box: '#d98c8c',
      boxDone: '#a0668c', goal: '#e8d3d6', text: '#4a3a3d', muted: '#ab9296',
      accent: '#c96c7e',
    },
  },
  ember: {
    name: 'Ember',
    organic: 0.8,
    anim: 120,
    dark: true,
    colors: {
      bg: '#201613', surface: '#2f221b', player: '#e8a87c', box: '#a8552f',
      boxDone: '#8aa05a', goal: '#4a3527', text: '#f0e4da', muted: '#a08977',
      accent: '#e8a87c',
    },
  },
  forest: {
    name: 'Forest',
    organic: 0.85,
    anim: 130,
    dark: true,
    colors: {
      bg: '#141d16', surface: '#1f2c22', player: '#8fc97a', box: '#c9a45a',
      boxDone: '#6fae8f', goal: '#3a4a38', text: '#e2ead9', muted: '#7f9180',
      accent: '#8fc97a',
    },
  },
  ink: {
    name: 'Ink',
    organic: 0.35,
    anim: 100,
    dark: true,
    colors: {
      bg: '#191919', surface: '#242424', player: '#e8e8e8', box: '#6f6a64',
      boxDone: '#e8e8e8', goal: '#3a3a3a', text: '#ededed', muted: '#8b8b8b',
      accent: '#e2574c',
    },
  },
  dusk: {
    name: 'Dusk',
    organic: 0.7,
    anim: 130,
    dark: true,
    colors: {
      bg: '#1b1722', surface: '#272132', player: '#a78bda', box: '#cf8d6a',
      boxDone: '#7fae8c', goal: '#3c3450', text: '#e8e3f0', muted: '#8d85a0',
      accent: '#a78bda',
    },
  },
};

export function applyTheme(theme) {
  const root = document.documentElement.style;
  for (const [key] of COLOR_KEYS) {
    root.setProperty('--' + cssName(key), theme.colors[key]);
  }
  root.setProperty('--organic', String(theme.organic));
  root.setProperty('--anim', theme.anim + 'ms');
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = theme.colors.bg;
}

export function cssName(key) {
  return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}
