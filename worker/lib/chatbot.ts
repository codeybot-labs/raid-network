import { isDemo, type Env } from '../env';
import type { BotMessageStatus } from '../../shared/types';
import { appToken, sendChatMessage } from './helix';
import { userToken } from './tokens';

export type BotKind = 'welcome' | 'recap';

/**
 * Sends a chat message into a channel via Helix POST /chat/messages and logs it to D1 `bot_messages`.
 *
 * - With BOT_USER_ID set: app access token + sender = bot account. Twitch shows the "Chat Bot" badge.
 *   Requires the bot account to have authorized this app (user:bot, user:write:chat) and the
 *   broadcaster to have granted channel:bot (both are in SCOPES, so signing in once covers it).
 * - Otherwise: the broadcaster's own user token (user:write:chat), so the message comes from them.
 * - DEMO_MODE: nothing goes to Twitch; the message is logged with status 'demo'.
 */
export async function sendBotChat(env: Env, o: { channelId: string; streamId?: string | null; kind: BotKind; text: string }): Promise<{ status: BotMessageStatus; text: string; error?: string }> {
  const text = o.text.slice(0, 500);
  let status: BotMessageStatus = 'demo';
  let messageId: string | null = null;
  let error: string | undefined;
  if (!isDemo(env)) {
    try {
      const bot = env.BOT_USER_ID;
      const token = bot ? await appToken(env) : await userToken(env, o.channelId);
      const r = await sendChatMessage(env, token, o.channelId, bot || o.channelId, text);
      const d = r.data?.[0];
      messageId = d?.message_id ?? null;
      status = d?.is_sent ? 'sent' : 'dropped';
      if (!d?.is_sent) error = d?.drop_reason?.message ?? 'dropped by Twitch';
    } catch (e) {
      status = 'failed';
      error = (e as Error).message.slice(0, 300);
      console.warn('bot chat failed', o.kind, error);
    }
  }
  await env.DB.prepare(
    `INSERT INTO bot_messages (channel_id, stream_id, kind, text, status, twitch_message_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(o.channelId, o.streamId ?? null, o.kind, text, status, messageId, error ?? null, Date.now()).run();
  return { status, text, error };
}

export function welcomeText(fromName: string, fromLogin: string, viewers: number, raidCount: number, game?: string | null): string {
  const crowd = `${viewers} ${viewers === 1 ? 'raider' : 'raiders'}`;
  const where = game ? ` from their ${game} stream` : '';
  const again = raidCount > 1 ? ` That's raid #${raidCount} from them!` : ' First raid from them!';
  return `💜 Welcome in, ${crowd} from ${fromName}${where}!${again} Go show them some love: twitch.tv/${fromLogin}`;
}
