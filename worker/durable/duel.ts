import { DurableObject } from 'cloudflare:workers';
import { overlayStub, type Env } from '../env';
import {
  SIDE_KEYS, type ChannelRef, type ChatMessage, type DuelChannel, type DuelFormat, type DuelMode, type DuelSide,
  type DuelSideState, type DuelState, type Side, type TopChatter,
} from '../../shared/types';
import { CHATTER_NOISE, fakeChatter, parseVote } from './chat';
import { aiDuelLine, duelAiChannels } from '../lib/cohost';

export interface DuelInit {
  id: string;
  format?: DuelFormat; // default 1v1
  mode: DuelMode;
  question: string;
  options: string[];
  durationS: number;
  raceTarget?: number;
  teamNames?: [string, string];
  /** Host; always side a. */
  a: ChannelRef;
  /** 1v1 opponent (legacy shape). Ignored when `invites` is given. */
  b?: ChannelRef;
  invites?: { channel: ChannelRef; side: Side }[];
  demo: boolean;
}

const COUNTDOWN_MS = 5_000;
const PULL_COOLDOWN_MS = 1_500;
const SIM_TICK_MS = 1_000;
const FEED_MAX = 14;
const TOP_PER_SIDE = 3;

const ACTIVE = (c: DuelChannel) => c.invite === 'host' || c.invite === 'accepted';

/**
 * One DuelDO per duel (1v1, free-for-all or teams). Holds the shared board, counts votes from every
 * participating channel's chat (deduped per voter in DO SQLite), runs the timer with alarms, and pushes
 * state to every connected overlay/board over hibernating WebSockets.
 */
