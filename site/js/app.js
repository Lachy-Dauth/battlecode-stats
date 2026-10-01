import { TIERS, tierOf, expected, kForCount, eloDelta, fixedSeries, firstTo, seededSlots } from './model.js';
import { esc, lineChart, sparkline, columnChart, hbars, fmtWhen } from './charts.js';

// ---------------------------------------------------------------------------
// state & helpers
// ---------------------------------------------------------------------------
const S = {
  teams: [], byId: new Map(), meta: null, tour: null, recent: null,
  details: new Map(), oddsCache: new Map(), defaultOdds: null,
};
const SITE = 'https://game.battlecode.au';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const main = $('#main');

const store = {
  get(k, d) { try { const v = localStorage.getItem(`bcs.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`bcs.${k}`, JSON.stringify(v)); } catch {} },
};

async function getJSON(p) {
  const r = await fetch(`data/${p}`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
}
async function teamDetail(id) {
  if (!S.details.has(id)) S.details.set(id, getJSON(`teams/${id}.json`).catch(() => null));
  return S.details.get(id);
}

const now = () => Date.now() / 1000;
const pct = (p, d = 1) => (p == null || Number.isNaN(p) ? '—' : p <= 0 ? '0%' : p < 0.001 ? '<0.1%' : p > 0.999 && p < 1 ? '>99.9%' : `${(p * 100).toFixed(d)}%`);
const signed = (n) => (n == null ? '<span class="muted">—</span>' : n === 0 ? '<span class="muted">0</span>' : `<span class="${n > 0 ? 'up' : 'down'}">${n > 0 ? '+' : '−'}${Math.abs(n)}</span>`);
function ago(t) {
  if (!t) return '—';
  const s = now() - t;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const shortDate = (t) => new Date(t * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const teamLink = (id, name) => `<a href="#/team/${id}" class="tname">${esc(name ?? S.byId.get(id)?.name ?? `Team ${id}`)}</a>`;
const replayLink = (id, label = 'Replay') => `<a href="${SITE}/visualiser?match=${id}" target="_blank" rel="noopener">${label}</a>`;
const TIER_COLORS = ['#0d366b', '#104281', '#184f95', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#b7d3f6'];
const tierChip = (elo) => { const i = TIERS.findIndex((t) => elo >= t.min); return `<span class="tier"><i style="background:${TIER_COLORS[i]}"></i>${TIERS[i].name}</span>`; };
const winPct = (w, l) => (w + l ? w / (w + l) : null);
const myTeamId = () => store.get('myTeam', null);
const myTeam = () => S.byId.get(myTeamId()) || null;

/** Divisor for win probabilities: 400 is the site's Elo; the fitted one comes from real results. */
const fittedD = () => S.meta?.calibration?.fittedDivisor || 400;

/** Ranked challenge rule: both switches on, target no more than 50 below the challenger. */
const canChallenge = (from, to) => !!(from && to && from.id !== to.id && from.accepting && to.accepting && from.hasBot && to.hasBot && to.elo >= from.elo - 50);

function teamTags(t, { mine } = {}) {
  const tags = [];
  if (t.dev) tags.push('<span class="tag" title="Organiser team">DEV</span>');
  if (t.eligible) tags.push('<span class="tag" title="Eligible for the Qualifiers and Grand Final">APAC</span>');
  if (t.firstYear) tags.push('<span class="tag" title="First-year prize eligible">1st yr</span>');
  if (t.wgm) tags.push('<span class="tag" title="Women &amp; gender minorities prize eligible">WGM</span>');
  if (t.unsw) tags.push('<span class="tag">UNSW</span>');
  if (t.highSchool) tags.push('<span class="tag">High school</span>');
  if (t.submissionsSeen > 1 && t.submissionSince && now() - t.submissionSince < 86400) {
    tags.push(`<span class="tag new" title="Switched to submission #${t.submissionSince ? t.submission : ''} ${ago(t.submissionSince)}">New bot</span>`);
  }
  if (mine && canChallenge(mine, t)) tags.push('<span class="tag chal" title="You can request a ranked battle against this team">Can challenge</span>');
  return tags.length ? `<span class="tags">${tags.join('')}</span>` : '';
}

function switchCell(t) {
  if (!t.hasBot) return '<span class="tag off">No bot</span>';
  const next = (t.acceptingChangedAt || 0) + 8 * 3600;
  const lock = next > now() ? ` <span class="muted small" title="The switch has an eight-hour cooldown">· locked ${Math.ceil((next - now()) / 3600)}h</span>` : '';
  return `${t.accepting ? '<span class="tag on">On</span>' : '<span class="tag off">Off</span>'}${lock}`;
}

function setUpdated() {
  const t = S.meta?.updatedAt;
  $('#updated').innerHTML = t ? `Data updated ${ago(t)} (${esc(fmtWhen(t))}). ` : '';
}

function teamOptions() {
  $('#teamlist').innerHTML = [...S.teams].sort((a, b) => a.rank - b.rank)
    .map((t) => `<option value="${esc(`${t.name} #${t.id}`)}"></option>`).join('');
}
function parseTeam(str) {
  if (!str) return null;
  const m = String(str).match(/#(\d+)\s*$/);
  if (m && S.byId.has(Number(m[1]))) return S.byId.get(Number(m[1]));
  const lower = String(str).trim().toLowerCase();
  return S.teams.find((t) => t.name.toLowerCase() === lower) || null;
}
const teamValue = (t) => (t ? `${t.name} #${t.id}` : '');

function sortable(table, rows, cols, state, renderBody) {
  // Views re-render (filters, odds arriving) and call this again with new rows;
  // header handlers are bound once and always read the latest call's data.
  table._sort = { rows, cols, state, renderBody };
  const head = table.tHead;
  const apply = () => {
    const { rows: list, cols: cs, state: st, renderBody: body } = table._sort;
    const col = cs.find((c) => c.key === st.key) || cs[0];
    const dir = st.dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      const va = col.get(a), vb = col.get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
    });
    $$('th[data-sort]', head).forEach((th) => th.setAttribute('aria-sort', th.dataset.sort === st.key ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none'));
    body();
  };
  if (!table._sortBound) {
    table._sortBound = true;
    $$('th[data-sort]', head).forEach((th) => {
      th.classList.add('sortable');
      th.tabIndex = 0;
      const go = () => {
        const st = table._sort.state;
        const key = th.dataset.sort;
        if (st.key === key) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
        else { st.key = key; st.dir = th.dataset.dir || 'desc'; }
        apply();
        st.onChange?.();
      };
      th.addEventListener('click', go);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }
  apply();
}

// ---------------------------------------------------------------------------
// tournament simulation (web worker)
// ---------------------------------------------------------------------------
let worker, jobId = 0;
const pending = new Map();
function simWorker() {
  if (!worker) {
    worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.error ? p.reject(new Error(e.data.error)) : p.resolve({ ...e.data.result, ms: e.data.ms });
    };
  }
  return worker;
}

function bracketCfg(t, elo, reseed) {
  const entrants = [];
  for (const m of t.rounds?.[0] || []) for (const s of [m.a, m.b]) {
    if (s?.teamId == null) continue;
    entrants.push({ id: s.teamId, seed: s.seed });
    if (elo[s.teamId] == null) elo[s.teamId] = s.elo ?? 1500; // registered after the leaderboard was read
  }
  if (!entrants.length) return null;
  let slots, seedOf = {};
  const forced = [];
  if (reseed) {
    const order = entrants.map((e) => e.id).sort((a, b) => (elo[b] - elo[a]) || ((S.byId.get(b)?.gameWins || 0) - (S.byId.get(a)?.gameWins || 0)));
    order.forEach((id, i) => { seedOf[id] = i + 1; });
    slots = seededSlots(order);
  } else {
    slots = t.rounds[0].flatMap((m) => [m.a?.teamId ?? null, m.b?.teamId ?? null]);
    for (const e of entrants) seedOf[e.id] = e.seed;
    // Results already on the site (live or finished events) are fixed.
    t.rounds.forEach((round, r) => round.forEach((m, i) => {
      if (r > 0) {
        if (m.a?.teamId != null) ((forced[r - 1] ||= [])[2 * i] = m.a.teamId);
        if (m.b?.teamId != null) ((forced[r - 1] ||= [])[2 * i + 1] = m.b.teamId);
      }
      const w = m.winner === 'a' ? m.a?.teamId : m.winner === 'b' ? m.b?.teamId : m.winnerId;
      if (w != null) (forced[r] ||= [])[i] = w;
    }));
  }
  return { slots, bestOf: t.bestOf || 7, forced, seedOf };
}

function simulateOdds({ sims = 5000, D = 400, sigma = 0, overrides = {}, reseed = false } = {}) {
  const key = JSON.stringify({ sims, D, sigma, overrides, reseed, u: S.meta?.updatedAt });
  if (S.oddsCache.has(key)) return S.oddsCache.get(key);
  const elo = {};
  for (const t of S.teams) elo[t.id] = overrides[t.id] ?? t.elo;
  const sprintT = S.tour?.tournaments?.find((t) => t.kind === 'sprint' || t.id === 'sprint');
  const qualT = S.tour?.tournaments?.find((t) => t.kind === 'qualifier' || t.id === 'qualifier');
  const cfg = {
    sims, D, sigma, seed: 20261017, elo,
    sprint: sprintT ? bracketCfg(sprintT, elo, reseed) : null,
    qualifier: qualT ? bracketCfg(qualT, elo, reseed) : null,
    grandFinal: { bestOf: S.tour?.grandFinal?.bestOf || 5, size: S.tour?.grandFinal?.teams || 10 },
  };
  const id = ++jobId;
  const p = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    simWorker().postMessage({ id, cfg });
  }).then((res) => ({ ...res, cfg }));
  S.oddsCache.set(key, p);
  return p;
}
function defaultOdds() {
  return simulateOdds({ sims: 5000, D: 400 }).then((r) => (S.defaultOdds = r));
}
const oddsFor = (res, id) => {
  if (!res) return null;
  const s = res.sprint[id], q = res.qual[id], n = res.sims, R = res.sprintRounds;
  return {
    sprintWin: s ? s[R] / n : 0, sprintFinal: s ? s[R - 1] / n : 0, sprintSF: s ? s[R - 2] / n : 0, sprintQF: s ? s[R - 3] / n : 0,
    inSprint: !!s, inQual: !!res.cfg.qualifier?.seedOf?.[id],
    qualify: q ? q[2] / n : 0, qualifyDirect: q ? q[0] / n : 0, qualifyLoser: q ? q[1] / n : 0,
    gfFinal: q ? q[3] / n : 0, gfWin: q ? q[4] / n : 0, qualWin: q ? q[5] / n : 0,
  };
};

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

// ---- leaderboard ----------------------------------------------------------
function viewLeaderboard() {
  const f = Object.assign({ scope: 'on', q: '', lang: '', apac: false, fy: false, wgm: false, unsw: false, hs: false, hideDev: false, chal: false },
    store.get('lbFilters', {}));
  const sort = Object.assign({ key: 'rank', dir: 'asc' }, store.get('lbSort', {}));
  const me = myTeam();
  const langs = [...new Set(S.teams.map((t) => t.language).filter(Boolean))].sort();
  const onCount = S.teams.filter((t) => t.accepting && t.hasBot).length;

  main.innerHTML = `
    <h1>Leaderboard</h1>
    <p class="lede">UNSW Battlecode ladder with live Elo trends, ranked-switch status and simulated tournament odds.
    By default only teams with an active bot and the <b>ranked switch on</b> are shown: the teams you can actually request ranked battles against.</p>
    <div class="controls" role="group" aria-label="Filters">
      <div class="seg" role="group" aria-label="Which teams">
        <button data-scope="on" title="Active bot and ranked switch on (${onCount} teams)">Ranked on</button>
        <button data-scope="rated" title="Teams that have played ranked battles">Has rating</button>
        <button data-scope="all">All teams</button>
      </div>
      <input type="search" id="lb-q" placeholder="Search team, member, university…" value="${esc(f.q)}" style="min-width:220px">
      <select id="lb-lang" aria-label="Language"><option value="">Any language</option>${langs.map((l) => `<option ${l === f.lang ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <label class="chip"><input type="checkbox" data-f="apac" ${f.apac ? 'checked' : ''}>APAC eligible</label>
      <label class="chip"><input type="checkbox" data-f="fy" ${f.fy ? 'checked' : ''}>1st year</label>
      <label class="chip"><input type="checkbox" data-f="wgm" ${f.wgm ? 'checked' : ''}>WGM</label>
      <label class="chip"><input type="checkbox" data-f="unsw" ${f.unsw ? 'checked' : ''}>UNSW</label>
      <label class="chip"><input type="checkbox" data-f="hs" ${f.hs ? 'checked' : ''}>High school</label>
      <label class="chip"><input type="checkbox" data-f="hideDev" ${f.hideDev ? 'checked' : ''}>Hide DEV</label>
      <label class="chip" title="${me ? `Teams ${esc(me.name)} can request a ranked battle against` : 'Pick your team at the top first'}"><input type="checkbox" data-f="chal" ${f.chal ? 'checked' : ''} ${me ? '' : 'disabled'}>I can challenge</label>
    </div>
    <p class="muted small" id="lb-count"></p>
    <div class="table-wrap"><table id="lb">
      <thead><tr>
        <th data-sort="rank" data-dir="asc" class="num">#</th>
        <th data-sort="name" data-dir="asc">Team</th>
        <th data-sort="elo" class="num">Elo</th>
        <th data-sort="d24" class="num" title="Rating change over the last 24 hours">24h</th>
        <th class="hide-sm" title="Rating over the season">Trend</th>
        <th data-sort="winpct" class="num hide-sm" title="All games, ranked and unranked">Games W–L</th>
        <th data-sort="act" class="num hide-sm" title="Battles finished in the last 24 hours">24h battles</th>
        <th data-sort="acc" title="Ranked-request switch (8h cooldown)">Ranked</th>
        <th data-sort="sprint" class="num" title="Simulated chance to win the Sprint (1 Oct)">Sprint win</th>
        <th data-sort="qual" class="num" title="Simulated chance to reach the Grand Final via the Qualifiers (APAC teams)">Qualify</th>
        ${me ? `<th data-sort="vs" class="num" title="Your chance of winning a single game against them (pure Elo)">You win a game</th>` : ''}
      </tr></thead>
      <tbody></tbody>
    </table></div>`;

  const save = () => store.set('lbFilters', f);
  $$('.seg [data-scope]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.scope === f.scope));
    b.onclick = () => { f.scope = b.dataset.scope; save(); $$('.seg [data-scope]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); render(); };
  });
  $('#lb-q').oninput = (e) => { f.q = e.target.value; save(); render(); };
  $('#lb-lang').onchange = (e) => { f.lang = e.target.value; save(); render(); };
  $$('[data-f]').forEach((c) => { c.onchange = () => { f[c.dataset.f] = c.checked; save(); render(); }; });

  const odds = () => S.defaultOdds;
  const cols = [
    { key: 'rank', get: (t) => t.rank },
    { key: 'name', get: (t) => t.name.toLowerCase() },
    { key: 'elo', get: (t) => t.elo },
    { key: 'd24', get: (t) => t.d24 },
    { key: 'winpct', get: (t) => (t.record ? winPct(t.record[0], t.record[2]) : null) },
    { key: 'act', get: (t) => t.series24 },
    { key: 'acc', get: (t) => (t.hasBot ? (t.accepting ? 1 : 0) : -1) },
    { key: 'sprint', get: (t) => oddsFor(odds(), t.id)?.sprintWin ?? null },
    { key: 'qual', get: (t) => (t.eligible ? oddsFor(odds(), t.id)?.qualify ?? null : null) },
    { key: 'vs', get: (t) => (me && t.id !== me.id ? expected(me.elo, t.elo) : null) },
  ];
  let rows = [];
  const table = $('#lb');
  const tbody = table.tBodies[0];
  function renderBody() {
    const o = odds();
    const qMax = Math.max(1e-9, ...rows.map((t) => oddsFor(o, t.id)?.qualify || 0));
    tbody.innerHTML = rows.length ? rows.map((t) => {
      const od = oddsFor(o, t.id);
      const rec = t.record;
      const wp = rec ? winPct(rec[0], rec[2]) : null;
      return `<tr class="clickable${me && t.id === me.id ? ' me' : ''}" data-id="${t.id}">
        <td class="num">${t.ranked ? t.rank : '<span class="muted">—</span>'}</td>
        <td class="team">${teamLink(t.id, t.name)}${teamTags(t, { mine: me })}<div class="muted small">${esc(t.university || '')}</div></td>
        <td class="num"><b>${t.elo}</b><div>${tierChip(t.elo)}</div></td>
        <td class="num">${signed(t.d24)}</td>
        <td class="hide-sm">${sparkline(t.spark)}</td>
        <td class="num hide-sm">${rec ? `${rec[0]}–${rec[2]}<div class="muted small">${pct(wp, 0)}</div>` : '<span class="muted">—</span>'}</td>
        <td class="num hide-sm">${t.series24 || '<span class="muted">0</span>'}<div class="muted small">${t.lastBattle ? ago(t.lastBattle) : ''}</div></td>
        <td class="nowrap">${switchCell(t)}</td>
        <td class="num pct">${o ? (od?.inSprint ? pct(od.sprintWin) : '<span class="muted">—</span>') : '<span class="muted">…</span>'}</td>
        <td class="num pct bar-cell">${o ? (od?.inQual ? `<div class="b" style="width:${((od.qualify / qMax) * 100).toFixed(1)}%"></div><span>${pct(od.qualify)}</span>` : '<span class="muted" title="Not in the Qualifiers field">—</span>') : '<span class="muted">…</span>'}</td>
        ${me ? `<td class="num">${t.id === me.id ? '<span class="muted">you</span>' : pct(expected(me.elo, t.elo), 0)}</td>` : ''}
      </tr>`;
    }).join('') : `<tr><td colspan="11" class="empty muted">No teams match these filters.</td></tr>`;
  }
  tbody.onclick = (e) => {
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) location.hash = `#/team/${tr.dataset.id}`;
  };
  sort.onChange = () => store.set('lbSort', { key: sort.key, dir: sort.dir });

  function render() {
    const q = f.q.trim().toLowerCase();
    rows = S.teams.filter((t) => {
      if (f.scope === 'on' && !(t.accepting && t.hasBot)) return false;
      if (f.scope === 'rated' && !t.ranked) return false;
      if (f.lang && t.language !== f.lang) return false;
      if (f.apac && !t.eligible) return false;
      if (f.fy && !t.firstYear) return false;
      if (f.wgm && !t.wgm) return false;
      if (f.unsw && !t.unsw) return false;
      if (f.hs && !t.highSchool) return false;
      if (f.hideDev && t.dev) return false;
      if (f.chal && !(me && canChallenge(me, t))) return false;
      if (q && !(`${t.name} ${t.university} ${t.members.join(' ')} ${t.countries.join(' ')}`.toLowerCase().includes(q))) return false;
      return true;
    });
    $('#lb-count').textContent = `${rows.length} team${rows.length === 1 ? '' : 's'} shown · ${onCount} of ${S.teams.length} have an active bot with the ranked switch on.`;
    sortable(table, rows, cols, sort, renderBody);
  }
  render();
  if (!S.defaultOdds) defaultOdds().then(() => { if (main.contains(table)) render(); });
}

// ---- team -----------------------------------------------------------------
async function viewTeam(id) {
  const t = S.byId.get(id);
  if (!t) { main.innerHTML = `<p class="empty">Unknown team.</p>`; return; }
  main.innerHTML = `<a class="back" href="#/">← Leaderboard</a><h1>${esc(t.name)}</h1><div class="progress"><div></div></div>`;
  const [d] = await Promise.all([teamDetail(id), S.defaultOdds || defaultOdds()]);
  if (location.hash.split('?')[0] !== `#/team/${id}`) return;
  const me = myTeam();
  const od = oddsFor(S.defaultOdds, id);
  const rec = t.record;
  const members = (d?.members || t.members.map((u) => ({ username: u }))).map((m) => `${esc(m.username)}${m.institution ? ` <span class="muted">(${esc(m.institution)})</span>` : ''}`).join(', ');

  main.innerHTML = `
    <a class="back" href="#/">← Leaderboard</a>
    <div class="team-head">
      <div>
        <h1>${esc(t.name)} ${teamTags(t, { mine: me })}</h1>
        <div class="members">${members || '<span class="muted">No members listed</span>'}</div>
        <div class="muted small">${[t.university, t.countries.join(', '), t.language, d?.skin && `skin: ${d.skin}`].filter(Boolean).map(esc).join(' · ')}</div>
        ${d?.description ? `<p class="ink2">${esc(d.description)}</p>` : ''}
      </div>
      <div style="margin-left:auto;text-align:right">
        <div class="muted small">${t.ranked ? `Rank #${t.rank}` : 'Unrated'}</div>
        <div class="big-elo">${t.elo}</div>
        <div>${tierChip(t.elo)}</div>
      </div>
    </div>
    <div class="tiles">
      <div class="tile"><div class="k">Last 24h</div><div class="v">${signed(t.d24)}</div><div class="s">7 days: ${signed(t.d7)}</div></div>
      <div class="tile"><div class="k">Peak Elo</div><div class="v">${t.peak ?? '—'}</div><div class="s">Best rank: ${t.bestRank ? `#${t.bestRank}` : '—'}</div></div>
      <div class="tile"><div class="k">Games W–D–L</div><div class="v">${rec ? pct(winPct(rec[0], rec[2]), 0) : '—'}</div><div class="s">${rec ? `${rec[0]}–${rec[1]}–${rec[2]}` : ''}</div></div>
      <div class="tile"><div class="k">Ranked switch</div><div class="v">${switchCell(t)}</div><div class="s">${t.acceptingChangedAt ? `changed ${ago(t.acceptingChangedAt)}` : ''}</div></div>
      <div class="tile"><div class="k">Current submission</div><div class="v">${t.submission ? `#${t.submission}` : '—'}</div><div class="s">${t.submissionSince ? `seen since ${ago(t.submissionSince)}` : 'not sampled yet'}</div></div>
      <div class="tile"><div class="k">Battles, last 24h</div><div class="v">${t.series24}</div><div class="s">${t.ranked24} ranked · last ${ago(t.lastBattle)}</div></div>
    </div>
    ${od ? `<div class="grid2">
      <div class="card"><h3>Sprint · 1 Oct</h3>${od.inSprint ? hbars([
        { label: 'Quarterfinal', value: od.sprintQF, cls: 's1' }, { label: 'Semifinal', value: od.sprintSF, cls: 's1' },
        { label: 'Final', value: od.sprintFinal, cls: 's1' }, { label: 'Win', value: od.sprintWin, cls: 's1' }], { max: 1 }) : '<p class="muted">Not in the Sprint field.</p>'}</div>
      <div class="card"><h3>Championship · Qualifiers → Grand Final</h3>${od.inQual ? hbars([
        { label: 'Qualify', value: od.qualify, cls: 's3' }, { label: 'Reach GF final', value: od.gfFinal, cls: 's3' },
        { label: 'Win Grand Final', value: od.gfWin, cls: 's3' }], { max: 1 }) : `<p class="muted">${t.eligible ? 'Not in the current Qualifiers field.' : 'Not eligible for the Qualifiers (APAC teams only).'}</p>`}</div>
    </div><p class="muted small">Pure-Elo simulation of the site's tentative brackets using current ratings. <a href="#/odds">Adjust the model →</a></p>` : ''}
    ${me && me.id !== t.id ? matchupCard(me, t) : ''}
    <h2>Elo over time</h2>
    <div class="card">
      <div class="controls" style="margin-top:0">
        <label>Compare with <input id="cmp" list="teamlist" placeholder="Another team…" autocomplete="off"></label>
      </div>
      <div class="legend" id="elo-legend"></div>
      <div id="elo-chart"></div>
    </div>
    <h2>Rank over time</h2>
    <div class="card"><div id="rank-chart"></div></div>
    <h2>Submissions</h2>
    <p class="muted small">Bots aren't public, but every match records which submission each side used. Active bots come from ranked battles, which always use each team's active submission. The record counts battles seen with that bot, plus ranked battles between two sightings of it.</p>
    <div id="subs"></div>
    <div id="tested"></div>
    <h2>Head to head</h2>
    <div id="h2h"></div>
    <div class="grid2">
      <div><h2>Map Elo</h2><div id="maps"><p class="muted">Loading…</p></div></div>
      <div><h2>Recent battles</h2><div id="recent"></div></div>
    </div>`;

  // Elo chart (+ optional comparison)
  const hist = d?.history?.length ? d.history : t.spark;
  const bands = TIERS.filter((x) => x.min > 0).map((x) => ({ from: x.min, label: x.name }));
  const drawElo = (other) => {
    const series = [{ name: t.name, points: hist, cls: 's1' }];
    if (other) series.push({ name: other.name, points: other.history?.length ? other.history : other.spark, cls: 's2' });
    $('#elo-legend').innerHTML = series.length > 1 ? series.map((s) => `<span><i class="key ${s.cls}"></i>${esc(s.name)}</span>`).join('') : '';
    lineChart($('#elo-chart'), series, { height: 260, label: `Elo history for ${t.name}`, bands });
  };
  drawElo(null);
  $('#cmp').onchange = async (e) => {
    const o = parseTeam(e.target.value);
    if (!o || o.id === id) { drawElo(null); return; }
    const od2 = await teamDetail(o.id);
    drawElo({ ...o, history: od2?.history });
  };
  if (d?.ranks?.length) lineChart($('#rank-chart'), [{ name: 'Rank', points: d.ranks, cls: 's1' }], { height: 180, invert: true, label: 'Rank history', fmt: (v) => (v < 1 ? '' : `#${Math.round(v)}`) });
  else $('#rank-chart').innerHTML = '<p class="muted empty">No rank history yet.</p>';

  // Submissions
  const subs = [...(d?.submissions || [])].reverse();
  $('#subs').innerHTML = subs.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Submission</th><th>First seen</th><th>Last seen</th><th class="num">Battles W–D–L</th><th class="num">Games W–L</th><th class="num">Ranked Elo Δ</th></tr></thead>
    <tbody>${subs.map((s, i) => `<tr${i === 0 ? ' class="me"' : ''}>
      <td><b>#${s.sub}</b>${i === 0 ? ' <span class="tag on">current</span>' : ''}</td>
      <td class="nowrap">${shortDate(s.first)}</td><td class="nowrap">${shortDate(s.last)}</td>
      <td class="num">${s.series.join('–')}</td>
      <td class="num">${s.games[0]}–${s.games[2]} <span class="muted small">${pct(winPct(s.games[0], s.games[2]), 0)}</span></td>
      <td class="num">${s.ranked ? signed(s.eloDelta) : '<span class="muted">—</span>'} <span class="muted small">${s.ranked ? `(${s.ranked})` : ''}</span></td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="muted">No ranked matches sampled for this team yet.</p>';
  const tested = d?.testedSubmissions || [];
  $('#tested').innerHTML = tested.length ? `<details style="margin-top:10px"><summary>${tested.length} other submission${tested.length === 1 ? '' : 's'} seen only in unranked battles (tests, or opponents picking an older version)</summary>
    <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Submission</th><th>First seen</th><th>Last seen</th><th class="num">Battles seen</th><th class="num">Games W–L</th></tr></thead><tbody>
    ${tested.map((x) => `<tr><td>#${x.sub}</td><td class="nowrap">${shortDate(x.first)}</td><td class="nowrap">${shortDate(x.last)}</td><td class="num">${x.battles}</td><td class="num">${x.games[0]}–${x.games[2]}</td></tr>`).join('')}
    </tbody></table></div></details>` : '';

  // Head to head
  const h2h = (d?.h2h || []).map((h) => ({ ...h, name: S.byId.get(h.opp)?.name ?? `Team ${h.opp}`, elo: S.byId.get(h.opp)?.elo ?? null }));
  if (h2h.length) {
    $('#h2h').innerHTML = `<div class="table-wrap"><table id="h2h-t"><thead><tr>
      <th data-sort="name" data-dir="asc">Opponent</th><th data-sort="elo" class="num">Their Elo</th>
      <th data-sort="n" class="num">Battles W–D–L</th><th data-sort="gw" class="num">Game win %</th>
      <th data-sort="exp" class="num" title="Your expected game share at today's ratings">Expected</th>
      <th data-sort="delta" class="num hide-sm">Ranked Elo Δ</th><th data-sort="last" class="num">Last met</th>
    </tr></thead><tbody></tbody></table></div><p class="muted small" id="h2h-more"></p>`;
    const tb = $('#h2h-t').tBodies[0];
    let showAll = false;
    const state = { key: 'n', dir: 'desc' };
    const body = () => {
      const list = showAll ? h2h : h2h.slice(0, 25);
      tb.innerHTML = list.map((h) => `<tr>
        <td class="team">${teamLink(h.opp, h.name)}</td><td class="num">${h.elo ?? '—'}</td>
        <td class="num">${h.series.join('–')}</td>
        <td class="num">${pct(winPct(h.games[0], h.games[2]), 0)} <span class="muted small">${h.games[0]}–${h.games[2]}</span></td>
        <td class="num">${h.elo != null ? pct(expected(t.elo, h.elo), 0) : '—'}</td>
        <td class="num hide-sm">${h.ranked ? signed(h.eloDelta) : '<span class="muted">—</span>'}</td>
        <td class="num">${ago(h.last)}</td></tr>`).join('');
      $('#h2h-more').innerHTML = h2h.length > 25 ? `${showAll ? h2h.length : 25} of ${h2h.length} opponents · <a href="#" id="h2h-all">${showAll ? 'show fewer' : 'show all'}</a>` : '';
      const a = $('#h2h-all');
      if (a) a.onclick = (e) => { e.preventDefault(); showAll = !showAll; body(); };
    };
    sortable($('#h2h-t'), h2h, [
      { key: 'name', get: (h) => h.name.toLowerCase() }, { key: 'elo', get: (h) => h.elo },
      { key: 'n', get: (h) => h.series[0] + h.series[1] + h.series[2] }, { key: 'gw', get: (h) => winPct(h.games[0], h.games[2]) },
      { key: 'exp', get: (h) => (h.elo != null ? expected(t.elo, h.elo) : null) }, { key: 'delta', get: (h) => (h.ranked ? h.eloDelta : null) },
      { key: 'last', get: (h) => h.last },
    ], state, body);
  } else $('#h2h').innerHTML = '<p class="muted">No battles recorded yet.</p>';

  // Maps
  teamMaps(t);

  // Recent battles
  const bl = (d?.battles || []).slice(0, 40);
  $('#recent').innerHTML = bl.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Opponent</th><th class="num">Score</th><th class="num">Elo Δ</th><th></th></tr></thead><tbody>
    ${bl.map((b) => `<tr><td class="nowrap small">${ago(b.at)}</td>
      <td class="team">${teamLink(b.opp)} <span class="muted small">${b.oppElo ?? ''}</span>${b.ranked ? '' : ' <span class="tag">unranked</span>'}</td>
      <td class="num"><b class="${b.result === 'W' ? 'up' : b.result === 'L' ? 'down' : ''}">${b.result}</b> ${b.w}–${b.l}${b.d ? `–${b.d}` : ''}</td>
      <td class="num">${b.ranked ? signed(b.delta) : ''}</td>
      <td class="small">${replayLink(b.replay)}</td></tr>`).join('')}
    </tbody></table></div>${d.battleCount > bl.length ? `<p class="muted small">Latest ${bl.length} of ${d.battleCount} battles tracked.</p>` : ''}` : '<p class="muted">No battles recorded yet.</p>';
}

function matchupCard(a, b) {
  const p = expected(a.elo, b.elo);
  return `<div class="card" style="margin-top:14px"><h3>${esc(a.name)} (you) vs ${esc(b.name)}</h3>
    <div class="hero">
      <div><div class="muted small">You win a game</div><div class="big-elo" style="font-size:26px">${pct(p, 0)}</div></div>
      <div><div class="muted small">Ranked battle (5 games)</div><div style="font-size:20px;font-weight:650">${(p * 5).toFixed(1)} – ${((1 - p) * 5).toFixed(1)}</div></div>
      <div><div class="muted small">Best of 7 knockout</div><div style="font-size:20px;font-weight:650">${pct(firstTo(p, 4), 0)}</div></div>
      <div><div class="muted small">Ranked challenge allowed?</div><div style="font-size:15px;margin-top:4px">${canChallenge(a, b) ? '<span class="ok">Yes</span>' : '<span class="no">No</span>'}</div></div>
    </div>
    <a href="#/matchup?a=${a.id}&b=${b.id}">Full matchup breakdown →</a></div>`;
}

// ---- matchup --------------------------------------------------------------
function viewMatchup(params) {
  const me = myTeam();
  let A = S.byId.get(Number(params.get('a'))) || me || S.teams.find((t) => t.rank === 1);
  let B = S.byId.get(Number(params.get('b'))) || S.teams.find((t) => t.rank === (A?.rank === 1 ? 2 : 1));
  const st = { eloA: A?.elo ?? 1500, eloB: B?.elo ?? 1500, kA: 24, kB: 24, D: 400 };
  const kOpts = (sel) => [[24, 'Settled bot (K 24)'], [60, '5 ranked battles in (K 60)'], [96, 'Brand-new bot (K 96)']]
    .map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${l}</option>`).join('');

  main.innerHTML = `
    <h1>Matchup</h1>
    <p class="lede">What Elo implies for any two teams (or any two ratings): single-game odds, the spread of ranked-battle results, how much rating each result moves, and knockout-series odds for the tournaments.</p>
    <div class="card">
      <div class="vs">
        <div class="side"><label class="muted small" for="ma">Team A</label><input id="ma" list="teamlist" value="${esc(teamValue(A))}" autocomplete="off">
          <div class="row"><label>Elo <input id="ea" type="number" step="1" value="${st.eloA}"></label><select id="ka" aria-label="Team A K factor">${kOpts(24)}</select></div></div>
        <div class="mid">vs</div>
        <div class="side"><label class="muted small" for="mb">Team B</label><input id="mb" list="teamlist" value="${esc(teamValue(B))}" autocomplete="off">
          <div class="row"><label>Elo <input id="eb" type="number" step="1" value="${st.eloB}"></label><select id="kb" aria-label="Team B K factor">${kOpts(24)}</select></div></div>
      </div>
      <div class="controls" style="margin-bottom:0">
        <span class="muted small">Model</span>
        <div class="seg" id="md"><button data-d="400">Pure Elo (400)</button><button data-d="fit">Fitted to results (${fittedD()})</button></div>
        <button class="btn" id="swap" type="button">Swap sides</button>
      </div>
    </div>
    <div id="mres"></div>`;

  const upd = () => {
    const p = expected(st.eloA, st.eloB, st.D);
    const eSite = expected(st.eloA, st.eloB, 400); // rating changes always use the site's 400
    const dist = fixedSeries(p, 5);
    const nameA = A ? A.name : 'Team A', nameB = B ? B.name : 'Team B';
    const pRanked = dist[3] + dist[4] + dist[5];
    const expDelta = dist.reduce((s, q, k) => s + q * eloDelta(k / 5, eSite, st.kA), 0);
    const maxP = Math.max(...dist);
    const allowAB = A && B ? canChallenge(A, B) : null, allowBA = A && B ? canChallenge(B, A) : null;
    $('#mres').innerHTML = `
      <div class="hero">
        <div class="tile"><div class="k">${esc(nameA)} wins a game</div><div class="v">${pct(p, 1)}</div><div class="s">Elo gap ${signed(Math.round(st.eloA - st.eloB))}</div></div>
        <div class="tile"><div class="k">Expected ranked score</div><div class="v">${(p * 5).toFixed(2)} – ${((1 - p) * 5).toFixed(2)}</div><div class="s">of 5 games</div></div>
        <div class="tile"><div class="k">${esc(nameA)} takes the battle (3+ of 5)</div><div class="v">${pct(pRanked, 1)}</div><div class="s">Ranked, all five games played</div></div>
        <div class="tile"><div class="k">Best of 7 (Sprint, Qualifiers)</div><div class="v">${pct(firstTo(p, 4), 1)}</div><div class="s">first to 4 · ${esc(nameA)}</div></div>
        <div class="tile"><div class="k">Best of 5 (Grand Final)</div><div class="v">${pct(firstTo(p, 3), 1)}</div><div class="s">first to 3 · ${esc(nameA)}</div></div>
      </div>
      <div class="card">
        <h3>Ranked battle outcomes</h3>
        <div class="legend"><span><i class="key s1"></i>Probability of each score for ${esc(nameA)}</span></div>
        <div class="dist">${[5, 4, 3, 2, 1, 0].map((k) => {
          const dA = eloDelta(k / 5, eSite, st.kA), dB = eloDelta((5 - k) / 5, 1 - eSite, st.kB);
          return `<div class="col s1"><div class="barwrap"><div style="height:${Math.max(2, (dist[k] / maxP) * 100)}%"></div></div>
            <div class="lab">${k}–${5 - k}</div><div class="p">${pct(dist[k], 1)}</div>
            <div class="d">A ${signed(dA)}</div><div class="d">B ${signed(dB)}</div></div>`;
        }).join('')}</div>
        <p class="muted small" style="margin-top:12px">Rating change = K × (games won ÷ 5 − expected share), rounded, where expected share is ${pct(eSite, 1)} for ${esc(nameA)} at these ratings.
        Expected change for ${esc(nameA)} this battle: ${expDelta >= 0 ? '+' : '−'}${Math.abs(expDelta).toFixed(2)}${st.D !== 400 ? ' (under the fitted model, a nonzero expectation means the ladder is mis-pricing this gap)' : ''}.</p>
      </div>
      ${A && B ? `<div class="card"><h3>Can they request a ranked battle?</h3>
        <p>${esc(A.name)} → ${esc(B.name)}: ${allowAB ? '<span class="ok">Allowed</span>' : '<span class="no">Not allowed</span>'} · ${esc(B.name)} → ${esc(A.name)}: ${allowBA ? '<span class="ok">Allowed</span>' : '<span class="no">Not allowed</span>'}</p>
        <p class="muted small">Both teams need an active bot and the ranked switch on, and the target may be at most 50 below the challenger. Switches: ${esc(A.name)} ${switchCell(A)} · ${esc(B.name)} ${switchCell(B)}</p></div>
        <div class="card" id="mmaps"><h3>By map</h3><p class="muted">Loading…</p></div>
        <div class="card" id="mh2h"><h3>History</h3><p class="muted">Loading…</p></div>` : ''}`;
    if (A && B) matchupMaps(A, B, st.eloA, st.eloB, st.D);
    if (A && B) teamDetail(A.id).then((d) => {
      const box = $('#mh2h');
      if (!box) return;
      const h = d?.h2h?.find((x) => x.opp === B.id);
      const meets = (d?.battles || []).filter((b) => b.opp === B.id).slice(0, 12);
      box.innerHTML = `<h3>History</h3>${h ? `<p><b>${esc(A.name)}</b> ${h.series[0]}–${h.series[1]}–${h.series[2]} in battles, ${h.games[0]}–${h.games[2]} in games
        (${pct(winPct(h.games[0], h.games[2]), 0)} vs ${pct(expected(A.elo, B.elo), 0)} expected today).</p>
        ${meets.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th class="num">Score (A)</th><th>Type</th><th class="num">Elo at the time</th><th></th></tr></thead><tbody>
        ${meets.map((b) => `<tr><td>${shortDate(b.at)}</td><td class="num"><b class="${b.result === 'W' ? 'up' : b.result === 'L' ? 'down' : ''}">${b.w}–${b.l}</b></td><td>${b.ranked ? 'ranked' : 'unranked'}${b.challenge ? '' : ' · autoscrim'}</td><td class="num">${b.myElo ?? '—'} v ${b.oppElo ?? '—'}</td><td>${replayLink(b.replay)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}` : '<p class="muted">They haven\'t met in any battle we\'ve recorded.</p>'}`;
    });
  };

  const setSide = (side, t) => {
    if (side === 'a') { A = t; if (t) { st.eloA = t.elo; $('#ea').value = t.elo; } }
    else { B = t; if (t) { st.eloB = t.elo; $('#eb').value = t.elo; } }
    history.replaceState(null, '', `#/matchup?a=${A?.id ?? ''}&b=${B?.id ?? ''}`);
    upd();
  };
  $('#ma').onchange = (e) => setSide('a', parseTeam(e.target.value));
  $('#mb').onchange = (e) => setSide('b', parseTeam(e.target.value));
  $('#ea').oninput = (e) => { st.eloA = Number(e.target.value) || 0; upd(); };
  $('#eb').oninput = (e) => { st.eloB = Number(e.target.value) || 0; upd(); };
  $('#ka').onchange = (e) => { st.kA = Number(e.target.value); upd(); };
  $('#kb').onchange = (e) => { st.kB = Number(e.target.value); upd(); };
  const segBtns = $$('#md button');
  const setD = (v) => { st.D = v === 'fit' ? fittedD() : 400; segBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.d === v))); upd(); };
  segBtns.forEach((b) => { b.onclick = () => setD(b.dataset.d); });
  $('#swap').onclick = () => {
    [A, B] = [B, A]; [st.eloA, st.eloB] = [st.eloB, st.eloA]; [st.kA, st.kB] = [st.kB, st.kA];
    $('#ma').value = teamValue(A); $('#mb').value = teamValue(B); $('#ea').value = st.eloA; $('#eb').value = st.eloB;
    $('#ka').value = st.kA; $('#kb').value = st.kB;
    history.replaceState(null, '', `#/matchup?a=${A?.id ?? ''}&b=${B?.id ?? ''}`);
    upd();
  };
  setD('400');
}

