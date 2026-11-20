#!/usr/bin/env node
// Builds data.json (only the tracked players) from the pokedata.ovh standings.
// Zero dependencies, Node 18+.
//
//   node scripts/update.mjs               fetch once, write data.json
//   node scripts/update.mjs --watch 320   poll every minute for 320 minutes and
//                                         commit + push data.json when it changes
//
// pokedata sends no CORS headers, so the page cannot read it from the browser.
// The GitHub Actions workflow runs this in --watch mode instead.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(readFileSync(path.join(ROOT, 'players.json'), 'utf8'));
const DATA_FILE = path.join(ROOT, 'data.json');
const SOURCE_BASE = 'https://www.pokedata.ovh/standings2/standings';
const SOURCE_PAGE = 'https://www.pokedata.ovh/standings2/' + CONFIG.tournamentId;
const USER_AGENT = 'standings-tracker/1.0 (polls once a minute)';

const POLL_MS = 60 * 1000;
const MAJOR_GAP_MS = 90 * 1000; // a tracked player's result or pairing changed
const MINOR_GAP_MS = 10 * 60 * 1000; // only rank / opponent records moved

const DIVISIONS = [...new Set(CONFIG.players.map((p) => p.division))];

// ------------------------------------------------------------ extraction ---
// { tournament: {title, date, day1, day2},
//   standings: { players: [ {n, c, s:[w,l,t], p, d, i, r:[[oppId, result, table], ...]} ] } }
// players[] is ordered by rank.  result: 3 win, 1 tie, 0 loss, -1 still playing.
// oppId -1 with a win is a bye; oppId null is a round with no opponent (late / no-show).
// d is null, or the round after which the player dropped.
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const RESULT = { 3: 'W', 1: 'T', 0: 'L', '-1': 'LIVE' };

export function summarize(json, division, tracked) {
  const players = json && json.standings && json.standings.players;
  if (!Array.isArray(players)) throw new Error('unexpected standings shape');
  const byId = new Map(players.map((p) => [p.i, p]));
  const round = players.reduce((m, p) => Math.max(m, Array.isArray(p.r) ? p.r.length : 0), 0);
  const live = players.filter((p) => Array.isArray(p.r) && p.r.some((x) => x[1] === -1)).length;

  const out = [];
  for (const t of tracked.filter((x) => x.division === division)) {
    const wanted = norm(t.name);
    const sameName = players.map((p, idx) => ({ p, idx })).filter(({ p }) => norm(p.n) === wanted);
    const matches = t.id == null ? sameName : sameName.filter(({ p }) => p.i === t.id);
    if (!matches.length) { out.push({ name: t.name, missing: true }); continue; }
    for (const { p, idx } of matches) {
      const rounds = (p.r || []).map((x, n) => {
        const o = x[0] != null && x[0] !== -1 ? byId.get(x[0]) : null;
        return {
          n: n + 1,
          result: RESULT[x[1]] || '?',
          table: x[2] > 0 ? x[2] : null,
          bye: x[0] === -1,
          opponent: o ? { id: o.i, name: o.n, country: o.c || null, record: (o.s || []).join('-') } : null,
        };
      });
      out.push({
        name: p.n, country: p.c || null, id: p.i,
        rank: idx + 1, record: p.s || [0, 0, 0], points: p.p || 0,
        droppedAfter: typeof p.d === 'number' ? p.d : null,
        homonyms: sameName.length,
        rounds,
      });
    }
  }
  const T = json.tournament || {};
  return {
    division, round, day1: T.day1 || null, day2: T.day2 || null,
    tablesLive: Math.round(live / 2), total: players.length,
    title: T.title || null, date: T.date || null,
    players: out,
  };
}

// ----------------------------------------------------------------- source ---
const cache = new Map(); // division -> {summary, etag, lastModified}

