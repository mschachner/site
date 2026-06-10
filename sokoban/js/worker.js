import { generate } from './generator.js';

self.onmessage = (e) => {
  const { id, params } = e.data;
  let lastPost = 0;
  const result = generate(params, ({ attempt }) => {
    const now = Date.now();
    if (now - lastPost > 120) {
      lastPost = now;
      self.postMessage({ id, type: 'progress', attempt });
    }
  });
  self.postMessage({ id, type: 'done', result });
};
