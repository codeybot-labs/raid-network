import { DurableObject } from 'cloudflare:workers';
import { duelStub, type Env } from '../env';
import type { ChannelRef, ChatMessage, DuelStatus, OverlayEvent } from '../../shared/types';

/**
 * One OverlayDO per channel (keyed by login). The streamer's OBS browser source (/overlay/:channel)
 * holds a hibernating WebSocket here. It is also the per-channel chat router: EventSub chat messages
 * land here and are forwarded to the active DuelDO.
 */
export class OverlayDO extends DurableObject<Env> {
  private channel = '';
  private activeDuelId: string | null = null;
  private seen = new Set<string>(); // recent EventSub chat message ids (Twitch may redeliver)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.channel = (await ctx.storage.get<string>('channel')) ?? '';
      this.activeDuelId = (await ctx.storage.get<string>('activeDuelId')) ?? null;
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    const channel = new URL(req.url).searchParams.get('channel') ?? '';
    if (channel && channel !== this.channel) {
      this.channel = channel;
      await this.ctx.storage.put('channel', channel);
    }
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

  // ---------- RPC ----------
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

  /** Batched chat messages for this channel (from EventSub or the demo endpoint). */
  async chat(msgs: ChatMessage[]): Promise<{ routed: number; counted: number; duelId: string | null }> {
    const fresh = msgs.filter((m) => !this.seen.has(m.id));
    for (const m of fresh) this.seen.add(m.id);
    if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-500));
    let counted = 0;
    if (this.activeDuelId && fresh.length) {
      const res = await duelStub(this.env, this.activeDuelId).ingest(fresh[0].channelId, fresh);
      counted = res.counted;
    }
    // TODO(auto-clips): track chat velocity here; on a spike call Helix POST /clips and record in D1 `clips`.
    // TODO(!recap, last): on "!recap" reply via Helix POST /chat/messages with a summary of this stream.
    return { routed: fresh.length, counted, duelId: this.activeDuelId };
  }

  /** channel.raid landed on this channel. */
  async raid(from: ChannelRef, viewers: number): Promise<void> {
    // TODO(raider welcomes): richer welcome card + chat shout-out via POST /chat/messages.
    this.push({ type: 'raid', from, viewers });
  }

  async toast(text: string): Promise<void> {
    this.push({ type: 'toast', text });
  }
}
