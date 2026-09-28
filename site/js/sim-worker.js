// Runs the tournament Monte Carlo off the main thread.
import { simulate } from './model.js';

self.onmessage = (e) => {
  const { id, cfg } = e.data;
  const t0 = performance.now();
  try {
    const result = simulate(cfg);
    self.postMessage({ id, result, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
