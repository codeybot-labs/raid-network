import { DurableObject } from 'cloudflare:workers';
import { duelStub, isDemo, type Env } from '../env';
import type { AiChatStatus, AiFeature, AiSettings, BotMessageStatus, ChannelRef, ChatMessage, ClipInfo, DuelStatus, OverlayEvent, RaidWelcome, StreamInfo, TimelinePoint } from '../../shared/types';
import { isBlocked } from '../lib/ai';
import { sendBotChat } from '../lib/chatbot';
import { aiAsk, aiRecap, aiWelcome, getAiSettings, templateWelcome, utcDay, type AskCtx } from '../lib/cohost';
import { makeClip } from '../lib/clips';
import { demoFindStream, demoStreams, ensureDemoSeed } from '../lib/demo';
import { DEMO_POOL_AFTER_SEED, ensureDemoGrowthSeed, recapMessage, streamReport, synthStreamActivity } from '../lib/growth';
import { getChannelInfo, getStreamByUser } from '../lib/helix';
import { HypeDetector, type HypeCheck } from '../lib/hype';

/** The live broadcast this channel is in right now (one `streams` row in D1). */
interface Session {
  streamId: string;
  channelId: string;
  login: string;
  startedAt: number;
  title: string | null;
  gameName: string | null;
  peakViewers: number;
  messages: number;
  lastClipAt: number;
  lastRecapAt: number;
  source: 'live' | 'demo';
}

const FLUSH_MS = 60_000;
const RECAP_COOLDOWN_MS = 60_000;
const WELCOME_REPEAT_MS = 5 * 60_000;
const OFFLINE_RECHECK_MS = 5 * 60_000;
const TIMELINE_MAX = 24 * 60;
/** AI chat rate limits: at most one AI message per channel every 20s, one !ask answer per viewer per minute. */
export const AI_MIN_GAP_MS = 20_000;
export const ASK_USER_COOLDOWN_MS = 60_000;
const AI_SETTINGS_TTL_MS = 30_000;

interface AiState { lastAt: number; day: string; count: number }

export interface ChatResult {
  routed: number;
  counted: number;
  duelId: string | null;
  streamId: string | null;
  hype: HypeCheck | null;
  clip: ClipInfo | null;
  recap: { status: BotMessageStatus; text?: string; ai?: boolean } | null;
  ask: { status: AiChatStatus; text?: string; ai?: boolean } | null;
}

/**
 * One OverlayDO per channel (keyed by login). It holds the OBS browser source's hibernating
 * WebSocket (/overlay/:channel) and is the channel's chat brain:
 *  - routes chat into the active DuelDO,
 *  - tracks the current stream session (chatters, per-minute timeline) and flushes it to D1 about once a minute,
 *  - runs the hype detector → auto-clip (Helix POST /clips) → clip card,
 *  - welcomes raiders (overlay card + chat shout-out via Helix POST /chat/messages),
 *  - answers !recap with a per-channel cooldown.
 */
