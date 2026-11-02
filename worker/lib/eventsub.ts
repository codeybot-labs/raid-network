import { eventsubCallbackUrl, isDemo, overlayStub, type Env } from '../env';
import type { ChatMessage } from '../../shared/types';
import { hmacSha256Hex, timingSafeEqual } from './crypto';
import { getChannelInfo, subscribeEventSub } from './helix';

const MAX_AGE_MS = 10 * 60_000;
export const DEMO_EVENTSUB_SECRET = 'demo-eventsub-secret';

/** Twitch EventSub webhook: HMAC-SHA256(secret, id + timestamp + body), replay window 10 min. */
export async function verifyEventSub(secret: string, headers: Headers, body: string): Promise<boolean> {
  const id = headers.get('Twitch-Eventsub-Message-Id');
  const ts = headers.get('Twitch-Eventsub-Message-Timestamp');
  const sig = headers.get('Twitch-Eventsub-Message-Signature');
  if (!id || !ts || !sig) return false;
  const age = Date.now() - Date.parse(ts);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_AGE_MS) return false;
  const expected = `sha256=${await hmacSha256Hex(secret, id + ts + body)}`;
  return timingSafeEqual(expected, sig);
}

interface Notification {
  subscription: { type: string; version: string; condition: Record<string, string> };
  event: Record<string, any>;
  challenge?: string;
}

