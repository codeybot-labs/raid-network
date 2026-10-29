// Live EventSub round-trip check against real Twitch (no secrets printed):
//   node scripts/live-check.mjs [broadcaster_login]
// 1. app access token (client credentials) from .dev.vars
// 2. POST /eventsub/subscriptions stream.online -> CALLBACK/webhooks/eventsub (Twitch sends a signed challenge)
// 3. poll until "enabled" (challenge answered + HMAC verified by the Worker) or a failure status
// 4. DELETE the subscription so nothing is left behind
// CALLBACK defaults to the running server's /api/dev/status eventsubCallback.
import { readFileSync } from 'node:fs';

const vars = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const login = (process.argv[2] ?? 'raidnetwork_hq').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const status = await (await fetch(`${BASE}/api/dev/status`)).json();
const callback = process.env.CALLBACK ?? status.eventsubCallback;
if (!callback?.startsWith('https://')) throw new Error(`EventSub needs a public https callback, got ${callback}`);
console.log('callback:', callback);
const health = await fetch(new URL('/api/health', callback)).then((r) => r.json()).catch((e) => ({ error: String(e) }));
console.log('tunnel → worker /api/health:', JSON.stringify(health));

const tok = await (await fetch('https://id.twitch.tv/oauth2/token', {
  method: 'POST',
  body: new URLSearchParams({ client_id: vars.TWITCH_CLIENT_ID, client_secret: vars.TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' }),
})).json();
if (!tok.access_token) throw new Error('client-credentials token request failed');
const H = { 'Client-Id': vars.TWITCH_CLIENT_ID, Authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' };

const user = (await (await fetch(`https://api.twitch.tv/helix/users?login=${login}`, { headers: H })).json()).data?.[0];
if (!user) throw new Error(`unknown login ${login}`);
console.log(`broadcaster: ${user.login} (${user.id})`);

const created = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
  method: 'POST', headers: H,
  body: JSON.stringify({ type: 'stream.online', version: '1', condition: { broadcaster_user_id: user.id },
    transport: { method: 'webhook', callback, secret: vars.EVENTSUB_SECRET } }),
});
const cj = await created.json();
console.log('create:', created.status, cj.data?.[0]?.status ?? cj.message);
const sub = cj.data?.[0];
let final = sub?.status;
if (sub) {
  for (let i = 0; i < 20 && final === 'webhook_callback_verification_pending'; i++) {
    await sleep(1000);
    const r = await (await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?subscription_id=${sub.id}`, { headers: H })).json();
    final = r.data?.[0]?.status ?? 'gone';
  }
  console.log('final status:', final);
  const del = await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${sub.id}`, { method: 'DELETE', headers: H });
  console.log('delete:', del.status);
}
const left = await (await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', { headers: H })).json();
console.log('subscriptions remaining on app:', left.total, 'cost', left.total_cost, '/', left.max_total_cost);
process.exit(final === 'enabled' ? 0 : 1);