export class DuelDO extends DurableObject<Env> {
  private s: DuelState | null = null;
  private momentum: Record<string, number> = {};
  private teamNames: [string, string] = ['Team A', 'Team B'];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = (await ctx.storage.get<DuelState>('state')) ?? null;
      this.teamNames = (await ctx.storage.get<[string, string]>('teamNames')) ?? this.teamNames;
      this.s = stored ? upgrade(stored) : null;
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
    this.refreshTop();
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
    const format: DuelFormat = init.format ?? '1v1';
    const invites = init.invites ?? (init.b ? [{ channel: init.b, side: 'b' as Side }] : []);
    const ch = (c: ChannelRef, side: Side, invite: DuelChannel['invite']): DuelChannel =>
      ({ ...c, side, invite, score: 0, voters: 0, poll: init.options.map(() => 0) });
    if (init.teamNames) {
      this.teamNames = init.teamNames;
      await this.ctx.storage.put('teamNames', this.teamNames);
    }
    const now = Date.now();
    const blank = (c: ChannelRef): DuelSide => ({ ...c, score: 0, voters: 0, poll: init.options.map(() => 0) });
    this.s = {
      id: init.id, format, mode: init.mode, status: 'pending', question: init.question, options: init.options,
      durationS: init.durationS, raceTarget: format === 'ffa' && init.mode === 'tug' ? (init.raceTarget ?? 0) : 0,
      createdAt: now, hostId: init.a.id,
      channels: [ch(init.a, 'a', 'host'), ...invites.map((i) => ch(i.channel, i.side, 'pending'))],
      sides: [], top: [], a: blank(init.a), b: blank(invites[0]?.channel ?? init.a),
      feed: [], simulate: false, demo: init.demo, serverNow: now,
    };
    this.recompute();
    await this.save();
    return this.snapshot();
  }

  async getState(): Promise<DuelState | null> {
    return this.s ? this.snapshot() : null;
  }

  /**
   * An invited channel accepts or declines. `channelIds` omitted = every pending invitee (1v1: the opponent).
   * The duel becomes `accepted` (startable) once at least two sides have an active channel, and `declined`
   * once nobody is pending and that can no longer happen.
   */
  async respond(accept: boolean, channelIds?: string[]): Promise<DuelState> {
    const s = this.need();
    if (s.status !== 'pending' && s.status !== 'accepted') throw new Error(`duel is ${s.status}`);
    const targets = s.channels.filter((c) => c.invite === 'pending' && (!channelIds || channelIds.includes(c.id)));
    if (!targets.length) {
      const c = channelIds && s.channels.find((x) => channelIds.includes(x.id));
      throw new Error(c ? `invite already ${c.invite}` : 'no pending invite');
    }
    const now = Date.now();
    for (const c of targets) c.invite = accept ? 'accepted' : 'declined';
    const ready = this.readySides();
    const pending = s.channels.some((c) => c.invite === 'pending');
    if (ready >= 2) s.status = 'accepted';
    else if (!pending) s.status = 'declined';
    this.recompute();
    await this.save();
    await this.env.DB.batch([
      this.env.DB.prepare('UPDATE duels SET status = ? WHERE id = ?').bind(s.status, s.id),
      ...targets.map((c) => this.env.DB.prepare('UPDATE duel_channels SET status = ?, responded_at = ? WHERE duel_id = ? AND channel_id = ?')
        .bind(c.invite, now, s.id, c.id)),
    ]);
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
    // Anyone who hasn't answered by now sits this one out.
    const dropped = s.channels.filter((c) => c.invite === 'pending');
    for (const c of dropped) c.invite = 'dropped';
    s.status = 'countdown';
    s.countdownEndsAt = Date.now() + COUNTDOWN_MS;
    this.recompute();
    await this.save();
    await this.env.DB.batch([
      this.env.DB.prepare('UPDATE duels SET status = ?, started_at = ? WHERE id = ?').bind(s.status, s.countdownEndsAt, s.id),
      ...dropped.map((c) => this.env.DB.prepare("UPDATE duel_channels SET status = 'dropped' WHERE duel_id = ? AND channel_id = ?").bind(s.id, c.id)),
    ]);
    await this.ctx.storage.setAlarm(s.countdownEndsAt);
    await this.notifyOverlays(s.id);
    this.broadcast();
    return this.snapshot();
  }

  /** Demo only: toggles the built-in chat simulator for every channel in the duel. */
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
  async ingest(channelId: string, msgs: ChatMessage[]): Promise<{ counted: number; status: string; side?: Side }> {
    const s = this.s;
    if (!s || s.status !== 'live') return { counted: 0, status: s?.status ?? 'missing' };
    const ch = s.channels.find((c) => c.id === channelId && ACTIVE(c));
    if (!ch) return { counted: 0, status: s.status };
    let counted = 0;
    for (const m of msgs) if (this.applyVote(ch, m.userId, m.login, m.text, m.at || Date.now())) counted++;
    if (counted) {
      this.recompute();
      if (this.raceWinner()) { await this.finish(); return { counted, status: 'finished', side: ch.side }; }
      await this.save();
      this.broadcast();
    }
    return { counted, status: s.status, side: ch.side };
  }

  private applyVote(ch: DuelChannel, voterId: string, login: string, text: string, at: number): boolean {
    const s = this.s!;
    const side = ch.side;
    const vote = parseVote(s.mode, text, s.options.length);
    if (!vote) return false;
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ side: string; channel_id: string; choice: number | null; last_at: number }>(
      'SELECT side, channel_id, choice, last_at FROM votes WHERE voter_id = ?', voterId).toArray()[0];
    // A chatter's first message pins them to a side: no double agents across rival chats.
    // (Teammates' chats share a side, so a chatter hopping between them still counts for that team.)
    if (row && row.side !== side) return false;
    if (vote.kind === 'pull') {
      if (row && at - row.last_at < PULL_COOLDOWN_MS) return false;
      if (row) sql.exec('UPDATE votes SET pulls = pulls + 1, last_at = ? WHERE voter_id = ?', at, voterId);
      else {
        sql.exec('INSERT INTO votes (voter_id, login, channel_id, side, pulls, first_at, last_at) VALUES (?, ?, ?, ?, 1, ?, ?)', voterId, login, ch.id, side, at, at);
        ch.voters++;
      }
      ch.score++; // pulls count for the chat they were typed in
    } else {
      if (row?.choice === vote.option) return false;
      // A voter belongs to the channel they first voted from.
      const home = row ? s.channels.find((c) => c.id === row.channel_id) ?? ch : ch;
      if (row) {
        if (row.choice !== null) home.poll[row.choice]--;
        sql.exec('UPDATE votes SET choice = ?, last_at = ? WHERE voter_id = ?', vote.option, at, voterId);
      } else {
        sql.exec('INSERT INTO votes (voter_id, login, channel_id, side, choice, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)', voterId, login, ch.id, side, vote.option, at, at);
        home.voters++;
        home.score = home.voters;
      }
      home.poll[vote.option]++;
    }
    s.feed.unshift({ side, login, channel: ch.login, text: vote.kind === 'pull' ? 'PULL!' : `voted ${vote.option + 1}`, at });
    if (s.feed.length > FEED_MAX) s.feed.length = FEED_MAX;
    return true;
  }

  /** Rebuild per-side totals (and the legacy a/b mirrors) from the channels. */
  private recompute() {
    const s = this.s!;
    const sides: DuelSideState[] = [];
    for (const key of SIDE_KEYS) {
      const chans = s.channels.filter((c) => c.side === key && ACTIVE(c));
      const all = s.channels.filter((c) => c.side === key);
      if (!all.length) continue;
      const name = s.format === 'teams' ? this.teamNames[key === 'a' ? 0 : 1] : (chans[0] ?? all[0]).displayName;
      const sum = (f: (c: DuelChannel) => number) => chans.reduce((t, c) => t + f(c), 0);
      sides.push({
        key, name, score: sum((c) => c.score), voters: sum((c) => c.voters),
        poll: s.options.map((_, i) => sum((c) => c.poll[i] ?? 0)), channelIds: chans.map((c) => c.id),
      });
    }
    s.sides = sides;
    const mirror = (key: Side, prev: DuelSide): DuelSide => {
      const side = sides.find((x) => x.key === key);
      const lead = s.channels.find((c) => c.side === key && ACTIVE(c)) ?? s.channels.find((c) => c.side === key);
      if (!side || !lead) return prev;
      const ref: ChannelRef = { id: lead.id, login: lead.login, displayName: lead.displayName, avatarUrl: lead.avatarUrl };
      return { ...ref, displayName: s.format === 'teams' ? side.name : lead.displayName, score: side.score, voters: side.voters, poll: side.poll };
    };
    s.a = mirror('a', s.a);
    s.b = mirror('b', s.b);
  }

  /** Sides that have at least one channel in (host or accepted). */
  private readySides(): number {
    const keys = new Set(this.s!.channels.filter(ACTIVE).map((c) => c.side));
    return keys.size;
  }

  /** Free-for-all race: the first lane to reach the finish line wins on the spot. */
  private raceWinner(): Side | null {
    const s = this.s!;
    if (s.format !== 'ffa' || s.mode !== 'tug' || !s.raceTarget) return null;
    const done = s.sides.filter((x) => x.channelIds.length && x.score >= s.raceTarget);
    return done.length ? done.sort((x, y) => y.score - x.score)[0].key : null;
  }

  private refreshTop() {
    const s = this.s!;
    if (!['live', 'finished', 'countdown'].includes(s.status)) { s.top = []; return; }
    const logins = new Map(s.channels.map((c) => [c.id, c.login]));
    const top: TopChatter[] = [];
    for (const side of s.sides) {
      const rows = this.ctx.storage.sql.exec<{ login: string; channel_id: string; n: number }>(
        s.mode === 'tug'
          ? 'SELECT login, channel_id, pulls AS n FROM votes WHERE side = ? ORDER BY pulls DESC, first_at ASC LIMIT ?'
          : 'SELECT login, channel_id, 1 AS n FROM votes WHERE side = ? ORDER BY first_at ASC LIMIT ?',
        side.key, TOP_PER_SIDE).toArray();
      for (const r of rows) top.push({ side: side.key, login: r.login, channelLogin: logins.get(r.channel_id) ?? '', count: r.n });
    }
    s.top = top;
  }

  async alarm(): Promise<void> {
    const s = this.s;
    if (!s) return;
    const now = Date.now();
    let wentLive = false;
    if (s.status === 'countdown' && now >= (s.countdownEndsAt ?? 0)) {
      s.status = 'live';
      s.endsAt = now + s.durationS * 1000;
      wentLive = true;
      await this.setDbStatus();
      await this.notifyOverlays(s.id);
    }
    if (s.status === 'live' && now >= (s.endsAt ?? 0)) {
      await this.finish();
      return;
    }
    if (s.status === 'live' && s.simulate) {
      this.simulateTick(now);
      this.recompute();
      if (this.raceWinner()) { await this.finish(); return; }
    }
    await this.save();
    this.broadcast();
    if (s.status === 'countdown') await this.ctx.storage.setAlarm(s.countdownEndsAt!);
    else if (s.status === 'live') await this.ctx.storage.setAlarm(s.simulate ? Math.min(now + SIM_TICK_MS, s.endsAt!) : s.endsAt!);
    if (wentLive) await this.hostLines('start');
  }

  /**
   * AI duel host: one line (round start / result) generated once, then posted by each participating
   * channel's OverlayDO, which applies that channel's toggle, 20s gap and daily cap. Never throws.
   */
  private async hostLines(kind: 'start' | 'finish'): Promise<void> {
    try {
      const s = this.s!;
      const active = s.channels.filter(ACTIVE);
      const on = await duelAiChannels(this.env, active.map((c) => c.id));
      if (!on.size) return;
      const winner = s.winner && s.winner !== 'tie' ? s.sides.find((x) => x.key === s.winner)?.name ?? null : null;
      const line = await aiDuelLine(this.env, {
        kind, format: s.format, mode: s.mode, question: s.question, options: s.options, durationS: s.durationS,
        sides: s.sides.filter((x) => x.channelIds.length).map((x) => ({ name: x.name, score: x.score })), winner, tie: s.winner === 'tie',
      });
      await Promise.allSettled(active.filter((c) => on.has(c.id)).map((c) =>
        overlayStub(this.env, c.login).duelLine({ id: c.id, login: c.login, displayName: c.displayName }, line.text)));
    } catch (e) {
      console.warn('duel host line failed', (e as Error).message);
    }
  }

  /** DEMO chat simulator: every channel's chat sends a burst of commands and noise each second. */
  private simulateTick(now: number) {
    const s = this.s!;
    const active = s.channels.filter(ACTIVE);
    for (const [idx, ch] of active.entries()) {
      // Each chat drifts between hype and lull, so leads change hands.
      const m = this.momentum[ch.id] = Math.max(-1, Math.min(1, (this.momentum[ch.id] ?? 0) + (Math.random() - 0.5) * 0.6));
      // Teams: split a team's energy across its channels so a 4-channel team isn't 4x louder per channel.
      const mates = s.format === 'teams' ? active.filter((c) => c.side === ch.side).length : 1;
      const n = Math.round(((2 + Math.random() * 5) * (1 + m * 0.5)) / Math.sqrt(mates));
      // Each simulated chat has its own audience size (40-89 chatters), stable per duel.
      const pool = 40 + ([...(s.id + ch.id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 50);
      const skew = 0.7 + (idx % 4) * 0.25;
      for (let i = 0; i < n; i++) {
        const who = fakeChatter(Math.floor(Math.random() * pool) + idx * 1000, ch.id);
        const text = Math.random() < 0.15
          ? CHATTER_NOISE[Math.floor(Math.random() * CHATTER_NOISE.length)]
          : s.mode === 'tug' ? (Math.random() < 0.7 ? '!pull' : 'pull')
          : `!${1 + Math.min(s.options.length - 1, Math.floor(Math.random() ** skew * s.options.length))}`;
        this.applyVote(ch, who.id, who.login, text, now + i);
      }
    }
  }

  private async finish(): Promise<void> {
    const s = this.s!;
    s.status = 'finished';
    s.endedAt = Date.now();
    s.simulate = false;
    this.recompute();
    const live = s.sides.filter((x) => x.channelIds.length);
    const best = Math.max(...live.map((x) => x.score));
    const leaders = live.filter((x) => x.score === best);
    s.winner = leaders.length === 1 ? leaders[0].key : 'tie';
    await this.save();
    await this.ctx.storage.deleteAlarm();
    const results = JSON.stringify(s.sides.map((x) => ({ key: x.key, name: x.name, score: x.score, voters: x.voters, channels: x.channelIds.length })));
    await this.env.DB.batch([
      this.env.DB.prepare(
        'UPDATE duels SET status = ?, winner = ?, score_a = ?, score_b = ?, voters_a = ?, voters_b = ?, ended_at = ?, results = ? WHERE id = ?',
      ).bind(s.status, s.winner, s.a.score, s.b.score, s.a.voters, s.b.voters, s.endedAt, results, s.id),
      ...s.channels.filter(ACTIVE).map((c) => this.env.DB.prepare('UPDATE duel_channels SET score = ?, voters = ? WHERE duel_id = ? AND channel_id = ?')
        .bind(c.score, c.voters, s.id, c.id)),
    ]);
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
    // finish() can run inside a chat ingest (race finish line): don't hold chat up for the model.
    this.ctx.waitUntil(this.hostLines('finish'));
  }

  /** Tell every participating channel's OverlayDO which duel to show (or to drop it). */
  private async notifyOverlays(duelId: string | null, status?: DuelState['status']) {
    const s = this.s!;
    const logins = s.channels.filter(ACTIVE).map((c) => c.login);
    await Promise.allSettled(logins.map((login) =>
      overlayStub(this.env, login).setActiveDuel(duelId ?? s.id, duelId === null, status ?? s.status)));
  }

  private need(): DuelState {
    if (!this.s) throw new Error('duel not found');
    return this.s;
  }
}

/** State saved before multi-channel duels existed: rebuild channels/sides from a/b. */
function upgrade(s: DuelState): DuelState {
  if (s.channels) return s;
  const legacy = s as DuelState;
  const bInvite = legacy.status === 'pending' ? 'pending' : legacy.status === 'declined' ? 'declined' : 'accepted';
  const strip = ({ id, login, displayName, avatarUrl, score, voters, poll }: DuelSide) => ({ id, login, displayName, avatarUrl, score, voters, poll });
  return {
    ...legacy, format: '1v1', raceTarget: 0, hostId: legacy.a.id, top: [],
    channels: [{ ...strip(legacy.a), side: 'a', invite: 'host' }, { ...strip(legacy.b), side: 'b', invite: bInvite }],
    sides: (['a', 'b'] as const).map((k) => ({ key: k, name: legacy[k].displayName, score: legacy[k].score, voters: legacy[k].voters, poll: legacy[k].poll, channelIds: [legacy[k].id] })),
  };
}
