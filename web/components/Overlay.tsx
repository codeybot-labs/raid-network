import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { DuelState, OverlayEvent } from '../../shared/types';
import { liveSocket } from '../lib/api';
import DuelBoard from './DuelBoard';
import './duel.css';

/** OBS browser source: /overlay/:channel. Transparent; shows duel board, raid welcomes and toasts. */
export default function Overlay() {
  const channel = (location.pathname.split('/').filter(Boolean)[1] ?? '').toLowerCase();
  const debug = new URLSearchParams(location.search).has('debug');
  const [duel, setDuel] = createSignal<DuelState | null>(null);
  const [offset, setOffset] = createSignal(0);
  const [cards, setCards] = createSignal<{ id: number; title: string; sub: string; kind: string }[]>([]);
  const [up, setUp] = createSignal(false);
  let stopDuel: (() => void) | null = null;
  let currentDuel: string | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let n = 0;

  const card = (kind: string, title: string, sub: string) => {
    const id = ++n;
    setCards((c) => [...c, { id, title, sub, kind }]);
    setTimeout(() => setCards((c) => c.filter((x) => x.id !== id)), 9000);
  };

  const watchDuel = (id: string | null) => {
    if (id === currentDuel) return;
    stopDuel?.();
    currentDuel = id;
    if (!id) return;
    clearTimeout(hideTimer);
    stopDuel = liveSocket(`/api/duels/${id}/ws`, (m) => {
      if (m.type !== 'state') return;
      const s = m.state as DuelState;
      setOffset(s.serverNow - Date.now());
      setDuel(s);
      if (['finished', 'cancelled', 'declined'].includes(s.status)) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { setDuel(null); stopDuel?.(); stopDuel = null; currentDuel = null; }, s.status === 'finished' ? 20_000 : 2_000);
      }
    });
  };

  const stop = liveSocket(`/api/overlay/${channel}/ws`, (ev: OverlayEvent) => {
    if (ev.type === 'hello') watchDuel(ev.activeDuelId);
    else if (ev.type === 'duel' && ev.duelId && ev.status !== 'finished' && ev.status !== 'cancelled') watchDuel(ev.duelId);
    else if (ev.type === 'raid') card('raid', `${ev.from.displayName} is raiding!`, `Welcome ${ev.viewers} raiders 💜`);
    else if (ev.type === 'toast') card('toast', ev.text, 'Raid Network');
  }, setUp);
  onCleanup(() => { stop(); stopDuel?.(); });

  return (
    <div class="overlay-root">
      <Show when={debug}><div class="ol-debug mono">overlay:{channel} · {up() ? 'connected' : 'connecting…'}</div></Show>
      <Show when={duel()}>{(s) => <div class="ol-duel"><DuelBoard state={s()} offset={offset()} variant="overlay" /></div>}</Show>
      <div class="ol-cards">
        <For each={cards()}>{(c) => <div class={`ol-card ${c.kind}`}><div class="ol-card-title">{c.title}</div><div class="ol-card-sub">{c.sub}</div></div>}</For>
      </div>
      <style>{`
        .overlay-root { position: fixed; inset: 0; font-family: var(--font-body); color: var(--text); }
        .ol-debug { position: absolute; top: 8px; left: 8px; font-size: 12px; background: rgba(0,0,0,.6); padding: 4px 8px; border-radius: 6px; }
        .ol-duel { position: absolute; top: 24px; left: 50%; transform: translateX(-50%); animation: drop .5s cubic-bezier(.3,1.4,.5,1); }
        .ol-cards { position: absolute; bottom: 40px; left: 40px; display: grid; gap: 12px; }
        .ol-card { min-width: 340px; padding: 16px 20px; border-radius: 18px; background: linear-gradient(135deg, rgba(139,92,246,.95), rgba(80,40,180,.95));
          border: 1px solid rgba(255,255,255,.25); box-shadow: 0 20px 50px -10px rgba(139,92,246,.7); animation: drop .5s cubic-bezier(.3,1.4,.5,1); }
        .ol-card.raid { background: linear-gradient(135deg, #c8ff4d, #7dffb0); color: #12091f; }
        .ol-card-title { font: 800 22px var(--font-display); }
        .ol-card-sub { font-weight: 700; opacity: .85; }
        @keyframes drop { from { transform: translate(var(--tx, 0), -30px); opacity: 0; } }
        .ol-duel { --tx: -50%; }
      `}</style>
    </div>
  );
}
