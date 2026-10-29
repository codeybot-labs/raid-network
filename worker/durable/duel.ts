import { DurableObject } from 'cloudflare:workers';
import { overlayStub, type Env } from '../env';
import type { ChannelRef, ChatMessage, DuelMode, DuelState, Side } from '../../shared/types';
import { CHATTER_NOISE, fakeChatter, parseVote } from './chat';

export interface DuelInit {
  id: string;
  mode: DuelMode;
  question: string;
  options: string[];
  durationS: number;
  a: ChannelRef;
  b: ChannelRef;
  demo: boolean;
}

const COUNTDOWN_MS = 5_000;
const PULL_COOLDOWN_MS = 1_500;
const SIM_TICK_MS = 1_000;
const FEED_MAX = 14;

/**
 * One DuelDO per duel. Holds the shared board, counts votes from both channels' chats
 * (deduped per voter in DO SQLite), runs the timer with alarms, and pushes state to every
 * connected overlay/board over hibernating WebSockets.
 */
export class DuelDO extends DurableObject<Env> {
  private s: DuelState | null = null;
  private momentum = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get<DuelState>('state')) ?? null;
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS votes (
        voter_id TEXT PRIMARY KEY, login TEXT NOT NULL, channel_id TEXT NOT NULL, side TEXT NOT NULL,
        choice INTEGER, pulls INTEGER NOT NULL DEFAULT 0, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL)`);
    });
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ---------- WebSocket (hibernation API) ----------
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    if (this.s) pair[1].send(JSON.stringify({ type: 'state', state: this.snapshot() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (msg === 'state' && this.s) ws.send(JSON.stringify({ type: 'state', state: this.snapshot() }));
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code, 'closing'); } catch { /* already closed */ }
  }

  private snapshot(): DuelState {
    return { ...this.s!, serverNow: Date.now() };
  }

  private broadcast(): void {
    if (!this.s) return;
    const payload = JSON.stringify({ type: 'state', state: this.snapshot() });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch { /* socket gone */ }
    }
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put('state', this.s);
  }

  private async setDbStatus(extra: string = '', ...binds: unknown[]) {
    await this.env.DB.prepare(`UPDATE duels SET status = ?${extra} WHERE id = ?`).bind(this.s!.status, ...binds, this.s!.id).run();
  }

  // ---------- RPC ----------
  async init(init: DuelInit): Promise<DuelState> {
    if (this.s) return this.snapshot();
    const side = (c: ChannelRef) => ({ ...c, score: 0, voters: 0, poll: init.options.map(() => 0) });
    this.s = {
      id: init.id, mode: init.mode, status: 'pending', question: init.question, options: init.options,
      durationS: init.durationS, createdAt: Date.now(), a: side(init.a), b: side(init.b), feed: [],
      simulate: false, demo: init.demo, serverNow: Date.now(),
    };
    await this.save();
    return this.snapshot();
  }

  async getState(): Promise<DuelState | null> {
    return this.s ? this.snapshot() : null;
  }

  async respond(accept: boolean): Promise<DuelState> {
    const s = this.need();
    if (s.status !== 'pending') throw new Error(`duel is ${s.status}`);
    s.status = accept ? 'accepted' : 'declined';
    await this.save();
    await this.setDbStatus();
    this.broadcast();
    return this.snapshot();
  }

  async cancel(): Promise<DuelState> {
    const s = this.need();
    if (s.status === 'finished') throw new Error('duel already finished');
    s.status = 'cancelled';
    await this.ctx.storage.deleteAlarm();
    await this.save();
    await this.setDbStatus();
    await this.notifyOverlays(null);
    this.broadcast();
    return this.snapshot();
  }

  async start(): Promise<DuelState> {
    const s = this.need();
    if (s.status !== 'accepted') throw new Error(`duel must be accepted first (is ${s.status})`);
    s.status = 'countdown';
    s.countdownEndsAt = Date.now() + COUNTDOWN_MS;
    await this.save();
    await this.setDbStatus(', started_at = ?', s.countdownEndsAt);
    await this.ctx.storage.setAlarm(s.countdownEndsAt);
    await this.notifyOverlays(s.id);
    this.broadcast();
    return this.snapshot();
  }

  /** Demo only: toggles the built-in chat simulator for both channels. */
  async setSimulate(on: boolean): Promise<DuelState> {
    const s = this.need();
    if (!s.demo) throw new Error('simulator is only available in DEMO_MODE');
    s.simulate = on;
    await this.save();
    if (on && s.status === 'live') await this.ctx.storage.setAlarm(Date.now() + 200);
    this.broadcast();
    return this.snapshot();
  }

  /** Chat messages from one channel (batched). Returns how many counted as votes. */
  async ingest(channelId: string, msgs: ChatMessage[]): Promise<{ counted: number; status: string }> {
    const s = this.s;
    if (!s || s.status !== 'live') return { counted: 0, status: s?.status ?? 'missing' };
    const side: Side | null = channelId === s.a.id ? 'a' : channelId === s.b.id ? 'b' : null;
    if (!side) return { counted: 0, status: s.status };
    let counted = 0;
    for (const m of msgs) if (this.applyVote(side, channelId, m.userId, m.login, m.text, m.at || Date.now())) counted++;
    if (counted) {
      await this.save();
      this.broadcast();
    }
    return { counted, status: s.status };
  }

  private applyVote(side: Side, channelId: string, voterId: string, login: string, text: string, at: number): boolean {
    const s = this.s!;
    const vote = parseVote(s.mode, text, s.options.length);
    if (!vote) return false;
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ side: string; choice: number | null; last_at: number }>(
      'SELECT side, choice, last_at FROM votes WHERE voter_id = ?', voterId).toArray()[0];
    // A chatter's first message pins them to a side: no double agents across both chats.
    if (row && row.side !== side) return false;
    const me = s[side];
    if (vote.kind === 'pull') {
      if (row && at - row.last_at < PULL_COOLDOWN_MS) return false;
      if (row) sql.exec('UPDATE votes SET pulls = pulls + 1, last_at = ? WHERE voter_id = ?', at, voterId);
      else {
        sql.exec('INSERT INTO votes (voter_id, login, channel_id, side, pulls, first_at, last_at) VALUES (?, ?, ?, ?, 1, ?, ?)', voterId, login, channelId, side, at, at);
        me.voters++;
      }
      me.score++;
    } else {
      if (row?.choice === vote.option) return false;
      if (row) {
        if (row.choice !== null) me.poll[row.choice]--;
        sql.exec('UPDATE votes SET choice = ?, last_at = ? WHERE voter_id = ?', vote.option, at, voterId);
      } else {
        sql.exec('INSERT INTO votes (voter_id, login, channel_id, side, choice, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)', voterId, login, channelId, side, vote.option, at, at);
        me.voters++;
        me.score = me.voters;
      }
      me.poll[vote.option]++;
    }
    s.feed.unshift({ side, login, text: vote.kind === 'pull' ? 'PULL!' : `voted ${vote.option + 1}`, at });
    if (s.feed.length > FEED_MAX) s.feed.length = FEED_MAX;
    return true;
  }

  async alarm(): Promise<void> {
    const s = this.s;
    if (!s) return;
    const now = Date.now();
    if (s.status === 'countdown' && now >= (s.countdownEndsAt ?? 0)) {
      s.status = 'live';
      s.endsAt = now + s.durationS * 1000;
      await this.setDbStatus();
      await this.notifyOverlays(s.id);
    }
    if (s.status === 'live' && now >= (s.endsAt ?? 0)) {
      await this.finish();
      return;
    }
    if (s.status === 'live' && s.simulate) this.simulateTick(now);
    await this.save();
    this.broadcast();
    if (s.status === 'countdown') await this.ctx.storage.setAlarm(s.countdownEndsAt!);
    else if (s.status === 'live') await this.ctx.storage.setAlarm(s.simulate ? Math.min(now + SIM_TICK_MS, s.endsAt!) : s.endsAt!);
  }

  /** DEMO chat simulator: both chats send a burst of commands and noise every second. */
  private simulateTick(now: number) {
    const s = this.s!;
    this.momentum = Math.max(-1, Math.min(1, this.momentum + (Math.random() - 0.5) * 0.6));
    for (const side of ['a', 'b'] as const) {
      const ref = s[side];
      const energy = side === 'a' ? 1 + this.momentum * 0.5 : 1 - this.momentum * 0.5;
      const n = Math.round((2 + Math.random() * 5) * energy);
      for (let i = 0; i < n; i++) {
        // Each simulated chat has its own audience size (40-89 chatters), stable per duel.
        const pool = 40 + ([...(s.id + side)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 50);
        const who = fakeChatter(Math.floor(Math.random() * pool) + (side === 'a' ? 0 : 1000), side);
        const text = Math.random() < 0.15
          ? CHATTER_NOISE[Math.floor(Math.random() * CHATTER_NOISE.length)]
          : s.mode === 'tug' ? (Math.random() < 0.7 ? '!pull' : 'pull')
          : `!${1 + Math.min(s.options.length - 1, Math.floor(Math.random() ** (side === 'a' ? 1.4 : 0.8) * s.options.length))}`;
        this.applyVote(side, ref.id, who.id, who.login, text, now + i);
      }
    }
  }

  private async finish(): Promise<void> {
    const s = this.s!;
    s.status = 'finished';
    s.endedAt = Date.now();
    s.simulate = false;
    s.winner = s.a.score === s.b.score ? 'tie' : s.a.score > s.b.score ? 'a' : 'b';
    await this.save();
    await this.env.DB.prepare(
      'UPDATE duels SET status = ?, winner = ?, score_a = ?, score_b = ?, voters_a = ?, voters_b = ?, ended_at = ? WHERE id = ?',
    ).bind(s.status, s.winner, s.a.score, s.b.score, s.a.voters, s.b.voters, s.endedAt, s.id).run();
    // Persist votes to D1 in one go (they lived in DO storage while the duel ran).
    const votes = this.ctx.storage.sql.exec<{ voter_id: string; login: string; channel_id: string; side: string; choice: number | null; pulls: number; first_at: number }>(
      'SELECT voter_id, login, channel_id, side, choice, pulls, first_at FROM votes').toArray();
    const stmt = this.env.DB.prepare(
      'INSERT OR REPLACE INTO duel_votes (duel_id, voter_id, voter_login, channel_id, side, choice, weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < votes.length; i += 100) {
      await this.env.DB.batch(votes.slice(i, i + 100).map((v) =>
        stmt.bind(s.id, v.voter_id, v.login, v.channel_id, v.side, v.choice === null ? null : String(v.choice), Math.max(1, v.pulls), v.first_at)));
    }
    await this.notifyOverlays(null, 'finished');
    this.broadcast();
  }

  private async notifyOverlays(duelId: string | null, status?: DuelState['status']) {
    const s = this.s!;
    await Promise.allSettled([s.a.login, s.b.login].map((login) =>
      overlayStub(this.env, login).setActiveDuel(duelId ?? s.id, duelId === null, status ?? s.status)));
  }

  private need(): DuelState {
    if (!this.s) throw new Error('duel not found');
    return this.s;
  }
}
