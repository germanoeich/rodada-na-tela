#!/usr/bin/env node
// Polls the pokedata.ovh standings, keeps only the tracked players and uploads
// the result to the S3 bucket behind https://temp-assets.gin.codes.
// Zero dependencies, Node 18+. Credentials come from .env (see scripts/s3.mjs).
//
//   node scripts/update.mjs          poll once a minute until the tournament ends
//   node scripts/update.mjs --once   fetch and upload a single time
//
// The upload is a small JavaScript file (data.jsonp) that calls window.__rodadaData(...).
// The page loads it with a <script> tag, so the bucket needs no CORS configuration.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { s3Config, putObject } from './s3.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(readFileSync(path.join(ROOT, 'players.json'), 'utf8'));
const SOURCE_BASE = 'https://www.pokedata.ovh/standings2/standings';
const SOURCE_PAGE = 'https://www.pokedata.ovh/standings2/' + CONFIG.tournamentId;
const USER_AGENT = 'standings-tracker/1.0 (polls once a minute)';
const OBJECT_KEY = CONFIG.objectKey || 'rodada-na-tela/data.jsonp';
const POLL_MS = 60 * 1000;

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
const cache = new Map(); // division -> {summary, etag, sourceUpdated}
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Conditional GET: an unchanged file costs a 304 with no body.
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
    cache.set(division, c);
    return true;
  } catch (e) {
    log(division, 'source fetch failed:', String((e && e.message) || e));
    return false;
  }
}

// generatedAt doubles as the heartbeat the page uses to tell the poller is alive.
const build = () => ({
  generatedAt: Date.now(), sourcePage: SOURCE_PAGE,
  divisions: DIVISIONS.map((d) => ({ ...cache.get(d).summary, sourceUpdated: cache.get(d).sourceUpdated })),
});

const headline = (data) => data.divisions.map((d) => d.division + ' R' + d.round + ': ' +
  d.players.map((p) => p.name.split(' ')[0] + ' ' + (p.missing ? 'missing' : p.record.join('-') + (p.rounds.some((r) => r.result === 'LIVE') ? '*' : ''))).join(', ')).join(' | ');

async function upload(s3, data) {
  const js = 'window.__rodadaData && window.__rodadaData(' + JSON.stringify(data) + ');\n';
  await putObject(s3, OBJECT_KEY, js, 'application/javascript; charset=utf-8', 'no-cache, max-age=0');
}

// Returns true when the bucket now holds a fresh copy.
async function cycle(s3, state) {
  const ok = (await Promise.all(DIVISIONS.map(refresh))).every(Boolean);
  if (!ok || !DIVISIONS.every((d) => cache.get(d) && cache.get(d).summary)) return false;
  const data = build();
  try { await upload(s3, data); } catch (e) { log('upload failed:', String((e && e.message) || e)); return false; }
  const h = headline(data);
  if (h !== state.headline) { state.headline = h; log(h); }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s3 = s3Config();
  if (!s3) { console.error('Missing S3_ACCESS_KEY / S3_SECRET_KEY / S3_API_URL / S3_BUCKET_NAME (.env).'); process.exit(1); }
  const state = { headline: null };
  if (process.argv.includes('--once')) {
    process.exit((await cycle(s3, state)) ? 0 : 1);
  }
  const endsAt = Date.parse(CONFIG.endsAt || '') || Infinity;
  log('polling every ' + POLL_MS / 1000 + 's, uploading to ' + s3.bucket + '/' + OBJECT_KEY);
  for (;;) {
    await cycle(s3, state);
    if (Date.now() >= endsAt) { log('tournament window is over, stopping'); break; }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
