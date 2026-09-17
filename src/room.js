import { createGame } from './game.js';
import { recordGame } from './stats.js';

/*
 * One Durable Object == one game room.
 *
 * The original Node server
 * hand-rolled RFC 6455 because Node has no WebSocket server, Workers has one
 * built in, so what is left here is a shim presenting the surface the game
 * logic already expects (send, sendSnapshot, ping, close, lastSeen, onmessage,
 * onclose) on top of a native WebSocket.
 *
 * The tick runs only while somebody is connected -- a Durable Object is billed
 * for wall-clock time it is alive, so an idle room must stop its timers and let
 * the object be evicted.
 */

const TICK_HZ = 20;
const SWEEP_MS = 5000;

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.g = createGame();
    this.tickTimer = null;
    this.sweepTimer = null;
    this.last = Date.now();
    // the game object is replaced on every restart, so its id is what tells us
    // a result belongs to a match we have not written down yet
    this.recordedGame = null;
  }

  async fetch(request) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.g.handleConnect(this.wrap(server));
    this.startLoop();

    return new Response(null, { status: 101, webSocket: client });
  }

  /* Adapts a native Workers WebSocket to the WSConn interface game.js uses. */
  wrap(ws) {
    const conn = {
      ws,
      closed: false,
      downed: false,
      lastSeen: Date.now(),
      onmessage: null,
      onclose: null,

      send(str) {
        try { ws.send(str); } catch { conn._downed(); }
      },

      /* The Node version dropped a snapshot when the socket had more than 256 KB
         queued. Workers exposes no equivalent of writableLength, so there is no
         backpressure signal to read -- every snapshot is sent. */
      sendSnapshot(str) {
        try { ws.send(str); } catch { conn._downed(); }
      },

      /* Was a protocol-level PING frame, which Workers will not let us send.
         Safe to drop here: the v0.1 client sends its own {t:'ping'} every 2s
         (it uses the round trip for the latency readout) and every inbound
         message refreshes lastSeen, so sweepConnections' 20s STALE_MS window
         still sees live connections as live. */
      ping() {},

      close() {
        if (conn.closed) return;
        conn.closed = true;
        try { ws.close(1000); } catch { /* already gone */ }
        conn._downed();
      },

      _downed() {
        if (conn.downed) return;
        conn.downed = true;
        conn.closed = true;
        if (conn.onclose) conn.onclose();
      },
    };

    ws.addEventListener('message', (ev) => {
      conn.lastSeen = Date.now();
      if (conn.onmessage) conn.onmessage(String(ev.data));
    });
    ws.addEventListener('close', () => { conn._downed(); this.maybeStop(); });
    ws.addEventListener('error', () => { conn._downed(); this.maybeStop(); });

    return conn;
  }

  startLoop() {
    if (this.tickTimer) return;
    this.last = Date.now();
    this.tickTimer = setInterval(() => this.step(), 1000 / TICK_HZ);
    this.sweepTimer = setInterval(() => this.g.sweepConnections(), SWEEP_MS);
  }

  /* The Node server's setInterval body verbatim. v0.1 has no per-team fog, so
     unlike v0.2 there is one snapshot for everybody and nothing to cache. */
  step() {
    const now = Date.now();
    const dt = Math.min((now - this.last) / 1000, 0.25);
    this.last = now;
    this.g.tick(dt);
    if (this.g.game.state === 'over') this.record('win');
    this.g.broadcast(this.g.snapshotJSON(), true);
  }

  /* One row per finished match, for the operator stats. Called from the tick the
     moment a winner is declared, and again when the room empties - a match
     everyone walked out of has no winner but was still time spent playing. */
  record(outcome) {
    const g = this.g.game;
    if (this.recordedGame === g.id) return;
    if (outcome === 'abandoned' && g.state !== 'playing' && g.state !== 'countdown') return;
    // a walk-out during the countdown is not a game anybody played
    if (g.clock < 1) return;
    this.recordedGame = g.id;
    const seated = [...this.g.players.values()].filter((p) => p.team);
    recordGame(this.env, this.ctx, {
      seconds: Math.round(g.clock),
      outcome,
      winner: outcome === 'win' ? (g.winner === 1 ? 'blue' : 'orange') : null,
      players: seated.length,
      detail: { why: g.reason || null },
    });
  }

  maybeStop() {
    if (this.g.players.size > 0) return;
    /* Last one out stops the tick, so this is the final chance to write the
       match down - including a win the tick has not caught yet, because
       game.js declares one from inside the very close that got us here. */
    this.record(this.g.game.state === 'over' ? 'win' : 'abandoned');
    clearInterval(this.tickTimer);
    clearInterval(this.sweepTimer);
    this.tickTimer = null;
    this.sweepTimer = null;
  }
}
