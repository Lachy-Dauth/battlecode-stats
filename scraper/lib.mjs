// Fetching and decoding for game.battlecode.au's public SvelteKit page data.
//
// Every page on the site has a matching `<path>/__data.json` endpoint that
// returns the page's load() data in SvelteKit's "devalue" format. Pages that
// stream (e.g. /teams/:id) send extra NDJSON "chunk" lines that resolve
// promises in the first line. No API key is needed for anything read here.

export const BASE = 'https://game.battlecode.au';
const UA = process.env.SCRAPER_UA ||
  'battlecode-stats/1.0 (+https://github.com/Lachy-Dauth/battlecode-stats)';

// ---- polite request scheduler -------------------------------------------

const MIN_GAP_MS = Number(process.env.SCRAPER_GAP_MS || 350);
const CONCURRENCY = Number(process.env.SCRAPER_CONCURRENCY || 2);
let active = 0;
let lastStart = 0;
const waiting = [];
export const stats = { requests: 0, retries: 0, bytes: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function slot() {
  while (active >= CONCURRENCY) await new Promise((r) => waiting.push(r));
  active++;
  const wait = lastStart + MIN_GAP_MS - Date.now();
  lastStart = Math.max(Date.now(), lastStart + MIN_GAP_MS);
  if (wait > 0) await sleep(wait);
}
function release() {
  active--;
  const next = waiting.shift();
  if (next) next();
}

async function fetchText(path, cookie) {
  for (let attempt = 0; ; attempt++) {
    await slot();
    let res;
    try {
      res = await fetch(BASE + path, {
        headers: { 'User-Agent': UA, Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        signal: AbortSignal.timeout(45000),
      });
      stats.requests++;
      if (res.ok) {
        const text = await res.text();
        stats.bytes += text.length;
        return text;
      }
      if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(`HTTP ${res.status} for ${path}`), { fatal: true });
    } catch (err) {
      if (err.fatal || attempt >= 4) throw err;
    } finally {
      release();
    }
    stats.retries++;
    const retryAfter = Number(res?.headers?.get('retry-after'));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt);
  }
}

// ---- devalue ---------------------------------------------------------------

export function unflatten(values) {
  const hydrated = new Array(values.length);
  const done = new Array(values.length).fill(false);
  function h(i) {
    if (i === -1) return undefined;
    if (i === -3) return NaN;
    if (i === -4) return Infinity;
    if (i === -5) return -Infinity;
    if (i === -6) return -0;
    if (done[i]) return hydrated[i];
    done[i] = true;
    const v = values[i];
    if (!v || typeof v !== 'object') return (hydrated[i] = v);
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string') {
        const t = v[0];
        if (t === 'Date') return (hydrated[i] = new Date(v[1]).toISOString());
        if (t === 'Promise') return (hydrated[i] = { __promise: h(v[1]) });
        if (t === 'Set') { const a = []; hydrated[i] = a; for (let k = 1; k < v.length; k++) a.push(h(v[k])); return a; }
        if (t === 'Map') { const o = {}; hydrated[i] = o; for (let k = 1; k < v.length; k += 2) o[h(v[k])] = h(v[k + 1]); return o; }
        if (t === 'null') { const o = {}; hydrated[i] = o; for (let k = 1; k < v.length; k += 2) o[v[k]] = h(v[k + 1]); return o; }
        if (t === 'BigInt') return (hydrated[i] = Number(v[1]));
        return (hydrated[i] = null);
      }
      const a = new Array(v.length);
      hydrated[i] = a;
      for (let k = 0; k < v.length; k++) a[k] = v[k] === -2 ? undefined : h(v[k]);
      return a;
    }
    const o = {};
    hydrated[i] = o;
    for (const k in v) o[k] = h(v[k]);
    return o;
  }
  return h(0);
}

/**
 * Load a page's data. `list` sets the site's rows-per-page cookie (max 100)
 * for the paginated lists: leaderboard, battles, games.
 * Returns the page's own load() data (the last node), with streamed promises
 * resolved, or throws on a redirect (e.g. login-only pages).
 */
export async function pageData(path, { list } = {}) {
  const [p, q] = path.split('?');
  const url = `${p.replace(/\/$/, '')}/__data.json${q ? `?${q}` : ''}`;
  const text = await fetchText(url, list ? `rows-${list}=100` : undefined);
  const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const head = lines[0];
  if (head.type === 'redirect') throw new Error(`${path} redirects to ${head.location}`);
  if (head.type !== 'data') throw new Error(`${path}: unexpected ${head.type}`);
  const chunks = {};
  for (const c of lines.slice(1)) if (c.type === 'chunk') chunks[c.id] = c.data ? unflatten(c.data) : null;
  const fill = (o) => {
    if (o && typeof o === 'object') {
      if ('__promise' in o && Object.keys(o).length === 1) return fill(chunks[o.__promise] ?? null);
      for (const k in o) o[k] = fill(o[k]);
    }
    return o;
  };
  const node = head.nodes[head.nodes.length - 1];
  return fill(unflatten(node.data));
}

/** Run `fn` over items with the shared scheduler doing the throttling. */
export async function mapLimit(items, fn, onProgress) {
  const out = new Array(items.length);
  let next = 0, doneCount = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (err) { out[i] = { error: String(err.message || err) }; }
      doneCount++;
      if (onProgress && doneCount % 50 === 0) onProgress(doneCount, items.length);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY + 1 }, worker));
  return out;
}

export const toSec = (iso) => (iso ? Math.round(Date.parse(iso) / 1000) : null);