async function refresh(division) {
  const c = cache.get(division) || {};
  const headers = { 'user-agent': USER_AGENT, accept: 'application/json' };
  if (c.etag) headers['if-none-match'] = c.etag;
  try {
    const url = SOURCE_BASE + '/' + CONFIG.tournamentId + '_' + division + '.json';
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (res.status !== 304) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      c.summary = summarize(await res.json(), division, CONFIG.players);
      c.etag = res.headers.get('etag');
      const lm = Date.parse(res.headers.get('last-modified') || '');
      c.sourceUpdated = Number.isFinite(lm) ? lm : Date.now();
    }
  } catch (e) {
    console.error(new Date().toISOString(), division, 'fetch failed:', String((e && e.message) || e));
  }
  cache.set(division, c);
}

// Divisions the source could not deliver keep whatever the previous data.json had.
function build(previous) {
  const old = new Map(((previous && previous.divisions) || []).map((d) => [d.division, d]));
  const divisions = DIVISIONS.map((d) => {
    const c = cache.get(d);
    if (c && c.summary) return { ...c.summary, sourceUpdated: c.sourceUpdated };
    if (old.has(d)) return old.get(d);
    return { division: d, round: null, players: CONFIG.players.filter((p) => p.division === d).map((p) => ({ name: p.name, missing: true })) };
  });
  return { generatedAt: Date.now(), sourcePage: SOURCE_PAGE, divisions };
}

// "major": something about a tracked player's own matches. "body": everything shown.
const major = (data) => JSON.stringify((data.divisions || []).map((d) => [d.division, d.round,
  (d.players || []).map((p) => [p.id, p.missing, p.record, p.droppedAfter, (p.rounds || []).map((r) => [r.result, r.table, r.opponent && r.opponent.id])])]));
const body = (data) => JSON.stringify((data.divisions || []).map((d) => ({ ...d, sourceUpdated: 0 })));

const readData = () => { try { return JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch { return null; } };
const writeData = (data) => writeFileSync(DATA_FILE, JSON.stringify(data, null, 1) + '\n');

// -------------------------------------------------------------------- git ---
const git = (...args) => execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function publish(data) {
  writeData(data);
  const label = data.divisions.map((d) => d.division + ' R' + (d.round == null ? '?' : d.round)).join(', ');
  git('add', 'data.json');
  try { git('commit', '-m', 'data: ' + label); } catch { return true; } // nothing to commit
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { git('push', 'origin', 'HEAD:' + (process.env.PUBLISH_BRANCH || 'gh-pages')); return true; } catch (e) {
      console.error('push failed (attempt ' + attempt + '):', String(e.stderr || e.message).trim().split('\n').pop());
      try { git('pull', '--rebase', '-X', 'theirs', 'origin', process.env.PUBLISH_BRANCH || 'gh-pages'); } catch { try { git('rebase', '--abort'); } catch {} }
    }
  }
  return false;
}

// ------------------------------------------------------------------- main ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once() {
  await Promise.all(DIVISIONS.map(refresh));
  const data = build(readData());
  writeData(data);
  for (const d of data.divisions) console.log(d.division, 'round', d.round, '-', (d.players || []).map((p) => p.name + (p.missing ? ' (missing)' : ' ' + p.record.join('-'))).join(', '));
}

async function watch(minutes) {
  const deadline = Date.now() + minutes * 60 * 1000;
  const endsAt = Date.parse(CONFIG.endsAt || '') || Infinity;
  let published = readData();
  let lastPush = 0;
  for (;;) {
    await Promise.all(DIVISIONS.map(refresh));
    const data = build(published);
    const since = Date.now() - lastPush;
    const isMajor = !published || major(data) !== major(published);
    const isMinor = !published || body(data) !== body(published);
    if ((isMajor && since >= MAJOR_GAP_MS) || (isMinor && since >= MINOR_GAP_MS)) {
      const ok = publish(data);
      console.log(new Date().toISOString(), ok ? 'published' : 'publish FAILED', isMajor ? '(result/pairing change)' : '(standings moved)');
      if (ok) { published = data; lastPush = Date.now(); }
    }
    if (Date.now() >= endsAt) { console.log('tournament window is over, stopping'); return; }
    if (Date.now() + POLL_MS >= deadline) return;
    await sleep(POLL_MS);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--watch');
  if (i === -1) await once();
  else await watch(Math.max(1, Number(process.argv[i + 1]) || 320));
}
