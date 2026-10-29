import { createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import type { DuelChannel, DuelState, Viewer } from '../../shared/types';
import { api, liveSocket } from '../lib/api';
import DuelBoard from './DuelBoard';
import { toast, Toasts } from './Toasts';
import Check from 'lucide-solid/icons/check';
import Copy from 'lucide-solid/icons/copy';
import ExternalLink from 'lucide-solid/icons/external-link';
import Play from 'lucide-solid/icons/play';
import Square from 'lucide-solid/icons/square';
import X from 'lucide-solid/icons/x';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import './duel.css';

const FORMAT_LABEL = { '1v1': '1v1 duel', ffa: 'Free-for-all', teams: 'Team battle' } as const;
const SIDE_COLOR: Record<string, string> = { a: 'var(--a)', b: 'var(--b)', c: 'var(--c)', d: 'var(--d)' };
const isActive = (c: DuelChannel) => c.invite === 'host' || c.invite === 'accepted';

export default function DuelRoom() {
  const id = location.pathname.split('/').filter(Boolean)[1] ?? '';
  const [me] = createResource(() => api<{ viewer: Viewer | null; demo: boolean }>('/api/me'));
  const [state, setState] = createSignal<DuelState | null>(null);
  const [offset, setOffset] = createSignal(0);
  const [connected, setConnected] = createSignal(false);
  const [err, setErr] = createSignal('');
  const [chatText, setChatText] = createSignal('!pull');

  const apply = (s: DuelState) => { setOffset(s.serverNow - Date.now()); setState(s); };
  api<{ duel: DuelState }>(`/api/duels/${id}`).then((r) => apply(r.duel)).catch((e) => setErr(e.message));
  const stop = liveSocket(`/api/duels/${id}/ws`, (m) => m.type === 'state' && apply(m.state), setConnected);
  onCleanup(stop);

  const act = async (action: string, json: unknown = {}) => {
    try { apply((await api<{ duel: DuelState }>(`/api/duels/${id}/${action}`, { json })).duel); }
    catch (e) { toast((e as Error).message, true); }
  };
  const sendChat = async (ch: DuelChannel, burst: number) => {
    const messages = Array.from({ length: burst }, (_, i) => ({ user: `tester_${ch.side}_${Math.floor(Math.random() * 1e6)}_${i}`, text: chatText() }));
    try {
      const r = await api<{ counted: number }>('/api/demo/chat', { json: { channel: ch.login, messages } });
      toast(`${r.counted}/${burst} message(s) counted in ${ch.displayName}'s chat`);
    } catch (e) { toast((e as Error).message, true); }
  };
  const meId = () => me()?.viewer?.id;
  const mine = () => state()?.channels.find((c) => c.id === meId());
  const isHost = () => !!meId() && state()?.hostId === meId();
  const inDuel = () => !!mine() && isActive(mine()!);
  const canStart = () => isHost() || (state()?.format === '1v1' && inDuel());
  const pending = () => state()?.channels.filter((c) => c.invite === 'pending') ?? [];
  const overlayUrl = (login: string) => `${location.origin}/overlay/${login}`;
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast('Copied'));
  const title = (s: DuelState) => {
    if (s.format === 'teams') return `${s.a.displayName} vs ${s.b.displayName}`;
    return s.channels.filter((c) => c.invite !== 'declined' && c.invite !== 'dropped').map((c) => c.displayName).join(' vs ');
  };

  return (
    <main class="wrap duel-room">
      <Show when={err()}><Card class="empty">{err()}</Card></Show>
      <Show when={state()}>
        {(s) => (
          <>
            <div class="room-head">
              <div>
                <div class="eyebrow">{FORMAT_LABEL[s().format ?? '1v1']} · {s().id}</div>
                <h1>{title(s())}</h1>
              </div>
              <Badge variant={connected() ? 'success' : 'muted'}>{connected() ? '● live sync' : '○ reconnecting'}</Badge>
            </div>

            <DuelBoard state={s()} offset={offset()} />

            <Card class="controls overflow-hidden">
              <Show when={s().format !== '1v1' && ['pending', 'accepted'].includes(s().status)}>
                <div class="invites">
                  <span class="eyebrow">Invites</span>
                  <For each={s().channels}>
                    {(c) => (
                      <span class={`invite-chip inv-${c.invite}`} style={{ '--col': SIDE_COLOR[c.side] }}>
                        <b>{c.displayName}</b>
                        <span class="mono">{s().format === 'teams' ? `team ${c.side.toUpperCase()}` : `lane ${c.side.toUpperCase()}`} · {c.invite}</span>
                        <Show when={c.invite === 'pending' && s().demo && isHost()}>
                          <Button size="icon" class="size-7" aria-label={`Accept for ${c.displayName}`} onClick={() => act('accept', { channelId: c.id })}><Check /></Button>
                          <Button size="icon" variant="ghost" class="size-7" aria-label={`Decline for ${c.displayName}`} onClick={() => act('decline', { channelId: c.id })}><X /></Button>
                        </Show>
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              <div class="ctl-row">
                <Show when={['pending', 'accepted'].includes(s().status) && mine()?.invite === 'pending'}>
                  <span class="muted">{s().channels.find((c) => c.id === s().hostId)?.displayName} invited you{s().format === 'teams' ? ` to ${mine()!.side === 'a' ? s().a.displayName : s().b.displayName}` : ''}.</span>
                  <Button onClick={() => act('accept')}>Accept {s().format === '1v1' ? 'duel' : 'invite'}</Button>
                  <Button variant="ghost" onClick={() => act('decline')}>Decline</Button>
                </Show>
                <Show when={s().status === 'pending' && mine()?.invite !== 'pending'}>
                  <Show when={s().demo && isHost()} fallback={<span class="muted">Waiting for {pending().map((c) => c.displayName).join(', ') || 'invitees'} to accept. Send them this link: <code>{location.href}</code></span>}>
                    <span class="muted">Demo: answer as {s().format === '1v1' ? s().b.displayName : 'the invited streamers'}.</span>
                    <Button onClick={() => act('accept')}>{s().format === '1v1' ? 'Accept duel' : 'Accept all invites'}</Button>
                    <Button variant="ghost" onClick={() => act('decline')}>Decline{s().format === '1v1' ? '' : ' all'}</Button>
                  </Show>
                </Show>
                <Show when={s().status === 'accepted' && canStart()}>
                  <span class="muted">
                    {pending().length
                      ? `${pending().length} invite(s) still pending; starting now drops them.`
                      : s().format === '1v1' ? 'Both streamers are in. Add the overlay to OBS, then start the duel.' : 'Everyone is in. Add the overlays to OBS, then start.'}
                  </span>
                  <Button size="lg" onClick={() => act('start')}><Play /> Start {s().format === '1v1' ? 'duel' : s().format === 'ffa' ? 'free-for-all' : 'team battle'}</Button>
                </Show>
                <Show when={s().status === 'accepted' && !canStart() && inDuel()}>
                  <span class="muted">You're in. Waiting for the host to start.</span>
                </Show>
                <Show when={s().status === 'declined'}><span class="muted">Not enough streamers accepted, so this duel can't run.</span></Show>
                <Show when={['countdown', 'live'].includes(s().status)}>
                  <span class="muted">Votes come straight from {s().format === '1v1' ? 'both' : 'every'} Twitch chat{s().format === '1v1' ? 's' : ''}.</span>
                  <Show when={s().demo}>
                    <Button variant={s().simulate ? 'secondary' : 'outline'} onClick={() => act('simulate', { on: !s().simulate })}>{s().simulate ? <><Square /> Stop chat simulator</> : <><Play /> Run chat simulator</>}</Button>
                  </Show>
                </Show>
                <Show when={s().status === 'finished'}><Button as="a" href="/dashboard/">Back to matchmaking</Button></Show>
                <Show when={['pending', 'accepted', 'countdown', 'live'].includes(s().status) && (isHost() || inDuel())}>
                  <span class="spacer" /><Button size="sm" variant="destructive" onClick={() => act('cancel')}>Cancel duel</Button>
                </Show>
              </div>
              <Show when={s().demo && ['countdown', 'live'].includes(s().status)}>
                <div class="ctl-row demo-chat">
                  <span class="eyebrow">Demo chat</span>
                  <Input class="h-8 w-40" aria-label="Demo chat message" value={chatText()} onInput={(e) => setChatText(e.currentTarget.value)} />
                  <For each={s().channels.filter(isActive)}>
                    {(c) => (
                      <span class="demo-send">
                        <Button size="sm" variant="outline" class="bg-white" onClick={() => sendChat(c, 1)} style={{ color: SIDE_COLOR[c.side], 'box-shadow': `inset 0 0 0 2px ${SIDE_COLOR[c.side]}` }}>→ {c.displayName}</Button>
                        <Button size="sm" variant="outline" class="bg-white" onClick={() => sendChat(c, 10)} style={{ color: SIDE_COLOR[c.side], 'box-shadow': `inset 0 0 0 2px ${SIDE_COLOR[c.side]}` }}>×10</Button>
                      </span>
                    )}
                  </For>
                </div>
              </Show>
            </Card>

            <section class={`overlay-links ${s().channels.filter(isActive).length > 2 ? 'many' : ''}`}>
              <For each={s().channels.filter((c) => c.invite !== 'declined' && c.invite !== 'dropped')}>
                {(c) => (
                  <Card class="grid gap-2 p-5">
                    <div class="eyebrow">OBS browser source · {c.displayName}</div>
                    <div class="ol-row"><code>{overlayUrl(c.login)}</code>
                      <Button size="sm" variant="soft" onClick={() => copy(overlayUrl(c.login))}><Copy /> Copy</Button>
                      <Button as="a" size="sm" variant="ghost" href={`/overlay/${c.login}`} target="_blank"><ExternalLink /> Preview</Button></div>
                    <div class="dim" style={{ 'font-size': '12px' }}>Size 1920×1080, transparent background. The board appears when a duel starts.</div>
                  </Card>
                )}
              </For>
            </section>
          </>
        )}
      </Show>
      <Toasts />
    </main>
  );
}