export async function handleEventSub(env: Env, req: Request, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  // DEMO_MODE uses a well-known secret so scripts/fake-eventsub.mjs can sign test payloads.
  const secret = env.EVENTSUB_SECRET || (isDemo(env) ? DEMO_EVENTSUB_SECRET : undefined);
  if (!secret) return new Response('EVENTSUB_SECRET not configured', { status: 500 });
  const body = await req.text();
  if (!(await verifyEventSub(secret, req.headers, body))) return new Response('bad signature', { status: 403 });

  const type = req.headers.get('Twitch-Eventsub-Message-Type');
  const msgId = req.headers.get('Twitch-Eventsub-Message-Id')!;
  const payload = JSON.parse(body) as Notification;

  if (type === 'webhook_callback_verification') {
    return new Response(payload.challenge ?? '', { headers: { 'content-type': 'text/plain' } });
  }
  if (type === 'revocation') {
    console.warn('eventsub revoked', payload.subscription);
    return new Response(null, { status: 204 });
  }
  if (type !== 'notification') return new Response(null, { status: 204 });

  const subType = payload.subscription.type;
  const e = payload.event;

  // Chat is high-volume: dedupe happens in OverlayDO memory instead of a KV write per message.
  if (subType !== 'channel.chat.message') {
    if (await env.KV.get(`es:${msgId}`)) return new Response(null, { status: 204 });
    ctx.waitUntil(env.KV.put(`es:${msgId}`, '1', { expirationTtl: 900 }));
  }

  const work = (async () => {
    switch (subType) {
      case 'channel.chat.message': {
        const msg: ChatMessage = {
          id: e.message_id, channelId: e.broadcaster_user_id, channelLogin: e.broadcaster_user_login,
          userId: e.chatter_user_id, login: e.chatter_user_login, displayName: e.chatter_user_name,
          text: e.message?.text ?? '', at: Date.now(),
        };
        await overlayStub(env, msg.channelLogin).chat([msg]);
        break;
      }
      case 'channel.raid': {
        const recent = await env.DB.prepare(
          // Merge with the Raid-button row, or with the twin notification (both channels may be subscribed).
          "SELECT id FROM raids WHERE from_id = ? AND to_id = ? AND source IN ('button', 'eventsub') AND created_at > ?",
        ).bind(e.from_broadcaster_user_id, e.to_broadcaster_user_id, Date.now() - 5 * 60_000).first();
        if (recent) {
          await env.DB.prepare('UPDATE raids SET viewers = ?, source = ? WHERE id = ?').bind(e.viewers, 'eventsub', (recent as { id: number }).id).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO raids (from_id, from_login, from_name, to_id, to_login, to_name, viewers, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'eventsub', ?)`,
          ).bind(e.from_broadcaster_user_id, e.from_broadcaster_user_login, e.from_broadcaster_user_name,
            e.to_broadcaster_user_id, e.to_broadcaster_user_login, e.to_broadcaster_user_name, e.viewers, Date.now()).run();
        }
        // A destination subscription confirms the handoff and owns the welcome overlay.
        // A source subscription records the outgoing raid but does not claim completion.
        if (payload.subscription.condition.to_broadcaster_user_id) {
          await overlayStub(env, e.to_broadcaster_user_login).raid(
            { id: e.from_broadcaster_user_id, login: e.from_broadcaster_user_login, displayName: e.from_broadcaster_user_name }, e.viewers,
            { id: e.to_broadcaster_user_id, login: e.to_broadcaster_user_login, displayName: e.to_broadcaster_user_name });
        } else if (!recent) {
          await env.DB.prepare(
            `INSERT INTO raids (from_id, from_login, from_name, to_id, to_login, to_name, viewers, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'button', ?)`)
            .bind(e.from_broadcaster_user_id, e.from_broadcaster_user_login, e.from_broadcaster_user_name,
              e.to_broadcaster_user_id, e.to_broadcaster_user_login, e.to_broadcaster_user_name, e.viewers, Date.now()).run();
        }
        break;
      }
      case 'stream.online': {
        await env.DB.prepare('UPDATE channels SET is_live = 1, started_at = ?, updated_at = ? WHERE id = ?')
          .bind(e.started_at, Date.now(), e.broadcaster_user_id).run();
        await env.KV.delete(`me:stream:${e.broadcaster_user_id}`);
        let info: { title?: string; game_name?: string } | null = null;
        try { info = isDemo(env) ? null : await getChannelInfo(env, e.broadcaster_user_id); } catch { /* optional */ }
        await overlayStub(env, e.broadcaster_user_login).streamOnline({
          channel: { id: e.broadcaster_user_id, login: e.broadcaster_user_login, displayName: e.broadcaster_user_name },
          streamId: e.id, startedAt: Date.parse(e.started_at) || Date.now(), title: info?.title ?? null, gameName: info?.game_name ?? null,
        });
        break;
      }
      case 'stream.offline':
        await env.DB.prepare('UPDATE channels SET is_live = 0, updated_at = ? WHERE id = ?').bind(Date.now(), e.broadcaster_user_id).run();
        await env.KV.delete(`me:stream:${e.broadcaster_user_id}`);
        // Final flush + ended_at; the growth page report for this stream is now complete.
        await overlayStub(env, e.broadcaster_user_login).streamOffline(
          { id: e.broadcaster_user_id, login: e.broadcaster_user_login, displayName: e.broadcaster_user_name });
        break;
    }
  })().catch((err) => console.error('eventsub handler', subType, err));
  // Ack fast (Twitch expects < 10s); work continues in the background.
  ctx.waitUntil(work);
  return new Response(null, { status: 204 });
}

/** Subscribe a freshly signed-in broadcaster to everything Raid Network needs. */
export async function subscribeChannel(env: Env, broadcasterId: string): Promise<{ ok: number; failed: string[] }> {
  const cb = eventsubCallbackUrl(env);
  // Twitch only delivers webhooks to public https:443 URLs; skip the API calls when running on plain localhost.
  if (!cb.startsWith('https://')) return { ok: 0, failed: [`EventSub needs a public https callback (have ${cb}); set EVENTSUB_CALLBACK or deploy`] };
  const reader = env.BOT_USER_ID || broadcasterId;
  const subs: [string, string, Record<string, string>][] = [
    ['stream.online', '1', { broadcaster_user_id: broadcasterId }],
    ['stream.offline', '1', { broadcaster_user_id: broadcasterId }],
    ['channel.raid', '1', { to_broadcaster_user_id: broadcasterId }],
    ['channel.raid', '1', { from_broadcaster_user_id: broadcasterId }],
    ['channel.chat.message', '1', { broadcaster_user_id: broadcasterId, user_id: reader }],
  ];
  let ok = 0;
  const failed: string[] = [];
  for (const [type, version, condition] of subs) {
    try { await subscribeEventSub(env, cb, type, version, condition); ok++; } catch (e) { failed.push(`${type}: ${(e as Error).message}`); }
  }
  return { ok, failed };
}
