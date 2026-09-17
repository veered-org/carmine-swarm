/*
 * Swarm v0.1 - game logic, unchanged from the original single-server Node version.
 *
 * Extracted verbatim from that server. The only change is the wrapper: the original kept `game`, `players`
 * and the rest as module-level state, which every room sharing an isolate would
 * have shared too. A factory gives each Durable Object its own copy and leaves
 * the simulation itself untouched.
 *
 * What was dropped, and why it is safe:
 *   - node requires and the hand-rolled RFC 6455 WSConn class;
 *                   Workers has a native WebSocket, see room.js.
 *   - the two setInterval timers; the Durable Object owns the
 *                   loop now so it can stop it when the room empties.
 *   - http.createServer, the upgrade handshake and the startup
 *                   banner; assets come from the assets binding.
 */
export function createGame() {
/* ------------------------------------------------------------------ *
 * Game constants
 * ------------------------------------------------------------------ */

const WORLD_W = 1280;
const WORLD_H = 720;

const TICK_HZ = 20;
const TICK_DT = 1 / TICK_HZ;

const MAX_UNITS = 90;        // per team
const UNIT_HP = 12;
const UNIT_DMG = 4;
const UNIT_ATK_CD = 0.7;
const UNIT_RANGE = 18;
const UNIT_SIGHT = 140;
const UNIT_SPEED = 80;
const UNIT_R = 7;
const SEP_D = 13;            // minions shove each other apart below this
const SEP_D2 = SEP_D * SEP_D;

const CAP_RADIUS = 70;
const CAP_RATE = 12;         // cap points per second per net minion
const CAP_NET_MAX = 5;       // beyond this, extra minions do not speed capture
const BASE_CAP_MULT = 0.25;  // bases are much tougher to flip than neutral towers

const SPAWN_BASE = 1.4;
const SPAWN_TOWER = 2.6;
const HEAL_RADIUS = 90;
const HEAL_RATE = 2;

const COUNTDOWN = 3;
const OVER_LINGER = 6;

const TOWER_DEFS = [
  { x: 120, y: 360, base: 1 },
  { x: 1160, y: 360, base: 2 },
  { x: 400, y: 160, base: 0 },
  { x: 880, y: 160, base: 0 },
  { x: 400, y: 560, base: 0 },
  { x: 880, y: 560, base: 0 },
  { x: 640, y: 250, base: 0 },
  { x: 640, y: 470, base: 0 },
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ------------------------------------------------------------------ *
 * Game state
 * ------------------------------------------------------------------ */

let gameSeq = 0;
let nextUnitId = 1;

function newGame() {
  gameSeq++;
  nextUnitId = 1;
  return {
    id: gameSeq,
    state: 'lobby',      // lobby | countdown | playing | over
    clock: 0,
    countdown: 0,
    overTimer: 0,
    winner: 0,
    reason: '',
    units: [],
    rally: { 1: null, 2: null },
    towers: TOWER_DEFS.map((d, i) => ({
      id: i,
      x: d.x,
      y: d.y,
      base: d.base,
      cap: d.base === 1 ? 100 : d.base === 2 ? -100 : 0,
      owner: d.base,
      spawnT: d.base ? SPAWN_BASE : SPAWN_TOWER,
      pulse: 0,
    })),
  };
}

let game = newGame();

function spawnUnit(team, x, y) {
  const a = Math.random() * Math.PI * 2;
  const r = 14 + Math.random() * 16;
  game.units.push({
    id: nextUnitId++,
    team,
    x: clamp(x + Math.cos(a) * r, 10, WORLD_W - 10),
    y: clamp(y + Math.sin(a) * r, 10, WORLD_H - 10),
    hp: UNIT_HP,
    cd: Math.random() * UNIT_ATK_CD,
    ox: null,
    oy: null,
    atk: 0,
    px: 0,
    py: 0,
    nearest: null,
    nd: 0,
  });
}

function teamUnitCount(team) {
  let n = 0;
  for (const u of game.units) if (u.team === team) n++;
  return n;
}

function teamTowerCount(team) {
  let n = 0;
  for (const t of game.towers) if (t.owner === team) n++;
  return n;
}

function stepTowers(dt) {
  for (const tw of game.towers) {
    let a1 = 0;
    let a2 = 0;
    for (const u of game.units) {
      const dx = u.x - tw.x;
      const dy = u.y - tw.y;
      if (dx * dx + dy * dy < CAP_RADIUS * CAP_RADIUS) {
        if (u.team === 1) a1++; else a2++;
      }
    }

    const net = clamp(a1 - a2, -CAP_NET_MAX, CAP_NET_MAX);
    if (net !== 0) {
      const rate = CAP_RATE * (tw.base ? BASE_CAP_MULT : 1);
      tw.cap = clamp(tw.cap + net * rate * dt, -100, 100);
    }
    // A base never goes neutral: its owner holds it - and keeps spawning for a
    // last stand - right up until the attacker drags the meter across the
    // midpoint, which loses the game. Field towers still pass through neutral.
    tw.owner = tw.base
      ? (tw.cap >= 0 ? 1 : 2)
      : (tw.cap >= 100 ? 1 : tw.cap <= -100 ? 2 : 0);

    if (tw.pulse > 0) tw.pulse -= dt;

    if (tw.owner !== 0) {
      tw.spawnT -= dt;
      if (tw.spawnT <= 0) {
        tw.spawnT = tw.base ? SPAWN_BASE : SPAWN_TOWER;
        if (teamUnitCount(tw.owner) < MAX_UNITS) {
          spawnUnit(tw.owner, tw.x, tw.y);
          tw.pulse = 0.35;
          const r = game.rally[tw.owner];
          if (r) {
            const u = game.units[game.units.length - 1];
            u.ox = r.x;
            u.oy = r.y;
          }
        }
      }
    } else {
      tw.spawnT = tw.base ? SPAWN_BASE : SPAWN_TOWER;
    }
  }
}

function stepUnits(dt) {
  const units = game.units;
  const n = units.length;

  for (const u of units) {
    u.nearest = null;
    u.nd = UNIT_SIGHT * UNIT_SIGHT;
    u.px = 0;
    u.py = 0;
    u.atk = 0;
  }

  // One pass over every pair handles both crowd separation and target picking.
  for (let i = 0; i < n; i++) {
    const a = units[i];
    for (let j = i + 1; j < n; j++) {
      const b = units[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > UNIT_SIGHT * UNIT_SIGHT) continue;

      if (d2 < SEP_D2 && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const push = ((SEP_D - d) / d) * 0.5;
        a.px -= dx * push;
        a.py -= dy * push;
        b.px += dx * push;
        b.py += dy * push;
      }

      if (a.team !== b.team) {
        if (d2 < a.nd) { a.nd = d2; a.nearest = b; }
        if (d2 < b.nd) { b.nd = d2; b.nearest = a; }
      }
    }
  }

  for (const u of units) {
    u.cd -= dt;

    let tx = null;
    let ty = null;
    const e = u.nearest;

    if (e) {
      if (u.nd <= UNIT_RANGE * UNIT_RANGE) {
        u.atk = 1;
        if (u.cd <= 0) {
          e.hp -= UNIT_DMG;
          u.cd = UNIT_ATK_CD;
        }
      } else {
        tx = e.x;
        ty = e.y;
      }
    } else if (u.ox !== null) {
      const dx = u.ox - u.x;
      const dy = u.oy - u.y;
      if (dx * dx + dy * dy > 144) {
        tx = u.ox;
        ty = u.oy;
      } else {
        u.ox = null;
        u.oy = null;
      }
    }

    let vx = 0;
    let vy = 0;
    if (tx !== null) {
      const dx = tx - u.x;
      const dy = ty - u.y;
      const d = Math.hypot(dx, dy) || 1;
      vx = (dx / d) * UNIT_SPEED;
      vy = (dy / d) * UNIT_SPEED;
    }

    u.x += vx * dt + clamp(u.px, -3, 3);
    u.y += vy * dt + clamp(u.py, -3, 3);
    u.x = clamp(u.x, UNIT_R, WORLD_W - UNIT_R);
    u.y = clamp(u.y, UNIT_R, WORLD_H - UNIT_R);
  }

  // Minions mend near friendly towers, which makes holding ground worthwhile.
  for (const u of units) {
    if (u.hp >= UNIT_HP) continue;
    for (const tw of game.towers) {
      if (tw.owner !== u.team) continue;
      const dx = u.x - tw.x;
      const dy = u.y - tw.y;
      if (dx * dx + dy * dy < HEAL_RADIUS * HEAL_RADIUS) {
        u.hp = Math.min(UNIT_HP, u.hp + HEAL_RATE * dt);
        break;
      }
    }
  }

  if (units.some((u) => u.hp <= 0)) {
    game.units = units.filter((u) => u.hp > 0);
  }
}

function checkWin() {
  const baseA = game.towers[0];
  const baseB = game.towers[1];
  if (baseA.owner === 2) return { winner: 2, reason: 'Enemy base captured' };
  if (baseB.owner === 1) return { winner: 1, reason: 'Enemy base captured' };

  for (const team of [1, 2]) {
    if (teamTowerCount(team) === 0 && teamUnitCount(team) === 0) {
      return { winner: team === 1 ? 2 : 1, reason: 'Opponent wiped out' };
    }
  }
  return null;
}

function endGame(winner, reason) {
  if (game.state === 'over') return;
  game.state = 'over';
  game.winner = winner;
  game.reason = reason;
  game.overTimer = OVER_LINGER;
}

/* ------------------------------------------------------------------ *
 * Players / lobby
 * ------------------------------------------------------------------ */

const players = new Map(); // conn -> { team }

/* A tab that dies without a clean TCP close would otherwise hold its seat
   forever and lock the other player out. This uses WebSocket-level ping/pong,
   which browsers answer automatically, so liveness never depends on the page's
   own code still running. */
const STALE_MS = 20000;

function sweepConnections() {
  const now = Date.now();
  for (const [conn, p] of players) {
    if (now - conn.lastSeen > STALE_MS) {
      console.log('[!] dropping unresponsive connection' + (p.team ? ' (team ' + p.team + ')' : ''));
      conn.close();
    } else {
      conn.ping();
    }
  }
}

function teamTaken(team) {
  for (const p of players.values()) if (p.team === team) return true;
  return false;
}

function freeTeam() {
  if (!teamTaken(1)) return 1;
  if (!teamTaken(2)) return 2;
  return 0;
}

/* Spectators wait in the order they arrived and take the seats as they come
   free, so nobody who turned up later can jump the line. */
let joinSeq = 0;

function spectatorQueue() {
  return [...players.values()]
    .filter((p) => !p.team)
    .sort((a, b) => a.since - b.since);
}

// 1-based place in line; 0 for anyone already holding a seat
function queuePos(p) {
  return p.team ? 0 : spectatorQueue().indexOf(p) + 1;
}

/* Hands out every free seat, then tells the room who sits where - the client
   learns its team from this, having only had `hello` before. `arriving` is the
   player being connected right now, if any: it goes through the queue like
   everyone else but logs its own line in handleConnect. */
function promoteSpectators(arriving) {
  let moved = false;
  for (const p of spectatorQueue()) {
    const team = freeTeam();
    if (!team) break;
    p.team = team;
    moved = true;
    if (p !== arriving) console.log(`[*] spectator took team ${team}`);
  }
  if (moved) broadcastSeats();
  return moved;
}

function broadcastSeats() {
  for (const [conn, p] of players) {
    conn.send(JSON.stringify({ t: 'seat', you: p.team, queue: queuePos(p) }));
  }
}

function bothSeatsFilled() {
  return teamTaken(1) && teamTaken(2);
}

function broadcast(str, snapshot) {
  for (const conn of players.keys()) {
    if (snapshot) conn.sendSnapshot(str); else conn.send(str);
  }
}

/* ------------------------------------------------------------------ *
 * Main loop
 * ------------------------------------------------------------------ */

function tick(dt) {
  switch (game.state) {
    case 'lobby':
      if (bothSeatsFilled()) {
        game = newGame();
        game.state = 'countdown';
        game.countdown = COUNTDOWN;
      }
      break;

    case 'countdown':
      if (!bothSeatsFilled()) {
        game.state = 'lobby';
        break;
      }
      game.countdown -= dt;
      if (game.countdown <= 0) {
        game.countdown = 0;
        game.state = 'playing';
      }
      break;

    case 'playing': {
      game.clock += dt;
      stepTowers(dt);
      stepUnits(dt);
      const win = checkWin();
      if (win) endGame(win.winner, win.reason);
      break;
    }

    case 'over':
      game.overTimer -= dt;
      if (game.overTimer <= 0) {
        game = newGame();
        game.state = 'lobby';
      }
      break;
  }
}

function snapshotJSON() {
  const u = [];
  for (const x of game.units) {
    u.push(
      x.id,
      x.team,
      Math.round(x.x),
      Math.round(x.y),
      Math.round((x.hp / UNIT_HP) * 100),
      x.atk
    );
  }

  const w = [];
  for (const t of game.towers) {
    w.push(t.owner, Math.round(t.cap), t.pulse > 0 ? 1 : 0);
  }

  const r = game.rally;
  return JSON.stringify({
    t: 's',
    g: game.id,
    st: game.state,
    cd: Math.ceil(game.countdown),
    win: game.winner,
    why: game.reason,
    clock: Math.floor(game.clock),
    u,
    w,
    c: [teamUnitCount(1), teamUnitCount(2), teamTowerCount(1), teamTowerCount(2)],
    r: [
      r[1] ? Math.round(r[1].x) : -1, r[1] ? Math.round(r[1].y) : -1,
      r[2] ? Math.round(r[2].x) : -1, r[2] ? Math.round(r[2].y) : -1,
    ],
    seats: [teamTaken(1), teamTaken(2)],
  });
}
/* ------------------------------------------------------------------ *
 * Client messages
 * ------------------------------------------------------------------ */

function handleMessage(conn, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (err) { return; }
  const me = players.get(conn);
  if (!me) return;

  switch (m.t) {
    case 'ping':
      conn.send(JSON.stringify({ t: 'pong', i: m.i }));
      break;

    case 'cmd': {
      if (game.state !== 'playing' || !me.team) return;
      if (!Array.isArray(m.ids)) return;
      const x = clamp(Number(m.x) || 0, 0, WORLD_W);
      const y = clamp(Number(m.y) || 0, 0, WORLD_H);
      const wanted = new Set(m.ids.slice(0, MAX_UNITS * 2));
      for (const u of game.units) {
        if (u.team === me.team && wanted.has(u.id)) {
          u.ox = x;
          u.oy = y;
        }
      }
      break;
    }

    case 'rally': {
      if (!me.team) return;
      game.rally[me.team] = {
        x: clamp(Number(m.x) || 0, 0, WORLD_W),
        y: clamp(Number(m.y) || 0, 0, WORLD_H),
      };
      break;
    }

    case 'restart':
      if (game.state === 'over') game.overTimer = 0;
      break;
  }
}

function handleConnect(conn) {
  /* Everyone lands in the queue and is seated from it, so an arrival can never
     jump ahead of a spectator already waiting. */
  const me = { team: 0, since: ++joinSeq };
  players.set(conn, me);
  promoteSpectators(me);
  const team = me.team;

  conn.send(JSON.stringify({
    t: 'hello',
    you: team,
    queue: queuePos(me),
    world: { w: WORLD_W, h: WORLD_H },
    towers: TOWER_DEFS,
    tuning: { capRadius: CAP_RADIUS, unitR: UNIT_R, maxUnits: MAX_UNITS, tickHz: TICK_HZ },
  }));

  console.log(`[+] player joined as ${team ? 'team ' + team : 'spectator'} (${players.size} connected)`);

  conn.onmessage = (raw) => handleMessage(conn, raw);
  conn.onclose = () => {
    const p = players.get(conn);
    players.delete(conn);
    console.log(`[-] player left (${players.size} connected)`);
    /* The seat goes to whoever has waited longest, and they inherit the team as
       it stands. A match only ends when there is nobody in line to take over. */
    if (p && p.team) {
      const takenOver = promoteSpectators();
      if (!takenOver && (game.state === 'playing' || game.state === 'countdown')) {
        endGame(p.team === 1 ? 2 : 1, 'Opponent disconnected');
      }
    }
  };
}

  return {
    tick, snapshotJSON, handleConnect, handleMessage, sweepConnections,
    broadcast, players, TICK_HZ, STALE_MS,
    get game() { return game; },
  };
}