export class OverlayDO extends DurableObject<Env> {
  private channel = '';
  private channelId = '';
  private activeDuelId: string | null = null;
  private seen = new Set<string>(); // recent EventSub chat message ids (Twitch may redeliver)
  private session: Session | null = null;
  private timeline: TimelinePoint[] = [];
  private curUsers = new Set<string>();
  private pending = new Map<string, { login: string; n: number }>();
  private hype = new HypeDetector();
  private sessionInit: Promise<Session | null> | null = null;
  private offlineCheckedAt = 0;
  private demoOffline = false;
  private lastActivityAt = 0;
  private welcomed = new Map<string, number>();
  private ai: AiState = { lastAt: 0, day: '', count: 0 };
  private askCooldown = new Map<string, number>();
  private aiSettings: { at: number; s: AiSettings } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const got = await ctx.storage.get(['channel', 'channelId', 'activeDuelId', 'session', 'timeline', 'demoOffline', 'ai']);
      this.ai = (got.get('ai') as AiState) ?? this.ai;
      this.channel = (got.get('channel') as string) ?? '';
      this.channelId = (got.get('channelId') as string) ?? '';
      this.activeDuelId = (got.get('activeDuelId') as string) ?? null;
      this.session = (got.get('session') as Session) ?? null;
      this.timeline = (got.get('timeline') as TimelinePoint[]) ?? [];
      this.demoOffline = !!got.get('demoOffline');
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    await this.setChannel({ login: new URL(req.url).searchParams.get('channel') ?? '' });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: 'hello', channel: this.channel, activeDuelId: this.activeDuelId } satisfies OverlayEvent));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code, 'closing'); } catch { /* already closed */ }
  }

  private push(ev: OverlayEvent) {
    const payload = JSON.stringify(ev);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch { /* gone */ }
    }
  }

  private async setChannel(ref: { login?: string; id?: string }) {
    const login = ref.login?.toLowerCase();
    if (login && login !== this.channel) { this.channel = login; await this.ctx.storage.put('channel', login); }
    if (ref.id && ref.id !== this.channelId) { this.channelId = ref.id; await this.ctx.storage.put('channelId', ref.id); }
  }

  // ---------------------------------------------------------------- sessions ----------------------------------------------------------------

  /** Current stream session; starts one lazily (demo: from the fake stream; live: Helix GET /streams). */
  private async ensureSession(): Promise<Session | null> {
    if (this.session) return this.session;
    if (!this.channelId || !this.channel) return null;
    if (!this.sessionInit) {
      this.sessionInit = (isDemo(this.env) ? this.startDemoSession() : this.startLiveSessionFromHelix())
        .catch((e) => { console.error('session start failed', e); return null; })
        .finally(() => { this.sessionInit = null; });
    }
    return this.sessionInit;
  }

  private async startLiveSessionFromHelix(): Promise<Session | null> {
    if (Date.now() - this.offlineCheckedAt < OFFLINE_RECHECK_MS) return null;
    const cached = await this.env.KV.get<StreamInfo | { offline: true }>(`me:stream:${this.channelId}`, 'json');
    const stream = cached && !('offline' in cached) ? cached : await getStreamByUser(this.env, this.channelId);
    if (!stream) { this.offlineCheckedAt = Date.now(); return null; }
    return this.startSession({ streamId: stream.streamId, startedAt: Date.parse(stream.startedAt), title: stream.title, gameName: stream.gameName, source: 'live' });
  }

  /** Demo: seeds past streams for the growth page, then a session whose earlier minutes are synthesized. */
  private async startDemoSession(): Promise<Session | null> {
    if (this.demoOffline) return null;
    const s = demoFindStream(this.channel);
    if (!s) return null;
    await ensureDemoSeed(this.env);
    const rivals = demoStreams(s.gameId).streams.filter((x) => x.id !== s.id).slice(0, 8);
    await ensureDemoGrowthSeed(this.env, { ...s, baseViewers: s.viewerCount }, rivals);
    const startedAt = Date.parse(s.startedAt);
    const streamId = `demo-${s.login}-${startedAt}`;
    const act = await synthStreamActivity(this.env, {
      channelId: s.id, streamId, startedAt, endedAt: Date.now(), baseViewers: s.viewerCount, seed: startedAt, poolStart: DEMO_POOL_AFTER_SEED,
    });
    return this.startSession({ streamId, startedAt, title: s.title, gameName: s.gameName, source: 'demo', timeline: act.timeline, messages: act.messages, peak: act.peak });
  }

  private async startSession(o: { streamId: string; startedAt: number; title?: string | null; gameName?: string | null; source: Session['source']; timeline?: TimelinePoint[]; messages?: number; peak?: number }): Promise<Session> {
    if (this.session?.streamId === o.streamId) return this.session;
    if (this.session) await this.endSession();
    const now = Date.now();
    this.session = {
      streamId: o.streamId, channelId: this.channelId, login: this.channel, startedAt: o.startedAt, title: o.title ?? null, gameName: o.gameName ?? null,
      peakViewers: o.peak ?? 0, messages: o.messages ?? 0, lastClipAt: 0, lastRecapAt: 0, source: o.source,
    };
    this.timeline = o.timeline ?? [];
    this.curUsers.clear();
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO streams (id, channel_id, channel_login, title, game_name, started_at, peak_viewers, messages, timeline, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(o.streamId, this.channelId, this.channel, this.session.title, this.session.gameName, o.startedAt, this.session.peakViewers,
      this.session.messages, JSON.stringify(this.timeline), o.source, now).run();
    await this.ctx.storage.put({ session: this.session, timeline: this.timeline });
    return this.session;
  }

  private async endSession(): Promise<string | null> {
    const s = this.session;
    if (!s) return null;
    await this.flush();
    await this.env.DB.prepare('UPDATE streams SET ended_at = ?, updated_at = ? WHERE id = ?').bind(Date.now(), Date.now(), s.streamId).run();
    this.session = null;
    this.timeline = [];
    this.pending.clear();
    await this.ctx.storage.delete(['session', 'timeline']);
    return s.streamId;
  }

  private record(m: ChatMessage, now: number) {
    const s = this.session!;
    s.messages++;
    const p = this.pending.get(m.userId);
    if (p) p.n++;
    else this.pending.set(m.userId, { login: m.login, n: 1 });
    const t = Math.floor(now / 60_000) * 60_000;
    let last = this.timeline[this.timeline.length - 1];
    if (!last || last.t !== t) {
      last = { t, msgs: 0, chatters: 0, viewers: last?.viewers ?? 0 };
      this.timeline.push(last);
      if (this.timeline.length > TIMELINE_MAX) this.timeline.shift();
      this.curUsers.clear();
    }
    last.msgs++;
    if (!this.curUsers.has(m.userId)) { this.curUsers.add(m.userId); last.chatters++; }
    this.hype.add(now, m.userId, m.text);
    this.lastActivityAt = now;
  }

  private async sampleViewers(): Promise<number | null> {
    if (isDemo(this.env)) return demoFindStream(this.channel)?.viewerCount ?? null;
    const s = await this.env.KV.get<StreamInfo | { offline: true }>(`me:stream:${this.channelId}`, 'json');
    return s && !('offline' in s) ? s.viewerCount : null;
  }

  /** Writes buffered chatters + timeline to D1. Called by the alarm (~1/min while chat is active), !recap and the growth API. */
  async flush(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const now = Date.now();
    const viewers = await this.sampleViewers();
    if (viewers !== null) {
      s.peakViewers = Math.max(s.peakViewers, viewers);
      const last = this.timeline[this.timeline.length - 1];
      if (last && last.t === Math.floor(now / 60_000) * 60_000) last.viewers = viewers;
    }
    const pend = [...this.pending.entries()];
    this.pending.clear();
    const ins = this.env.DB.prepare('INSERT OR IGNORE INTO chatters (channel_id, user_id, login, first_seen_at, first_stream_id) VALUES (?, ?, ?, ?, ?)');
    const up = this.env.DB.prepare(`INSERT INTO stream_chatters (stream_id, user_id, login, messages) VALUES (?, ?, ?, ?)
      ON CONFLICT(stream_id, user_id) DO UPDATE SET messages = messages + excluded.messages, login = excluded.login`);
    const stmts = pend.flatMap(([uid, p]) => [ins.bind(s.channelId, uid, p.login, now, s.streamId), up.bind(s.streamId, uid, p.login, p.n)]);
    stmts.push(this.env.DB.prepare('UPDATE streams SET peak_viewers = ?, messages = ?, timeline = ?, updated_at = ? WHERE id = ?')
      .bind(s.peakViewers, s.messages, JSON.stringify(this.timeline), now, s.streamId));
    for (let i = 0; i < stmts.length; i += 100) await this.env.DB.batch(stmts.slice(i, i + 100));
    await this.ctx.storage.put({ session: s, timeline: this.timeline });
  }

  private async scheduleFlush() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
  }

  async alarm(): Promise<void> {
    await this.flush();
    // Keep flushing while chat is active; go quiet (no alarms, no D1 writes) when it isn't.
    if (this.session && Date.now() - this.lastActivityAt < 2 * FLUSH_MS) await this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
  }

  // ---------------------------------------------------------------- RPC ----------------------------------------------------------------

  async setActiveDuel(duelId: string, clear: boolean, status: DuelStatus): Promise<void> {
    if (clear) {
      // Only clear if this duel is still the active one (a newer duel may have taken over).
      if (this.activeDuelId !== duelId) return;
      this.activeDuelId = null;
      await this.ctx.storage.delete('activeDuelId');
    } else {
      this.activeDuelId = duelId;
      await this.ctx.storage.put('activeDuelId', duelId);
    }
    this.push({ type: 'duel', duelId, status });
  }

  async getActiveDuel(): Promise<string | null> {
    return this.activeDuelId;
  }

  /** EventSub stream.online. */
  async streamOnline(o: { channel: ChannelRef; streamId: string; startedAt: number; title?: string | null; gameName?: string | null }): Promise<string> {
    await this.setChannel(o.channel);
    this.demoOffline = false;
    await this.ctx.storage.delete('demoOffline');
    const s = await this.startSession({ ...o, source: isDemo(this.env) ? 'demo' : 'live' });
    return s.streamId;
  }

  /** EventSub stream.offline: final flush, stamp ended_at. The growth page then shows the finished report. */
  async streamOffline(channel?: ChannelRef): Promise<string | null> {
    if (channel) await this.setChannel(channel);
    if (isDemo(this.env)) { this.demoOffline = true; await this.ctx.storage.put('demoOffline', true); }
    this.offlineCheckedAt = Date.now();
    return this.endSession();
  }

  /** Growth API: make sure the live session exists and D1 is current. */
  async currentStream(channel: ChannelRef): Promise<string | null> {
    await this.setChannel(channel);
    const s = await this.ensureSession();
    if (s) await this.flush();
    return s?.streamId ?? null;
  }

  /** Demo/test helper: clear clip, recap, welcome and AI cooldowns (and today's AI count unless keepDaily). */
  async resetCooldowns(opts: { keepDaily?: boolean } = {}): Promise<void> {
    if (this.session) { this.session.lastClipAt = 0; this.session.lastRecapAt = 0; await this.ctx.storage.put('session', this.session); }
    this.welcomed.clear();
    this.hype = new HypeDetector();
    this.askCooldown.clear();
    this.ai = { ...this.ai, lastAt: 0, ...(opts.keepDaily ? {} : { count: 0 }) };
    this.aiSettings = null;
    await this.ctx.storage.put('ai', this.ai);
  }

  // ---------------------------------------------------------------- AI co-host ----------------------------------------------------------------

  /** Dashboard toggles changed: drop the cached settings. */
  async aiSettingsChanged(): Promise<void> {
    this.aiSettings = null;
  }

  /** AI chat messages sent today (UTC) by this channel. */
  async aiUsedToday(): Promise<number> {
    return this.ai.day === utcDay() ? this.ai.count : 0;
  }

  private async settings(): Promise<AiSettings | null> {
    if (!this.channelId) return null;
    if (!this.aiSettings || Date.now() - this.aiSettings.at > AI_SETTINGS_TTL_MS) this.aiSettings = { at: Date.now(), s: await getAiSettings(this.env, this.channelId) };
    return this.aiSettings.s;
  }

  /**
   * May this channel send an AI chat message for `feature` now? Takes the slot when it may
   * (per-channel 20s gap + daily cap). Callers fall back to their template (or stay quiet) otherwise.
   */
  private async aiGate(feature: AiFeature): Promise<'ok' | 'disabled' | 'rate-limited' | 'daily-cap'> {
    const st = await this.settings();
    if (!st || !st[feature]) return 'disabled';
    const now = Date.now();
    const day = utcDay(now);
    if (this.ai.day !== day) this.ai = { lastAt: this.ai.lastAt, day, count: 0 };
    if (this.ai.count >= st.dailyCap) return 'daily-cap';
    if (now - this.ai.lastAt < AI_MIN_GAP_MS) return 'rate-limited';
    this.ai = { lastAt: now, day, count: this.ai.count + 1 };
    await this.ctx.storage.put('ai', this.ai);
    return 'ok';
  }

  /** DuelDO host line (round start / result) for this channel's chat. The line is generated once per duel event. */
  async duelLine(channel: ChannelRef, text: string): Promise<{ status: AiChatStatus; text?: string }> {
    await this.setChannel(channel);
    const gate = await this.aiGate('duel');
    if (gate !== 'ok') return { status: gate };
    const sent = await sendBotChat(this.env, { channelId: channel.id, streamId: this.session?.streamId, kind: 'duel', text });
    return { status: sent.status, text: sent.text };
  }

  private async askContext(): Promise<AskCtx> {
    const s = this.session;
    let game = s?.gameName ?? null;
    let title = s?.title ?? null;
    if (!s && isDemo(this.env)) { const d = demoFindStream(this.channel); game = d?.gameName ?? null; title = d?.title ?? null; }
    const raiders = await this.env.DB.prepare('SELECT DISTINCT from_name FROM raids WHERE to_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 3')
      .bind(this.channelId, s?.startedAt ?? Date.now() - 6 * 3600_000).all<{ from_name: string }>();
    let duel: string | null = null;
    if (this.activeDuelId) {
      const d = await duelStub(this.env, this.activeDuelId).getState().catch(() => null);
      if (d && ['countdown', 'live'].includes(d.status)) {
        duel = `Duel ${d.status === 'live' ? 'live' : 'starting'}: ${d.sides.map((x) => `${x.name} ${x.score}`).join(' vs ')}. ${d.mode === 'tug' ? 'Type !pull' : `Vote !1-!${d.options.length}`} to help!`;
      }
    }
    return {
      streamer: demoFindStream(this.channel)?.displayName ?? this.channel, login: this.channel, game, title,
      uptimeMs: s ? Date.now() - s.startedAt : null, viewers: await this.sampleViewers().catch(() => null),
      duel, recentRaiders: raiders.results.map((r) => r.from_name).filter(Boolean), commands: ['!ask <question>', '!recap', '!pull (duels)', '!1-!4 (polls)'],
    };
  }

  /** `!ask <question>`: answered from stream info, per-viewer cooldown + channel AI gate + safety filter. */
  private async ask(m: ChatMessage, question: string): Promise<{ status: AiChatStatus; text?: string; ai?: boolean }> {
    const st = await this.settings();
    if (!st?.ask) return { status: 'disabled' };
    if (!question || question.length < 2) return { status: 'blocked' };
    const now = Date.now();
    if (now - (this.askCooldown.get(m.userId) ?? 0) < ASK_USER_COOLDOWN_MS) return { status: 'cooldown' };
    if (isBlocked(question)) return { status: 'blocked' };
    const gate = await this.aiGate('ask');
    if (gate !== 'ok') return { status: gate };
    this.askCooldown.set(m.userId, now);
    if (this.askCooldown.size > 2000) this.askCooldown = new Map([...this.askCooldown].filter(([, t]) => now - t < ASK_USER_COOLDOWN_MS));
    const { text, ai } = await aiAsk(this.env, question, await this.askContext(), m.displayName ?? m.login);
    const sent = await sendBotChat(this.env, { channelId: this.channelId, streamId: this.session?.streamId, kind: 'ask', text });
    return { status: sent.status, text: sent.text, ai };
  }

  /** Batched chat messages for this channel (from EventSub or the demo endpoint). */
  async chat(msgs: ChatMessage[]): Promise<ChatResult> {
    const fresh = msgs.filter((m) => !this.seen.has(m.id));
    for (const m of fresh) this.seen.add(m.id);
    if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-500));
    const out: ChatResult = { routed: fresh.length, counted: 0, duelId: this.activeDuelId, streamId: null, hype: null, clip: null, recap: null, ask: null };
    if (!fresh.length) return out;
    await this.setChannel({ id: fresh[0].channelId, login: fresh[0].channelLogin });

    if (this.activeDuelId) out.counted = (await duelStub(this.env, this.activeDuelId).ingest(fresh[0].channelId, fresh)).counted;

    const s = await this.ensureSession();
    if (s) {
      out.streamId = s.streamId;
      const now = Date.now();
      for (const m of fresh) this.record(m, now);
      out.hype = this.hype.check(now, s.lastClipAt);
      if (out.hype.hype) {
        s.lastClipAt = now; // claim the cooldown before the Helix call so a parallel burst can't double-clip
        await this.ctx.storage.put('session', s);
        try {
          out.clip = await makeClip(this.env, { channelId: s.channelId, channelLogin: s.login, streamId: s.streamId, score: out.hype.ratio, rate: out.hype.rate, quote: out.hype.quote });
          this.push({ type: 'clip', clip: out.clip });
        } catch (e) {
          console.warn('auto-clip failed', (e as Error).message);
        }
      }
      await this.scheduleFlush();
    }
    if (fresh.some((m) => /^!recap\b/i.test(m.text.trim()))) out.recap = await this.recap();
    const askMsg = fresh.find((m) => /^!ask\b/i.test(m.text.trim()));
    out.ask = askMsg ? await this.ask(askMsg, askMsg.text.trim().replace(/^!ask\b\s*/i, '').slice(0, 300)) : null;
    return out;
  }

  private async recap(): Promise<{ status: BotMessageStatus; text?: string; ai?: boolean }> {
    const s = this.session;
    if (!s) return { status: 'offline' };
    const now = Date.now();
    if (now - s.lastRecapAt < RECAP_COOLDOWN_MS) return { status: 'cooldown' };
    s.lastRecapAt = now;
    await this.flush();
    const report = await streamReport(this.env, s.streamId);
    if (!report) return { status: 'failed' };
    const tpl = await recapMessage(this.env, report);
    let text = tpl.text;
    let ai = false;
    if ((await this.aiGate('recap')) === 'ok') ({ text, ai } = await aiRecap(this.env, report, report.clips[0]?.url ?? null));
    const sent = await sendBotChat(this.env, { channelId: s.channelId, streamId: s.streamId, kind: 'recap', text });
    this.push({ type: 'recap', lines: tpl.lines, text });
    return { status: sent.status, text, ai };
  }

  /** channel.raid landed on this channel: overlay welcome card + chat shout-out. */
  async raid(from: ChannelRef, viewers: number, to: ChannelRef): Promise<RaidWelcome> {
    await this.setChannel(to);
    const s = await this.ensureSession();
    const row = await this.env.DB.prepare('SELECT COUNT(*) AS n FROM raids WHERE from_id = ? AND to_id = ?').bind(from.id, to.id).first<{ n: number }>();
    const raidCount = Math.max(1, row?.n ?? 1);
    let game: string | null = null;
    let title: string | null = null;
    if (isDemo(this.env)) { const d = demoFindStream(from.login); game = d?.gameName ?? null; title = d?.title ?? null; }
    else {
      try { const info = await getChannelInfo(this.env, from.id); game = info?.game_name || null; title = info?.title || null; } catch { /* optional */ }
    }
    const welcome: RaidWelcome = { from, viewers, raidCount, game };
    const last = this.welcomed.get(from.id) ?? 0;
    if (Date.now() - last > WELCOME_REPEAT_MS) {
      this.welcomed.set(from.id, Date.now());
      const wctx = { fromName: from.displayName, fromLogin: from.login, viewers, raidCount, game, title, toName: to.displayName };
      let text = templateWelcome(wctx);
      welcome.ai = false;
      if ((await this.aiGate('welcome')) === 'ok') { const w = await aiWelcome(this.env, wctx); text = w.text; welcome.ai = w.ai; }
      const sent = await sendBotChat(this.env, { channelId: to.id, streamId: s?.streamId, kind: 'welcome', text });
      welcome.message = sent.text;
      welcome.status = sent.status;
    } else welcome.status = 'cooldown';
    this.push({ type: 'raid', ...welcome });
    return welcome;
  }

  async toast(text: string): Promise<void> {
    this.push({ type: 'toast', text });
  }
}
