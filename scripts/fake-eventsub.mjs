// Sends a signed EventSub webhook to a local `wrangler dev` (DEMO_MODE secret by default).
// Usage: node scripts/fake-eventsub.mjs chat <broadcaster_login> <broadcaster_id> "<text>" [chatter]
//        node scripts/fake-eventsub.mjs raid <from_login> <from_id> <to_login> <to_id> [viewers]
//        node scripts/fake-eventsub.mjs verify
import { createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const SECRET = process.env.EVENTSUB_SECRET ?? 'demo-eventsub-secret';

export async function sendEventSub(type, payload, { messageType = 'notification', secret = SECRET } = {}) {
  const id = randomUUID();
  const ts = new Date().toISOString();
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + createHmac('sha256', secret).update(id + ts + body).digest('hex');
  const res = await fetch(`${BASE}/webhooks/eventsub`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Twitch-Eventsub-Message-Id': id,
      'Twitch-Eventsub-Message-Timestamp': ts,
      'Twitch-Eventsub-Message-Signature': sig,
      'Twitch-Eventsub-Message-Type': messageType,
      'Twitch-Eventsub-Subscription-Type': type,
    },
    body,
  });
  return { status: res.status, text: await res.text() };
}

export const chatPayload = (login, id, text, chatter = 'eventsub_tester') => ({
  subscription: { type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: id, user_id: id } },
  event: {
    broadcaster_user_id: id, broadcaster_user_login: login, broadcaster_user_name: login,
    chatter_user_id: `es-${chatter}`, chatter_user_login: chatter, chatter_user_name: chatter,
    message_id: randomUUID(), message: { text, fragments: [] }, message_type: 'text',
  },
});

export const raidPayload = (fromLogin, fromId, toLogin, toId, viewers = 12, fromName = fromLogin, toName = toLogin) => ({
  subscription: { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: toId } },
  event: {
    from_broadcaster_user_id: fromId, from_broadcaster_user_login: fromLogin, from_broadcaster_user_name: fromName,
    to_broadcaster_user_id: toId, to_broadcaster_user_login: toLogin, to_broadcaster_user_name: toName, viewers,
  },
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...a] = process.argv.slice(2);
  let r;
  if (cmd === 'chat') r = await sendEventSub('channel.chat.message', chatPayload(a[0], a[1], a[2], a[3]));
  else if (cmd === 'raid') r = await sendEventSub('channel.raid', raidPayload(a[0], a[1], a[2], a[3], Number(a[4] ?? 12)));
  else if (cmd === 'verify') r = await sendEventSub('stream.online', { challenge: 'pogchamp-challenge', subscription: { type: 'stream.online' } }, { messageType: 'webhook_callback_verification' });
  else { console.log('usage: chat|raid|verify …'); process.exit(1); }
  console.log(r.status, r.text);
}