// ---- odds -------------------------------------------------------------------
function viewOdds(params) {
  const o = Object.assign({ tab: 'champ', sims: 10000, model: '400', sigma: 0, reseed: false, overrides: {} }, store.get('odds', {}));
  if (params.get('tab')) o.tab = params.get('tab');
  const gf = S.tour?.grandFinal;
  const sprintT = S.tour?.tournaments?.find((t) => t.id === 'sprint');
  const qualT = S.tour?.tournaments?.find((t) => t.id === 'qualifier');
  main.innerHTML = `
    <h1>Tournament odds</h1>
    <p class="lede">Monte Carlo over the site's tentative brackets (seeded from the current ladder), where each game is won with the Elo-implied probability.
    The championship path is the <b>Qualifiers</b> (${qualT ? `${qualT.size} APAC teams, best of ${qualT.bestOf}` : 'APAC teams'}; 8 quarterfinalists plus 2 from the Round-of-16 losers' bracket advance)
    into the <b>Grand Final</b> (${gf ? `${gf.teams} teams, best of ${gf.bestOf}, ${new Date(gf.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '10 teams'}).</p>
    <div class="card">
      <div class="controls" style="margin-top:0">
        <label>Simulations <select id="o-sims">${[2000, 10000, 50000].map((n) => `<option value="${n}" ${n === o.sims ? 'selected' : ''}>${n.toLocaleString()}</option>`).join('')}</select></label>
        <span class="muted small">Win probability</span>
        <div class="seg" id="o-model"><button data-m="400">Pure Elo</button><button data-m="fit" title="Divisor fitted to recent ranked results">Fitted (${fittedD()})</button></div>
        <label title="Each simulated season draws every team's true strength from Elo ± this much, to account for ratings being noisy and bots changing before the event">Rating uncertainty ±<input id="o-sigma" type="range" min="0" max="200" step="10" value="${o.sigma}"><span id="o-sigma-v" class="num">${o.sigma}</span></label>
        <label class="chip" title="Re-seed the brackets from ratings including your what-ifs, instead of the site's current bracket"><input type="checkbox" id="o-reseed" ${o.reseed ? 'checked' : ''}>Re-seed brackets</label>
      </div>
      <details ${Object.keys(o.overrides).length ? 'open' : ''}><summary>What if… (override a team's Elo)</summary>
        <div class="controls"><input id="wi-team" list="teamlist" placeholder="Team…" autocomplete="off"><input id="wi-elo" type="number" placeholder="Elo" style="width:90px"><button class="btn" id="wi-add" type="button">Apply</button></div>
        <div class="whatifs" id="wi-list"></div>
      </details>
    </div>
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="champ">Championship</button>
      <button role="tab" data-tab="sprint">Sprint · ${sprintT ? new Date(sprintT.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''}</button>
    </div>
    <div id="o-status" class="muted small"></div>
    <div id="o-out"></div>`;

  const save = () => store.set('odds', o);
  let timer;
  const rerun = () => { clearTimeout(timer); timer = setTimeout(run, 120); };
  $('#o-sims').onchange = (e) => { o.sims = Number(e.target.value); save(); rerun(); };
  $$('#o-model button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.m === o.model));
    b.onclick = () => { o.model = b.dataset.m; save(); $$('#o-model button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); rerun(); };
  });
  $('#o-sigma').oninput = (e) => { o.sigma = Number(e.target.value); $('#o-sigma-v').textContent = o.sigma; save(); rerun(); };
  $('#o-reseed').onchange = (e) => { o.reseed = e.target.checked; save(); rerun(); };
  const drawWI = () => {
    $('#wi-list').innerHTML = Object.entries(o.overrides).map(([id, e]) => `<span class="whatif">${esc(S.byId.get(Number(id))?.name ?? id)}: ${S.byId.get(Number(id))?.elo ?? '?'} → <b>${e}</b><button data-rm="${id}" aria-label="Remove">✕</button></span>`).join('') || '<span class="muted small">None. Try giving your own team +100.</span>';
    $$('[data-rm]', $('#wi-list')).forEach((b) => { b.onclick = () => { delete o.overrides[b.dataset.rm]; save(); drawWI(); rerun(); }; });
  };
  drawWI();
  $('#wi-add').onclick = () => {
    const t = parseTeam($('#wi-team').value), e = Number($('#wi-elo').value);
    if (!t || !e) return;
    o.overrides[t.id] = e; save(); drawWI(); rerun();
  };
  $('#wi-team').onchange = () => { const t = parseTeam($('#wi-team').value); if (t && !$('#wi-elo').value) $('#wi-elo').value = t.elo + 100; };
  $$('.tabs button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.tab === o.tab));
    b.onclick = () => { o.tab = b.dataset.tab; save(); $$('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b))); if (last) draw(last); };
  });

  let last = null, runId = 0;
  async function run() {
    const my = ++runId;
    $('#o-status').innerHTML = '<div class="progress"><div></div></div>Simulating…';
    const D = o.model === 'fit' ? fittedD() : 400;
    const overrides = Object.fromEntries(Object.entries(o.overrides).map(([k, v]) => [Number(k), v]));
    try {
      const res = await simulateOdds({ sims: o.sims, D, sigma: o.sigma, overrides, reseed: o.reseed });
      if (my !== runId || !main.contains($('#o-out'))) return;
      last = res;
      $('#o-status').textContent = `${res.sims.toLocaleString()} simulated seasons in ${(res.ms / 1000).toFixed(1)}s · divisor ${D} · uncertainty ±${o.sigma}.`;
      draw(res);
    } catch (err) {
      $('#o-status').textContent = `Simulation failed: ${err.message}`;
    }
  }

  function draw(res) {
    const me = myTeamId();
    const elo = res.cfg.elo;
    if (o.tab === 'sprint') {
      if (!res.cfg.sprint) { $('#o-out').innerHTML = '<p class="muted">No Sprint bracket published.</p>'; return; }
      const R = res.sprintRounds;
      const rows = Object.entries(res.sprint).map(([id, c]) => ({ id: Number(id), c, win: c[R] / res.sims }))
        .sort((a, b) => b.win - a.win || elo[b.id] - elo[a.id]);
      const labels = [['R16', R - 4], ['QF', R - 3], ['SF', R - 2], ['Final', R - 1], ['Win', R]];
      const seedOf = res.cfg.sprint.seedOf;
      $('#o-out').innerHTML = `
        <div class="card"><h3>Most likely Sprint winners</h3>${hbars(rows.slice(0, 12).map((r) => ({ labelHtml: teamLink(r.id), value: r.win, cls: 's1' })))}</div>
        <p class="muted small" style="margin-top:12px">${sprintT ? `${esc(sprintT.prize)} · every map unseen · best of ${sprintT.bestOf}. ` : ''}Columns are the chance of reaching each round.</p>
        ${oddsTable(rows.filter((r) => r.c[R - 4] > 0 || r.id === me).slice(0, 200), [
          { h: 'Seed', num: true, v: (r) => seedOf[r.id] ?? '—' },
          ...labels.map(([h, i]) => ({ h, num: true, v: (r) => pct(r.c[i] / res.sims), bar: i === R ? (r) => r.c[i] / res.sims : null })),
        ], elo, me, rows.length)}`;
    } else {
      if (!res.cfg.qualifier) { $('#o-out').innerHTML = '<p class="muted">No Qualifiers bracket published.</p>'; return; }
      const rows = Object.entries(res.qual).map(([id, c]) => ({ id: Number(id), c, win: c[4] / res.sims, q: c[2] / res.sims }))
        .sort((a, b) => b.win - a.win || b.q - a.q || elo[b.id] - elo[a.id]);
      const seedOf = res.cfg.qualifier.seedOf;
      $('#o-out').innerHTML = `
        <div class="grid2">
          <div class="card"><h3>Grand Final winner</h3>${hbars(rows.slice(0, 12).map((r) => ({ labelHtml: teamLink(r.id), value: r.win, cls: 's3' })))}</div>
          <div class="card"><h3>Chance to qualify for the Grand Final</h3>${hbars([...rows].sort((a, b) => b.q - a.q).slice(0, 12).map((r) => ({ labelHtml: teamLink(r.id), value: r.q, cls: 's1' })), { max: 1 })}</div>
        </div>
        <p class="note" style="margin-top:12px">The Grand Final format isn't published yet. It's modelled as the 10 qualifiers seeded by rating into a single-elimination bracket (top six seeds get byes), best of ${gf?.bestOf || 5}. Qualifying odds don't depend on this.</p>
        ${oddsTable(rows.filter((r) => r.q > 0 || r.id === me).slice(0, 200), [
          { h: 'Q seed', num: true, v: (r) => seedOf[r.id] ?? '—' },
          { h: 'Via QF', num: true, v: (r) => pct(r.c[0] / res.sims), t: 'Reach the Qualifiers quarterfinals' },
          { h: 'Via losers', num: true, v: (r) => pct(r.c[1] / res.sims), t: 'Lose in the Round of 16, then reach the losers\' bracket final' },
          { h: 'Qualify', num: true, v: (r) => pct(r.q), bar: (r) => r.q },
          { h: 'GF final', num: true, v: (r) => pct(r.c[3] / res.sims) },
          { h: 'Champion', num: true, v: (r) => pct(r.win) },
        ], elo, me, rows.length)}`;
    }
  }
  run();
}

function oddsTable(rows, cols, elo, me, total) {
  return `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Team</th><th class="num">Elo</th>
    ${cols.map((c) => `<th class="num"${c.t ? ` title="${esc(c.t)}"` : ''}>${c.h}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.id === me ? 'me' : ''}"><td class="team">${teamLink(r.id)}</td><td class="num">${elo[r.id]}${elo[r.id] !== S.byId.get(r.id)?.elo ? ' <span class="tag new">what-if</span>' : ''}</td>
      ${cols.map((c) => c.bar ? `<td class="num bar-cell"><div class="b" style="width:${(c.bar(r) * 100).toFixed(1)}%"></div><span>${c.v(r)}</span></td>` : `<td class="num">${c.v(r)}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div><p class="muted small">${rows.length} of ${total} teams with a nonzero chance shown.</p>`;
}

// ---- battles ---------------------------------------------------------------
async function viewBattles() {
  main.innerHTML = '<h1>Recent battles</h1><div class="progress"><div></div></div>';
  if (!S.recent) S.recent = await getJSON('battles-recent.json');
  const f = Object.assign({ ranked: false, upsets: false, q: '' }, store.get('bf', {}));
  main.innerHTML = `
    <h1>Recent battles</h1>
    <p class="lede">The latest finished battles. An upset is a battle won by the side Elo gave under a 35% expected share of games.</p>
    <div class="controls">
      <input type="search" id="bq" placeholder="Filter by team…" value="${esc(f.q)}">
      <label class="chip"><input type="checkbox" id="br" ${f.ranked ? 'checked' : ''}>Ranked only</label>
      <label class="chip"><input type="checkbox" id="bu" ${f.upsets ? 'checked' : ''}>Upsets only</label>
    </div>
    <p class="muted small" id="bcount"></p>
    <div class="table-wrap"><table><thead><tr>
      <th>Finished</th><th>Team A</th><th class="num">Score</th><th>Team B</th><th class="num hide-sm">Elo A–B</th><th class="num" title="Team A's expected share of games">A expected</th><th class="num">Elo Δ (A)</th><th class="hide-sm">Type</th><th></th>
    </tr></thead><tbody id="btb"></tbody></table></div>`;
  const render = () => {
    const q = f.q.trim().toLowerCase();
    const list = S.recent.filter((b) => {
      if (f.ranked && !b.ranked) return false;
      const e = b.aElo != null && b.bElo != null ? expected(b.aElo, b.bElo) : null;
      const upset = e != null && ((b.wa > b.wb && e < 0.35) || (b.wb > b.wa && e > 0.65));
      if (f.upsets && !upset) return false;
      if (q && !`${S.byId.get(b.a)?.name ?? ''} ${S.byId.get(b.b)?.name ?? ''}`.toLowerCase().includes(q)) return false;
      b._e = e; b._up = upset;
      return true;
    }).slice(0, 300);
    $('#bcount').textContent = `${list.length} shown of the latest ${S.recent.length}.`;
    $('#btb').innerHTML = list.map((b) => `<tr>
      <td class="nowrap small">${ago(b.at)}</td>
      <td class="team">${b.wa > b.wb ? '<b>' : ''}${teamLink(b.a)}${b.wa > b.wb ? '</b>' : ''}</td>
      <td class="num"><b>${b.wa}–${b.wb}</b>${b._up ? ' <span class="tag new">upset</span>' : ''}</td>
      <td class="team">${b.wb > b.wa ? '<b>' : ''}${teamLink(b.b)}${b.wb > b.wa ? '</b>' : ''}</td>
      <td class="num hide-sm">${b.aElo ?? '—'}–${b.bElo ?? '—'}</td>
      <td class="num">${b._e != null ? pct(b._e, 0) : '—'}</td>
      <td class="num">${b.ranked ? signed(b.dA) : '<span class="muted">unranked</span>'}</td>
      <td class="small hide-sm">${b.ranked ? (b.challenge ? 'ranked request' : 'autoscrim') : `unranked · ${b.n} game${b.n === 1 ? '' : 's'}`}</td>
      <td class="small">${replayLink(b.replay)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty muted">No battles match.</td></tr>';
  };
  $('#bq').oninput = (e) => { f.q = e.target.value; store.set('bf', f); render(); };
  $('#br').onchange = (e) => { f.ranked = e.target.checked; store.set('bf', f); render(); };
  $('#bu').onchange = (e) => { f.upsets = e.target.checked; store.set('bf', f); render(); };
  render();
}

// ---- stats ---------------------------------------------------------------------
function viewStats() {
  const m = S.meta;
  const rated = S.teams.filter((t) => t.ranked);
  const cal = m.calibration;
  const last24 = m.activity.filter((a) => a.t >= now() - 86400);
  const perHour = last24.length ? last24.reduce((s, a) => s + a.ranked + a.unranked, 0) / last24.length : 0;
  const movers = rated.filter((t) => t.d24 != null && !t.dev);
  const up = [...movers].sort((a, b) => b.d24 - a.d24).slice(0, 10);
  const down = [...movers].sort((a, b) => a.d24 - b.d24).slice(0, 10);
  const active = [...S.teams].sort((a, b) => b.series24 - a.series24).slice(0, 10);
  const langs = {};
  for (const t of rated) { const k = t.language || 'unknown'; (langs[k] ||= []).push(t); }
  const countries = {};
  for (const t of rated) for (const c of t.countries.length ? t.countries : ['—']) (countries[c] ||= []).push(t);

  main.innerHTML = `
    <h1>Stats</h1>
    <div class="tiles">
      <div class="tile"><div class="k">Teams</div><div class="v">${m.counts.teams}</div><div class="s">${m.counts.rankedTeams} rated</div></div>
      <div class="tile"><div class="k">Battles tracked</div><div class="v">${m.counts.battles.toLocaleString()}</div><div class="s">since ${m.battleSpan ? new Date(m.battleSpan[0] * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—'}</div></div>
      <div class="tile"><div class="k">Battles per hour</div><div class="v">${Math.round(perHour)}</div><div class="s">average, last 24h</div></div>
      <div class="tile"><div class="k">Fitted Elo divisor</div><div class="v">${cal.fittedDivisor}</div><div class="s">site uses 400 · ${cal.games.toLocaleString()} ranked games</div></div>
    </div>
    <h2>Is Elo well calibrated?</h2>
    <p class="lede">Each dot is ranked games grouped by rating gap: how often the higher-rated side won the game, against what Elo predicts.
    ${cal.fittedDivisor > 440 ? 'Favourites win less often than the ladder claims, so pure-Elo odds are overconfident.' : cal.fittedDivisor < 360 ? 'Favourites win more often than the ladder claims, so pure-Elo odds are underconfident.' : 'Results track the Elo formula closely.'}
    The last four days of ranked games are used.</p>
    <div class="card"><div class="legend"><span><i class="key s1"></i>Actual</span><span><i class="key ref"></i>Elo (400)</span><span><i class="key s2"></i>Fitted (${cal.fittedDivisor})</span></div><div id="cal"></div></div>
    <h2>Battles per hour</h2>
    <div class="card"><div class="legend"><span><i class="key s1"></i>Ranked</span><span><i class="key s3"></i>Unranked</span></div><div id="act"></div></div>
    <div class="grid2">
      <div><h2>Tiers</h2><div class="card">${hbars(m.tiers.filter((x) => x.count).map((x) => ({ label: x.name, value: x.count, cls: 's1' })), { fmt: (v) => v })}</div></div>
      <div><h2>Elo distribution</h2><div class="card"><div id="hist"></div></div></div>
    </div>
    <h2>New bots</h2>
    <p class="muted small">Teams seen playing a different submission in the last 48 hours, with their rating change since it was first seen.</p>
    ${newBotsTable()}
    <div class="grid2">
      <div><h2>Biggest risers, 24h</h2>${moverTable(up)}</div>
      <div><h2>Biggest fallers, 24h</h2>${moverTable(down)}</div>
    </div>
    <div class="grid2">
      <div><h2>Languages</h2><div class="table-wrap"><table><thead><tr><th>Language</th><th class="num">Rated teams</th><th class="num">Median Elo</th><th>Best</th></tr></thead><tbody>
        ${Object.entries(langs).sort((a, b) => b[1].length - a[1].length).map(([l, ts]) => { const s = ts.map((t) => t.elo).sort((a, b) => a - b); const best = ts.reduce((a, b) => (b.elo > a.elo ? b : a)); return `<tr><td>${esc(l)}</td><td class="num">${ts.length}</td><td class="num">${s[Math.floor(s.length / 2)]}</td><td class="team">${teamLink(best.id)} <span class="muted small">${best.elo}</span></td></tr>`; }).join('')}
      </tbody></table></div></div>
      <div><h2>Most active, 24h</h2><div class="table-wrap"><table><thead><tr><th>Team</th><th class="num">Battles</th><th class="num">Ranked</th><th class="num">Elo</th></tr></thead><tbody>
        ${active.map((t) => `<tr><td class="team">${teamLink(t.id)}</td><td class="num">${t.series24}</td><td class="num">${t.ranked24}</td><td class="num">${t.elo}</td></tr>`).join('')}
      </tbody></table></div></div>
    </div>
    <h2>Countries</h2>
    <div class="table-wrap"><table><thead><tr><th>Country</th><th class="num">Rated teams</th><th class="num">Top Elo</th><th>Top team</th></tr></thead><tbody>
      ${Object.entries(countries).sort((a, b) => b[1].length - a[1].length).slice(0, 20).map(([c, ts]) => { const best = ts.reduce((a, b) => (b.elo > a.elo ? b : a)); return `<tr><td>${esc(c)}</td><td class="num">${ts.length}</td><td class="num">${best.elo}</td><td class="team">${teamLink(best.id)}</td></tr>`; }).join('')}
    </tbody></table></div>`;

  calibrationChart($('#cal'), cal);
  columnChart($('#act'), m.activity.map((a) => ({
    label: new Date(a.t * 1000).getHours() === 0 ? new Date(a.t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '',
    values: [a.ranked, a.unranked],
    tip: `<div class="tip-h">${esc(fmtWhen(a.t))}</div><div><i class="key s1"></i>Ranked <b>${a.ranked}</b></div><div><i class="key s3"></i>Unranked <b>${a.unranked}</b></div>`,
  })), { classes: ['s1', 's3'], label: 'Battles per hour', sparse: true });
  const lo = Math.floor(Math.min(...rated.map((t) => t.elo)) / 50) * 50, hi = Math.ceil(Math.max(...rated.map((t) => t.elo)) / 50) * 50;
  const bins = [];
  for (let x = lo; x < hi; x += 50) bins.push({ x, n: rated.filter((t) => t.elo >= x && t.elo < x + 50).length });
  columnChart($('#hist'), bins.map((b) => ({ label: b.x % 200 === 0 ? String(b.x) : '', values: [b.n], tip: `<div class="tip-h">${b.x}–${b.x + 49}</div><b>${b.n}</b> teams` })), { classes: ['s1'], label: 'Elo distribution', height: 180, sparse: true });
}

function newBotsTable() {
  const list = S.teams.filter((t) => t.previousSubmission && t.submissionSince && now() - t.submissionSince < 48 * 3600)
    .sort((a, b) => b.submissionSince - a.submissionSince);
  if (!list.length) return '<p class="muted">No submission changes spotted in the last 48 hours.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Team</th><th>Submission</th><th>First seen</th><th class="num">Elo then</th><th class="num">Now</th><th class="num">Since</th></tr></thead><tbody>
    ${list.slice(0, 40).map((t) => `<tr><td class="team">${teamLink(t.id)}</td>
      <td class="nowrap"><span class="muted">#${t.previousSubmission} →</span> <b>#${t.submission}</b></td>
      <td class="nowrap">${ago(t.submissionSince)}</td><td class="num">${t.submissionElo ?? '—'}</td><td class="num">${t.elo}</td>
      <td class="num">${t.submissionElo != null ? signed(t.elo - t.submissionElo) : '—'}</td></tr>`).join('')}
  </tbody></table></div>${list.length > 40 ? `<p class="muted small">40 most recent of ${list.length}.</p>` : ''}`;
}

function moverTable(list) {
  return `<div class="table-wrap"><table><thead><tr><th>Team</th><th class="num">Elo</th><th class="num">24h</th><th class="hide-sm">Trend</th></tr></thead><tbody>
    ${list.map((t) => `<tr><td class="team">${teamLink(t.id)}${t.submissionsSeen > 1 && now() - (t.submissionSince || 0) < 86400 ? ' <span class="tag new">new bot</span>' : ''}</td><td class="num">${t.elo}</td><td class="num">${signed(t.d24)}</td><td class="hide-sm">${sparkline(t.spark)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function calibrationChart(host, cal) {
  host.classList.add('chart');
  const pts = cal.bins.filter((b) => b.games >= 20);
  if (!pts.length) { host.innerHTML = '<p class="muted empty">Not enough ranked games yet.</p>'; return; }
  const maxGap = Math.max(200, ...pts.map((b) => b.meanGap)) * 1.08;
  const yLo = Math.min(0.5, Math.floor((Math.min(...pts.map((b) => b.favWinRate)) - 0.03) * 10) / 10);
  const draw = () => {
    const W = Math.max(280, host.clientWidth), H = 260, m = { l: 44, r: 12, t: 10, b: 32 };
    const X = (g) => m.l + (g / maxGap) * (W - m.l - m.r);
    const Y = (p) => H - m.b - ((p - yLo) / (1 - yLo)) * (H - m.t - m.b);
    const curve = (D) => Array.from({ length: 41 }, (_, i) => { const g = (i / 40) * maxGap; return `${i ? 'L' : 'M'}${X(g).toFixed(1)},${Y(1 / (1 + 10 ** (-g / D))).toFixed(1)}`; }).join('');
    const maxN = Math.max(...pts.map((b) => b.games));
    host.innerHTML = `<div class="tip"></div><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Elo calibration">
      <g class="grid">${[0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].filter((p) => p >= yLo - 1e-9).map((p) => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(p)}" y2="${Y(p)}"/><text class="axis" x="${m.l - 6}" y="${Y(p) + 4}" text-anchor="end">${Math.round(p * 100)}%</text>`).join('')}
      ${Array.from({ length: Math.floor(maxGap / 50) + 1 }, (_, i) => i * 50).filter((g) => g % 100 === 0).map((g) => `<text class="axis" x="${X(g)}" y="${H - 12}" text-anchor="middle">${g}</text>`).join('')}
      <text class="axis" x="${W - m.r}" y="${H - 1}" text-anchor="end">Elo gap →</text></g>
      <path class="line ref" d="${curve(400)}" style="stroke-dasharray:4 4"/>
      <path class="line s2" d="${curve(cal.fittedDivisor)}"/>
      ${pts.map((b, i) => `<circle class="dot s1" data-i="${i}" cx="${X(b.meanGap)}" cy="${Y(b.favWinRate)}" r="${(4 + 6 * Math.sqrt(b.games / maxN)).toFixed(1)}"/>`).join('')}
    </svg>`;
    const tip = $('.tip', host);
    $$('circle[data-i]', host).forEach((c) => {
      c.addEventListener('pointerenter', () => {
        const b = pts[Number(c.dataset.i)];
        tip.innerHTML = `<div class="tip-h">Gap ${b.lo}${b.hi ? `–${b.hi}` : '+'}</div>Favourite won <b>${pct(b.favWinRate)}</b> of ${b.games.toLocaleString()} games<div class="muted">Elo says ${pct(1 / (1 + 10 ** (-b.meanGap / 400)))}</div>`;
        tip.style.display = 'block';
        tip.style.left = `${Math.min(Number(c.getAttribute('cx')) + 10, host.clientWidth - tip.offsetWidth)}px`;
        tip.style.top = `${Math.max(0, Number(c.getAttribute('cy')) - 60)}px`;
      });
      c.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
    });
  };
  draw();
  new ResizeObserver(draw).observe(host);
}

// ---- maps -------------------------------------------------------------------------
// maps.json holds, for each time window and team, an offset per map: how much
// better or worse the team does there than on its other maps (scraper/mapelo.mjs).
// A cell is [offset, standard error, wins, draws, losses], or null if unplayed.
function mapData() {
  if (!S.mapsP) S.mapsP = getJSON('maps.json').catch(() => null);
  return S.mapsP;
}
const OFFSET_CAP = 200; // offsets this far from 0 get the full colour (about the top 5%)
/** Cell fill: blue where a team does better than usual on a map, red where worse, grey at 0. */
function offsetFill(eta) {
  const a = Math.min(Math.abs(eta) / OFFSET_CAP, 1);
  return `color-mix(in oklab, var(${eta >= 0 ? '--div-pos' : '--div-neg'}) ${Math.round(a * 62)}%, var(--div-mid))`;
}
const plainSigned = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
const cellGames = (c) => (c ? c[2] + c[3] + c[4] : 0);
const mapPrefs = (M) => Object.assign({ win: M?.defaultWindow ?? '3d', scope: 'on', q: '', show: 'elo', min: 10, apac: false }, store.get('mapFilters', {}));
const pickWindow = (M, key) => (M.teams[key] ? key : M.windows[Math.min(1, M.windows.length - 1)].key);

function mapTipHtml(t, elo, map, c, min) {
  if (!c) return `<div class="tip-h">${esc(t.name)} · ${esc(map.name)}</div>No ranked games on this map in the window.`;
  const n = cellGames(c);
  return `<div class="tip-h">${esc(t.name)} · ${esc(map.name)}</div>
    <b>${elo + c[0]}</b> map Elo: ${plainSigned(c[0])} vs their usual (± ${c[1]})<br>
    ${c[2]}–${c[3]}–${c[4]} W–D–L in ${n} game${n === 1 ? '' : 's'} · ${pct(winPct(c[2], c[4]), 0)} won
    ${n < min ? `<div class="muted">Fewer than ${min} games, so this leans on the prior.</div>` : ''}`;
}

/** One floating tooltip for map cells/bars; `html(el)` builds the content for a hovered element. */
function bindMapTip(host, selector, html) {
  let tip = $('#maptip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'maptip';
    tip.className = 'tip maptip';
    document.body.appendChild(tip);
    const hide = () => { tip.style.display = 'none'; };
    addEventListener('scroll', hide, { passive: true, capture: true });
    addEventListener('hashchange', hide);
  }
  tip.style.display = 'none';
  host.addEventListener('pointermove', (e) => {
    const el = e.target.closest(selector);
    if (!el || !host.contains(el)) { tip.style.display = 'none'; return; }
    tip.innerHTML = html(el);
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    const x = e.clientX + 14 + r.width > innerWidth ? e.clientX - 14 - r.width : e.clientX + 14;
    const y = e.clientY + 14 + r.height > innerHeight ? e.clientY - 14 - r.height : e.clientY + 14;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  });
  host.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
}

async function viewMaps() {
  main.innerHTML = '<h1>Map Elo</h1><div class="progress"><div></div></div>';
  const M = await mapData();
  if (location.hash.split('?')[0] !== '#/maps') return;
  if (!M?.maps?.length) { main.innerHTML = '<h1>Map Elo</h1><p class="muted">No map data yet. It appears after the next data update.</p>'; return; }
  const f = mapPrefs(M);
  f.win = pickWindow(M, f.win);
  const sort = Object.assign({ key: 'elo', dir: 'desc' }, store.get('mapSort', {}));
  const me = myTeam();
  const maps = M.maps;
  const check = M.check;

  main.innerHTML = `
    <h1>Map Elo</h1>
    <p class="lede">Each team's Elo on each map: its current Elo, plus how much better or worse it does on that map than on its others.
    Offsets are fitted from every ranked and tournament game in the window. <b class="ink2">Blue</b> means stronger than usual on that map, <b class="ink2">red</b> weaker. Hover a cell to see the record behind it.</p>
    <div class="controls" role="group" aria-label="Filters">
      <div class="seg" id="mw" role="group" aria-label="Time window">${M.windows.map((w) => `<button data-w="${w.key}">${esc(w.label.replace(/^Last /, ''))}</button>`).join('')}</div>
      <div class="seg" id="ms" role="group" aria-label="Which teams"><button data-scope="on" title="Active bot and ranked switch on">Ranked on</button><button data-scope="rated">Has rating</button><button data-scope="all">All teams</button></div>
      <input type="search" id="mq" placeholder="Search team…" value="${esc(f.q)}">
      <div class="seg" id="mv" role="group" aria-label="Show"><button data-v="elo">Map Elo</button><button data-v="off" title="Map Elo minus official Elo">vs usual</button></div>
      <label>Fade under <select id="mmin">${[1, 5, 10, 20, 40].map((n) => `<option value="${n}" ${n === f.min ? 'selected' : ''}>${n} games</option>`).join('')}</select></label>
      <label class="chip"><input type="checkbox" id="mapac" ${f.apac ? 'checked' : ''}>APAC eligible</label>
    </div>
    <div class="controls" style="margin-top:-4px">
      <span class="ramp-legend"><span>−${OFFSET_CAP} worse</span><span class="ramp" aria-hidden="true"></span><span>+${OFFSET_CAP} better than usual</span></span>
      <span class="muted small" id="mcount"></span>
    </div>
    <div class="table-wrap"><table id="mt" class="heat">
      <thead><tr>
        <th data-sort="rank" data-dir="asc" class="num hide-sm">#</th>
        <th data-sort="name" data-dir="asc" class="sticky">Team</th>
        <th data-sort="elo" class="num" title="Official Elo">Elo</th>
        ${maps.map((m, i) => `<th data-sort="m${i}" class="map">${esc(m.name)}<span class="muted" id="mg${i}"></span></th>`).join('')}
        <th data-sort="spread" class="num hide-sm" title="Best map minus worst map, counting maps with enough games">Spread</th>
      </tr></thead><tbody></tbody></table></div>
    <h2>Best on each map</h2>
    <div class="leaders" id="leaders"></div>
    <details style="margin-top:18px"><summary>How map Elo is worked out</summary><div class="card" style="margin-top:8px">
      <p style="margin-top:0">For a game on map <i>m</i>, the chance that team <i>i</i> beats team <i>j</i> is modelled as 1 / (1 + 10<sup>−(R<sub>i</sub> + μ<sub>i</sub> + η<sub>im</sub> − R<sub>j</sub> − η<sub>jm</sub>)/${M.D}</sup>),
      where R is each team's official Elo when the game was played (from the battle it belongs to).
      μ<sub>i</sub> absorbs how far a team ran ahead of or behind its rating over the window (a new bot still climbing, say), so that doesn't leak into the maps.
      η<sub>im</sub> is the map offset. It is shrunk towards 0 (a normal prior with SD ${M.tau}), so a map with only a few games stays close to the team's usual level, and the ± in each tooltip is its standard error.
      <b>Map Elo = current official Elo + η.</b></p>
      <p>Only ranked and tournament games count. Unranked challenges can use any submission on either side, not the team's active bot.
      Every game is used, not a sample: the site lists all games with their maps.</p>
      ${check ? `<p><b>Does it predict anything?</b> On the ${check.games.toLocaleString()} ranked games of the last ${Math.round(check.hours)} hours, with offsets fitted on the ${esc(check.window)} before them:
      plain Elo had log-loss ${check.base.toFixed(4)} (${pct(check.baseAcc, 1)} of games called right). Adding both teams' map offsets gave ${check.model.toFixed(4)} (${pct(check.modelAcc, 1)}). Lower log-loss is better.</p>` : ''}
    </div></details>`;

  const save = () => store.set('mapFilters', f);
  const segs = (sel, attr, key) => {
    const btns = $$(`${sel} button`);
    btns.forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset[attr] === f[key]));
      b.onclick = () => { f[key] = b.dataset[attr]; save(); btns.forEach((x) => x.setAttribute('aria-pressed', String(x === b))); render(); };
    });
  };
  segs('#mw', 'w', 'win');
  segs('#ms', 'scope', 'scope');
  segs('#mv', 'v', 'show');
  $('#mq').oninput = (e) => { f.q = e.target.value; save(); render(); };
  $('#mmin').onchange = (e) => { f.min = Number(e.target.value); save(); render(); };
  $('#mapac').onchange = (e) => { f.apac = e.target.checked; save(); render(); };

  const table = $('#mt');
  const tbody = table.tBodies[0];
  let rows = [];
  const ok = (c) => c && cellGames(c) >= f.min;
  const spreadOf = (r) => {
    const v = r.cells.filter(ok).map((c) => c[0]);
    return v.length >= 2 ? Math.max(...v) - Math.min(...v) : null;
  };
  const cols = [
    { key: 'rank', get: (r) => (r.t.ranked ? r.t.rank : null) },
    { key: 'name', get: (r) => r.t.name.toLowerCase() },
    { key: 'elo', get: (r) => r.t.elo },
    ...maps.map((m, i) => ({ key: `m${i}`, get: (r) => (ok(r.cells[i]) ? (f.show === 'off' ? 0 : r.t.elo) + r.cells[i][0] : null) })),
    { key: 'spread', get: spreadOf },
  ];
  const renderBody = () => {
    tbody.innerHTML = rows.length ? rows.map((r) => `<tr class="clickable${me && r.t.id === me.id ? ' me' : ''}" data-id="${r.t.id}">
      <td class="num hide-sm">${r.t.ranked ? r.t.rank : '<span class="muted">—</span>'}</td>
      <td class="team sticky">${teamLink(r.t.id, r.t.name)}</td>
      <td class="num"><b>${r.t.elo}</b></td>
      ${r.cells.map((c, i) => {
        if (!c) return '<td class="cell none"><span>—</span></td>';
        const thin = cellGames(c) < f.min;
        const v = f.show === 'off' ? plainSigned(c[0]) : r.t.elo + c[0];
        return `<td class="cell${thin ? ' thin' : ''}" data-i="${i}"${thin ? '' : ` style="background:${offsetFill(c[0])}"`}><span>${v}</span></td>`;
      }).join('')}
      <td class="num hide-sm">${spreadOf(r) ?? '<span class="muted">—</span>'}</td>
    </tr>`).join('') : `<tr><td colspan="${maps.length + 4}" class="empty muted">No teams with games in this window match these filters.</td></tr>`;
  };
  tbody.onclick = (e) => {
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) location.hash = `#/team/${tr.dataset.id}`;
  };
  bindMapTip(tbody, 'td.cell[data-i]', (el) => {
    const t = S.byId.get(Number(el.closest('tr').dataset.id));
    const i = Number(el.dataset.i);
    return mapTipHtml(t, t.elo, maps[i], M.teams[f.win][t.id]?.cells[i], f.min);
  });
  sort.onChange = () => store.set('mapSort', { key: sort.key, dir: sort.dir });

  function render() {
    const wi = M.windows.findIndex((w) => w.key === f.win);
    const data = M.teams[f.win];
    const q = f.q.trim().toLowerCase();
    rows = S.teams.filter((t) => {
      if (!data[t.id]) return false;
      if (f.scope === 'on' && !(t.accepting && t.hasBot)) return false;
      if (f.scope === 'rated' && !t.ranked) return false;
      if (f.apac && !t.eligible) return false;
      if (q && !`${t.name} ${t.members.join(' ')}`.toLowerCase().includes(q)) return false;
      return true;
    }).map((t) => ({ t, cells: data[t.id].cells, mu: data[t.id].mu }));
    maps.forEach((m, i) => { $(`#mg${i}`).textContent = `${m.games[wi].toLocaleString()} games`; });
    const w = M.windows[wi];
    $('#mcount').textContent = `${rows.length} team${rows.length === 1 ? '' : 's'} · ${w.games.toLocaleString()} games ${w.partial ? `since ${shortDate(w.from)}, when collection started` : 'in the window'}`;
    sortable(table, rows, cols, sort, renderBody);
    // Leaders: top five on each map among the teams shown, with enough games there.
    $('#leaders').innerHTML = maps.map((m, i) => {
      const top = rows.filter((r) => ok(r.cells[i])).sort((a, b) => (b.t.elo + b.cells[i][0]) - (a.t.elo + a.cells[i][0])).slice(0, 5);
      return `<div class="card"><h3 style="margin:0">${esc(m.name)}</h3><div class="muted small">${m.games[wi].toLocaleString()} games</div>
        ${top.length ? `<ol>${top.map((r, k) => `<li><span class="rk">${k + 1}</span>${teamLink(r.t.id, r.t.name)}<span class="num">${r.t.elo + r.cells[i][0]} <span class="muted small">${plainSigned(r.cells[i][0])}</span></span></li>`).join('')}</ol>` : '<p class="muted small">No team with enough games.</p>'}</div>`;
    }).join('');
  }
  render();
}

/** Team page: map Elo as bars around the team's usual level. */
async function teamMaps(t) {
  const host = $('#maps');
  const M = await mapData();
  if (!host.isConnected) return;
  if (!M?.maps?.length) { host.innerHTML = '<p class="muted">No map data yet.</p>'; return; }
  const f = mapPrefs(M);
  let win = pickWindow(M, store.get('teamMapWin', f.win));
  const draw = () => {
    const data = M.teams[win]?.[t.id];
    const rows = M.maps.map((m, i) => ({ m, i, c: data?.cells[i] ?? null }))
      .sort((a, b) => (b.c ? b.c[0] : -1e9) - (a.c ? a.c[0] : -1e9));
    host.innerHTML = `<div class="card">
      <div class="controls" style="margin-top:0"><div class="seg" role="group" aria-label="Time window">${M.windows.map((w) =>
        `<button data-w="${w.key}" aria-pressed="${w.key === win}">${esc(w.label.replace(/^Last /, ''))}</button>`).join('')}</div></div>
      ${data ? `<div class="mbars">
        <div class="mbar head"><span>Map</span><span style="text-align:center;white-space:nowrap">← worse · better →</span><span style="text-align:right">Map Elo</span><span style="text-align:right">W–L</span></div>
        ${rows.map(({ m, i, c }) => {
          if (!c) return `<div class="mbar"><div class="lab">${esc(m.name)}</div><div class="track"></div><div class="val muted">—</div><div class="rec">0–0</div></div>`;
          const thin = cellGames(c) < f.min;
          const w = (Math.min(Math.abs(c[0]) / OFFSET_CAP, 1) * 50).toFixed(1);
          return `<div class="mbar" data-i="${i}"><div class="lab">${esc(m.name)}</div>
            <div class="track"><div class="fill ${c[0] >= 0 ? 'pos' : 'neg'}${thin ? ' thin' : ''}" style="width:${w}%"></div></div>
            <div class="val"><b>${t.elo + c[0]}</b> <span class="muted small">${plainSigned(c[0])}</span></div>
            <div class="rec">${c[2]}–${c[4]}</div></div>`;
        }).join('')}</div>
        <p class="muted small" style="margin-bottom:0">Ranked and tournament games only, every game counted. Faded bars have fewer than ${f.min} games. <a href="#/maps">All teams →</a></p>`
        : '<p class="muted">No ranked games in this window.</p>'}
    </div>`;
    $$('.seg button', host).forEach((b) => { b.onclick = () => { win = b.dataset.w; store.set('teamMapWin', win); draw(); }; });
  };
  draw();
  bindMapTip(host, '.mbar[data-i]', (el) => {
    const i = Number(el.dataset.i);
    return mapTipHtml(t, t.elo, M.maps[i], M.teams[win]?.[t.id]?.cells[i], f.min);
  });
}

/** Matchup: single-game odds on each map, from both teams' map offsets. */
async function matchupMaps(A, B, eloA, eloB, D) {
  const M = await mapData();
  const box = $('#mmaps');
  if (!box) return;
  const win = pickWindow(M || { teams: {}, windows: [{ key: '3d' }] }, mapPrefs(M).win);
  const a = M?.teams[win]?.[A.id], b = M?.teams[win]?.[B.id];
  if (!M?.maps?.length || !a || !b) { box.innerHTML = '<h3>By map</h3><p class="muted">Not enough map data for these two teams in the window.</p>'; return; }
  const w = M.windows.find((x) => x.key === win);
  const rows = M.maps.map((m, i) => {
    const ea = a.cells[i]?.[0] ?? 0, eb = b.cells[i]?.[0] ?? 0;
    return { m, ea, eb, na: cellGames(a.cells[i]), nb: cellGames(b.cells[i]), p: expected(eloA + ea, eloB + eb, D) };
  }).sort((x, y) => y.p - x.p);
  const flat = expected(eloA, eloB, D);
  box.innerHTML = `<h3>By map</h3>
    <div class="table-wrap"><table><thead><tr><th>Map</th><th class="num">${esc(A.name)}</th><th class="num">${esc(B.name)}</th><th class="num">${esc(A.name)} wins a game</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.m.name)}</td>
      <td class="num">${Math.round(eloA + r.ea)} <span class="muted small">${plainSigned(r.ea)} · ${r.na}g</span></td>
      <td class="num">${Math.round(eloB + r.eb)} <span class="muted small">${plainSigned(r.eb)} · ${r.nb}g</span></td>
      <td class="num pct bar-cell"><div class="b" style="width:${(r.p * 100).toFixed(1)}%"></div><span>${pct(r.p, 0)} <span class="muted small">${signed(Math.round((r.p - flat) * 100))}</span></span></td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted small" style="margin-bottom:0">Map Elo = the Elo above plus each team's map offset over the ${esc(w.label.toLowerCase())} (games on that map shown as “g”). The last column's small figure is percentage points against the overall ${pct(flat, 0)}. <a href="#/maps">Map Elo for every team →</a></p>`;
}

// ---- about -----------------------------------------------------------------------
function viewAbout() {
  const m = S.meta;
  main.innerHTML = `
    <h1>About</h1>
    <div class="card"><p class="lede" style="margin-top:0">An unofficial companion to <a href="${SITE}">UNSW Battlecode 2026</a>. A scheduled job reads the public pages of game.battlecode.au and publishes the snapshot here. It uses no login, API key or cookies, so it only sees what any visitor sees.</p>
    <h3>What's collected</h3>
    <ul>
      <li><b>Leaderboard</b>: every team, rating, record, eligibility tags and ranked-switch setting.</li>
      <li><b>Team pages</b>: read once per team, for its description and the history from before this site started watching. After that, Elo history and records carry forward from the battle log and ranks from the hourly leaderboard.</li>
      <li><b>Battles</b>: every finished battle (ranked and unranked), stored incrementally. ${m.counts.battles.toLocaleString()} so far.</li>
      <li><b>Games</b>: every finished game with its map and winner${m.gamesSince ? ` since ${esc(fmtWhen(m.gamesSince))}` : ''}, stored incrementally. ${(m.counts.games ?? 0).toLocaleString()} so far. These drive <a href="#/maps">Map Elo</a>.</li>
      <li><b>Match details</b> for a sample of battles: which submission each side used. ${m.counts.details.toLocaleString()} sampled.</li>
      <li><b>Tournaments</b>: the Sprint and Qualifiers brackets as currently seeded.</li>
    </ul>
    <h3>Submissions</h3>
    <p>Other teams' bots can't be downloaded, and the site doesn't list their uploads. It does record, for every match, which submission ID each side played. Each run checks the newest ranked match of teams not checked in the last two hours, top of the ladder first, so a new bot shows up within about two hours. Ranked battles always use each team's active bot. Unranked challenges can use other submissions for either side, so submissions seen only there are listed separately. A submission's record only counts battles seen with it, plus ranked battles between two sightings of it.</p>
    <h3>Map Elo</h3>
    <p>A team's map Elo is its current official Elo plus an offset for how much better or worse it does on that map than on its others. The offsets are fitted from every ranked and tournament game in the chosen window, against each opponent's official Elo at the time, and shrunk towards 0 so a few games can't produce a wild number. The <a href="#/maps">Map Elo</a> page explains the model and shows how much it improves predictions.</p>
    <h3>Odds</h3>
    <p>Per-game win probability is the Elo expectation 1 / (1 + 10<sup>(R<sub>B</sub> − R<sub>A</sub>)/D</sup>), with D = 400 as on the site or D fitted to recent ranked games. Series odds treat games as independent (draws ignored). Rating changes use the site's rule: K falls from 96 for a new submission to 24 after 10 ranked battles. Tournament odds simulate the site's tentative brackets, which are re-seeded from the ladder after the final autoscrims, so they will shift. The optional rating uncertainty draws each team's strength from Elo ± σ once per simulated season. The Grand Final format is an assumption, noted on that page.</p>
    <h3>Caveats</h3>
    <ul>
      <li>Battle Elo figures are the ones listed with the battle on the site.</li>
      <li>Submission stats come from sampled matches. Map stats use every game.</li>
      <li>Everything here is public on game.battlecode.au. Team pages link back to the official site for replays.</li>
    </ul>
    <p class="muted small">Last run: ${m.run.requests} requests in ${m.run.seconds}s.</p></div>`;
}

// ---------------------------------------------------------------------------
// router & boot
// ---------------------------------------------------------------------------
function route() {
  const [p, qs] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(qs || '');
  const path = p || '/';
  const nav = path.startsWith('/team/') ? 'leaderboard' : path.slice(1) || 'leaderboard';
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
  window.scrollTo(0, 0);
  let m;
  if ((m = path.match(/^\/team\/(\d+)/))) viewTeam(Number(m[1]));
  else if (path === '/maps') viewMaps();
  else if (path === '/matchup') viewMatchup(params);
  else if (path === '/odds') viewOdds(params);
  else if (path === '/battles') viewBattles();
  else if (path === '/stats') viewStats();
  else if (path === '/about') viewAbout();
  else viewLeaderboard();
  const name = { leaderboard: 'Leaderboard', maps: 'Map Elo', odds: 'Odds', matchup: 'Matchup', battles: 'Battles', stats: 'Stats', about: 'About' }[nav];
  const team = m && S.byId.get(Number(m[1]));
  document.title = `${team ? team.name : name || 'Leaderboard'} · Battlecode Stats`;
}

async function boot() {
  const themeBtn = $('#theme');
  themeBtn.onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('bcs.theme', document.documentElement.dataset.theme); } catch {}
  };
  try {
    const [teams, meta, tour] = await Promise.all([getJSON('teams.json'), getJSON('meta.json'), getJSON('tournaments.json')]);
    S.teams = teams.sort((a, b) => a.rank - b.rank);
    S.byId = new Map(teams.map((t) => [t.id, t]));
    S.meta = meta;
    S.tour = tour;
  } catch (err) {
    main.innerHTML = `<div class="card"><h1>No data yet</h1><p>The data files couldn't be loaded (${esc(err.message)}). If this is a fresh deploy, the first scrape may still be running.</p></div>`;
    return;
  }
  setUpdated();
  setInterval(setUpdated, 60000);
  teamOptions();
  const my = $('#myteam');
  my.value = teamValue(myTeam());
  my.onchange = () => {
    const t = parseTeam(my.value);
    store.set('myTeam', t ? t.id : null);
    if (!t) my.value = '';
    route();
  };
  addEventListener('hashchange', route);
  route();
}
boot();
