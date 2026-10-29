import { createResource, createSignal, onCleanup, Show } from 'solid-js';
import type { DuelState, Viewer } from '../../shared/types';
import { api, liveSocket } from '../lib/api';
import DuelBoard from './DuelBoard';
import { toast, Toasts } from './Toasts';
import './duel.css';

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
  const sendChat = async (side: 'a' | 'b', burst: number) => {
    const s = state()!;
    const channel = s[side].login;
    const messages = Array.from({ length: burst }, (_, i) => ({ user: `tester_${side}_${Math.floor(Math.random() * 1e6)}_${i}`, text: chatText() }));
    try {
      const r = await api<{ counted: number }>('/api/demo/chat', { json: { channel, messages } });
      toast(`${r.counted}/${burst} message(s) counted in ${s[side].displayName}'s chat`);
    } catch (e) { toast((e as Error).message, true); }
  };
  const isA = () => me()?.viewer?.id === state()?.a.id;
  const isB = () => me()?.viewer?.id === state()?.b.id;
  const overlayUrl = (login: string) => `${location.origin}/overlay/${login}`;
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast('Copied'));

  return (
    <main class="wrap duel-room">
      <Show when={err()}><div class="panel empty">{err()}</div></Show>
      <Show when={state()}>
        {(s) => (
          <>
            <div class="room-head">
              <div>
                <div class="eyebrow">Duel · {s().id}</div>
                <h1>{s().a.displayName} <span class="dim">vs</span> {s().b.displayName}</h1>
              </div>
              <span class={`chip ${connected() ? 'lime' : ''}`}>{connected() ? '● live sync' : '○ reconnecting'}</span>
            </div>

            <DuelBoard state={s()} offset={offset()} />

            <section class="controls panel">
              <div class="panel-body ctl-row">
                <Show when={s().status === 'pending'}>
                  <Show when={isB() || (s().demo && isA())} fallback={<span class="muted">Waiting for {s().b.displayName} to accept. Send them this link: <code>{location.href}</code></span>}>
                    <span class="muted">{isB() ? `${s().a.displayName} challenged you.` : `Demo: answer as ${s().b.displayName}.`}</span>
                    <button class="btn primary" onClick={() => act('accept')}>Accept duel</button>
                    <button class="btn ghost" onClick={() => act('decline')}>Decline</button>
                  </Show>
                </Show>
                <Show when={s().status === 'accepted' && (isA() || isB())}>
                  <span class="muted">Both streamers are in. Add the overlay to OBS, then start the duel.</span>
                  <button class="btn primary lg" onClick={() => act('start')}>▶ Start duel</button>
                </Show>
                <Show when={['countdown', 'live'].includes(s().status)}>
                  <span class="muted">Votes come straight from both Twitch chats.</span>
                  <Show when={s().demo}>
                    <button class={`btn ${s().simulate ? 'violet' : ''}`} onClick={() => act('simulate', { on: !s().simulate })}>{s().simulate ? '■ Stop chat simulator' : '▶ Run chat simulator'}</button>
                  </Show>
                </Show>
                <Show when={s().status === 'finished'}><a class="btn primary" href="/dashboard/">Back to matchmaking</a></Show>
                <Show when={['pending', 'accepted', 'countdown', 'live'].includes(s().status) && (isA() || isB())}>
                  <span class="spacer" /><button class="btn sm danger" onClick={() => act('cancel')}>Cancel duel</button>
                </Show>
              </div>
              <Show when={s().demo && ['countdown', 'live'].includes(s().status)}>
                <div class="panel-body ctl-row demo-chat">
                  <span class="eyebrow">Demo chat</span>
                  <input value={chatText()} onInput={(e) => setChatText(e.currentTarget.value)} style={{ width: '160px' }} />
                  <button class="btn sm" onClick={() => sendChat('a', 1)} style={{ color: 'var(--a)' }}>→ {s().a.displayName}</button>
                  <button class="btn sm" onClick={() => sendChat('a', 10)} style={{ color: 'var(--a)' }}>×10</button>
                  <button class="btn sm" onClick={() => sendChat('b', 1)} style={{ color: 'var(--b)' }}>→ {s().b.displayName}</button>
                  <button class="btn sm" onClick={() => sendChat('b', 10)} style={{ color: 'var(--b)' }}>×10</button>
                </div>
              </Show>
            </section>

            <section class="overlay-links">
              {(['a', 'b'] as const).map((k) => (
                <div class="panel panel-body">
                  <div class="eyebrow">OBS browser source · {s()[k].displayName}</div>
                  <div class="ol-row"><code>{overlayUrl(s()[k].login)}</code>
                    <button class="btn sm" onClick={() => copy(overlayUrl(s()[k].login))}>Copy</button>
                    <a class="btn sm ghost" href={`/overlay/${s()[k].login}`} target="_blank">Preview</a></div>
                  <div class="dim" style={{ 'font-size': '12px' }}>Size 1920×1080, transparent background. The board appears when a duel starts.</div>
                </div>
              ))}
            </section>
          </>
        )}
      </Show>
      <Toasts />
    </main>
  );
}
