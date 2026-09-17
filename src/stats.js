/*
 * One row per finished game, kept for the operator stats endpoint.
 *
 * SQLite-backed rather than key/value: a report wants to GROUP BY, and the
 * Workers Free plan only offers SQLite Durable Objects anyway. There is exactly
 * one instance of this object per game (idFromName('main')); the games
 * themselves write to it and never read it back.
 */

const KEEP_DAYS = 120;   // rows older than this are dropped on the next write

export class Stats {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY,
      ended INTEGER NOT NULL,      -- epoch ms
      seconds INTEGER NOT NULL,    -- wall clock the game ran for
      outcome TEXT NOT NULL,       -- 'win' | 'abandoned'
      winner TEXT,                 -- side that won; null when nobody did
      players INTEGER NOT NULL,    -- humans present at the end
      detail TEXT                  -- JSON, whatever the game wants to keep
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS games_ended ON games (ended)');
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/internal/record') {
      const row = await request.json().catch(() => null);
      if (row) this.record(row);
      return new Response('ok');
    }
    if (url.pathname === '/api/stats') return this.report(url);
    return new Response('not found', { status: 404 });
  }

  record(r) {
    this.sql.exec(
      'INSERT INTO games (ended, seconds, outcome, winner, players, detail) VALUES (?, ?, ?, ?, ?, ?)',
      Date.now(),
      Math.max(0, Math.round(Number(r.seconds) || 0)),
      String(r.outcome || 'abandoned'),
      r.winner == null ? null : String(r.winner),
      Math.max(0, Math.round(Number(r.players) || 0)),
      r.detail === undefined ? null : JSON.stringify(r.detail));
    this.sql.exec('DELETE FROM games WHERE ended < ?',
      Date.now() - KEEP_DAYS * 86400000);
  }

  /* Everything a report needs in one shot: the totals, the split by outcome
     and by winner, and a per-day row so a report can show a shape. */
  report(url) {
    const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10) || 7));
    const from = Date.now() - days * 86400000;
    const rows = this.sql.exec(
      'SELECT ended, seconds, outcome, winner, players, detail FROM games WHERE ended >= ? ORDER BY ended',
      from).toArray();

    const tally = (key) => {
      const out = {};
      for (const r of rows) {
        const k = r[key] == null ? '—' : String(r[key]);
        out[k] = (out[k] || 0) + 1;
      }
      return out;
    };

    const byDay = {};
    for (const r of rows) {
      const d = new Date(r.ended).toISOString().slice(0, 10);
      if (!byDay[d]) byDay[d] = { games: 0, seconds: 0 };
      byDay[d].games++;
      byDay[d].seconds += r.seconds;
    }

    const seconds = rows.reduce((a, r) => a + r.seconds, 0);
    return new Response(JSON.stringify({
      days,
      from: new Date(from).toISOString(),
      to: new Date().toISOString(),
      games: rows.length,
      seconds,
      medianSeconds: median(rows.map((r) => r.seconds)),
      longestSeconds: rows.reduce((a, r) => Math.max(a, r.seconds), 0),
      byOutcome: tally('outcome'),
      byWinner: tally('winner'),
      byDay,
      rows: rows.map((r) => ({
        ended: new Date(r.ended).toISOString(),
        seconds: r.seconds,
        outcome: r.outcome,
        winner: r.winner,
        players: r.players,
        detail: r.detail ? JSON.parse(r.detail) : null,
      })),
    }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/* Shared by all three games' Workers: gate /api/stats on a shared secret, and
   give the games a one-liner for writing a result. */
export function statsStub(env) {
  return env.STATS.get(env.STATS.idFromName('main'));
}

export function statsFetch(env, request, url) {
  if (!env.STATS_KEY || url.searchParams.get('key') !== env.STATS_KEY) {
    return new Response('forbidden', { status: 403 });
  }
  return statsStub(env).fetch(request);
}

export function recordGame(env, ctx, row) {
  if (!env.STATS) return;
  ctx.waitUntil(statsStub(env).fetch('https://stats/internal/record', {
    method: 'POST',
    body: JSON.stringify(row),
  }));
}
