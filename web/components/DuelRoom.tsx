import { createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import type { DuelChannel, DuelState, Viewer } from '../../shared/types';
import { api, liveSocket } from '../lib/api';
import DuelBoard from './DuelBoard';
import { toast, Toasts } from './Toasts';
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
      <Show when={err()}><div class="panel empty">{err()}</div></Show>
      <Show when={state()}>
        {(s) => (
          <>
            <div class="room-head">
              <div>
                <div class="eyebrow">{FORMAT_LABEL[s().format ?? '1v1']} · {s().id}</div>
                <h1>{title(s())}</h1>
              </div>
              <span class={`chip ${connected() ? 'lime' : ''}`}>{connected() ? '● live sync' : '○ reconnecting'}</span>
            </div>

            <DuelBoard state={s()} offset={offset()} />

            <section class="controls panel">
              <Show when={s().format !== '1v1' && ['pending', 'accepted'].includes(s().status)}>
                <div class="panel-body invites">
                  <span class="eyebrow">Invites</span>
                  <For each={s().channels}>
                    {(c) => (
                      <span class={`invite-chip inv-${c.invite}`} style={{ '--col': SIDE_COLOR[c.side] }}>
                        <b>{c.displayName}</b>
                        <span class="mono">{s().format === 'teams' ? `team ${c.side.toUpperCase()}` : `lane ${c.side.toUpperCase()}`} · {c.invite}</span>
                        <Show when={c.invite === 'pending' && s().demo && isHost()}>
                          <button class="btn sm" onClick={() => act('accept', { channelId: c.id })}>✓</button>
                          <button class="btn sm ghost" onClick={() => act('decline', { channelId: c.id })}>✕</button>
                        </Show>
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              <div class="panel-body ctl-row">
                <Show when={['pending', 'accepted'].includes(s().status) && mine()?.invite === 'pending'}>
                  <span class="muted">{s().channels.find((c) => c.id === s().hostId)?.displayName} invited you{s().format === 'teams' ? ` to ${mine()!.side === 'a' ? s().a.displayName : s().b.displayName}` : ''}.</span>
                  <button class="btn primary" onClick={() => act('accept')}>Accept {s().format === '1v1' ? 'duel' : 'invite'}</button>
                  <button class="btn ghost" onClick={() => act('decline')}>Decline</button>
                </Show>
                <Show when={s().status === 'pending' && mine()?.invite !== 'pending'}>
                  <Show when={s().demo && isHost()} fallback={<span class="muted">Waiting for {pending().map((c) => c.displayName).join(', ') || 'invitees'} to accept. Send them this link: <code>{location.href}</code></span>}>
                    <span class="muted">Demo: answer as {s().format === '1v1' ? s().b.displayName : 'the invited streamers'}.</span>
                    <button class="btn primary" onClick={() => act('accept')}>{s().format === '1v1' ? 'Accept duel' : 'Accept all invites'}</button>
                    <button class="btn ghost" onClick={() => act('decline')}>Decline{s().format === '1v1' ? '' : ' all'}</button>
                  </Show>
                </Show>
                <Show when={s().status === 'accepted' && canStart()}>
                  <span class="muted">
                    {pending().length
                      ? `${pending().length} invite(s) still pending; starting now drops them.`
                      : s().format === '1v1' ? 'Both streamers are in. Add the overlay to OBS, then start the duel.' : 'Everyone is in. Add the overlays to OBS, then start.'}
                  </span>
                  <button class="btn primary lg" onClick={() => act('start')}>▶ Start {s().format === '1v1' ? 'duel' : s().format === 'ffa' ? 'free-for-all' : 'team battle'}</button>
                </Show>
                <Show when={s().status === 'accepted' && !canStart() && inDuel()}>
                  <span class="muted">You're in. Waiting for the host to start.</span>
                </Show>
                <Show when={s().status === 'declined'}><span class="muted">Not enough streamers accepted, so this duel can't run.</span></Show>
                <Show when={['countdown', 'live'].includes(s().status)}>
                  <span class="muted">Votes come straight from {s().format === '1v1' ? 'both' : 'every'} Twitch chat{s().format === '1v1' ? 's' : ''}.</span>
                  <Show when={s().demo}>
                    <button class={`btn ${s().simulate ? 'violet' : ''}`} onClick={() => act('simulate', { on: !s().simulate })}>{s().simulate ? '■ Stop chat simulator' : '▶ Run chat simulator'}</button>
                  </Show>
                </Show>
                <Show when={s().status === 'finished'}><a class="btn primary" href="/dashboard/">Back to matchmaking</a></Show>
                <Show when={['pending', 'accepted', 'countdown', 'live'].includes(s().status) && (isHost() || inDuel())}>
                  <span class="spacer" /><button class="btn sm danger" onClick={() => act('cancel')}>Cancel duel</button>
                </Show>
              </div>
              <Show when={s().demo && ['countdown', 'live'].includes(s().status)}>
                <div class="panel-body ctl-row demo-chat">
                  <span class="eyebrow">Demo chat</span>
                  <input value={chatText()} onInput={(e) => setChatText(e.currentTarget.value)} style={{ width: '160px' }} />
                  <For each={s().channels.filter(isActive)}>
                    {(c) => (
                      <span class="demo-send">
                        <button class="btn sm" onClick={() => sendChat(c, 1)} style={{ color: SIDE_COLOR[c.side] }}>→ {c.displayName}</button>
                        <button class="btn sm" onClick={() => sendChat(c, 10)} style={{ color: SIDE_COLOR[c.side] }}>×10</button>
                      </span>
                    )}
                  </For>
                </div>
              </Show>
            </section>

            <section class={`overlay-links ${s().channels.filter(isActive).length > 2 ? 'many' : ''}`}>
              <For each={s().channels.filter((c) => c.invite !== 'declined' && c.invite !== 'dropped')}>
                {(c) => (
                  <div class="panel panel-body">
                    <div class="eyebrow">OBS browser source · {c.displayName}</div>
                    <div class="ol-row"><code>{overlayUrl(c.login)}</code>
                      <button class="btn sm" onClick={() => copy(overlayUrl(c.login))}>Copy</button>
                      <a class="btn sm ghost" href={`/overlay/${c.login}`} target="_blank">Preview</a></div>
                    <div class="dim" style={{ 'font-size': '12px' }}>Size 1920×1080, transparent background. The board appears when a duel starts.</div>
                  </div>
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
