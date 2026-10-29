import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { DuelState, OverlayEvent } from '../../shared/types';
import { liveSocket } from '../lib/api';
import Avatar from './Avatar';
import DuelBoard from './DuelBoard';
import './duel.css';

/** OBS browser source: /overlay/:channel. Transparent; shows duel board, raid welcomes and toasts. */
export default function Overlay() {
  const channel = (location.pathname.split('/').filter(Boolean)[1] ?? '').toLowerCase();
  const debug = new URLSearchParams(location.search).has('debug');
  const [duel, setDuel] = createSignal<DuelState | null>(null);
  const [offset, setOffset] = createSignal(0);
  type Card = { id: number; kind: 'raid' | 'clip' | 'recap' | 'toast'; title: string; sub: string; who?: string; lines?: string[]; badge?: string };
  const [cards, setCards] = createSignal<Card[]>([]);
  const hold = Number(new URLSearchParams(location.search).get('hold') ?? 0) * 1000; // ?hold=60 keeps cards up (screenshots / testing)
  const [up, setUp] = createSignal(false);
  let stopDuel: (() => void) | null = null;
  let currentDuel: string | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let n = 0;

  const LIFE: Record<Card['kind'], number> = { raid: 14_000, clip: 9_000, recap: 16_000, toast: 7_000 };
  const card = (c: Omit<Card, 'id'>) => {
    const id = ++n;
    setCards((all) => [...all.slice(-3), { ...c, id }]);
    setTimeout(() => setCards((all) => all.filter((x) => x.id !== id)), hold || LIFE[c.kind]);
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
    else if (ev.type === 'raid') card({
      kind: 'raid', who: ev.from.displayName, title: `${ev.from.displayName} is raiding!`,
      sub: `${ev.viewers} ${ev.viewers === 1 ? 'raider' : 'raiders'}${ev.game ? ` from ${ev.game}` : ''} · welcome in 💜`,
      badge: ev.raidCount > 1 ? `RAID #${ev.raidCount}` : 'FIRST RAID',
    });
    else if (ev.type === 'clip') card({
      kind: 'clip', title: 'Clipped that! 🎬', badge: `${ev.clip.score.toFixed(1)}× HYPE`,
      sub: ev.clip.quote ? `chat: “${ev.clip.quote}”` : 'chat went wild',
    });
    else if (ev.type === 'recap') card({ kind: 'recap', title: 'Stream recap', sub: '', lines: ev.lines, badge: '!recap' });
    else if (ev.type === 'toast') card({ kind: 'toast', title: ev.text, sub: 'Raid Network' });
  }, setUp);
  onCleanup(() => { stop(); stopDuel?.(); });

  return (
    <div class="overlay-root">
      <Show when={debug}><div class="ol-debug mono">overlay:{channel} · {up() ? 'connected' : 'connecting…'}</div></Show>
      <Show when={duel()}>{(s) => <div class="ol-duel"><DuelBoard state={s()} offset={offset()} variant="overlay" /></div>}</Show>
      <div class="ol-cards">
        <For each={cards()}>{(c) => (
          <div class={`ol-card ${c.kind}`}>
            <Show when={c.who}><Avatar name={c.who!} size={52} /></Show>
            <Show when={c.kind === 'clip'}><div class="ol-icon">▶</div></Show>
            <div class="ol-card-body">
              <Show when={c.badge}><div class="ol-badge mono">{c.badge}</div></Show>
              <div class="ol-card-title">{c.title}</div>
              <Show when={c.sub}><div class="ol-card-sub">{c.sub}</div></Show>
              <Show when={c.lines}><ul class="ol-lines"><For each={c.lines}>{(l) => <li>{l}</li>}</For></ul></Show>
            </div>
          </div>
        )}</For>
      </div>
      <style>{`
        .overlay-root { position: fixed; inset: 0; font-family: var(--font-body); color: var(--text); }
        .ol-debug { position: absolute; top: 8px; left: 8px; font-size: 12px; background: rgba(0,0,0,.6); padding: 4px 8px; border-radius: 6px; }
        .ol-duel { position: absolute; top: 24px; left: 50%; transform: translateX(-50%); animation: drop .5s cubic-bezier(.3,1.4,.5,1); }
        .ol-cards { position: absolute; bottom: 40px; left: 40px; display: grid; gap: 14px; justify-items: start; }
        .ol-card { display: flex; align-items: center; gap: 16px; min-width: 380px; max-width: 560px; padding: 16px 22px 16px 16px; border-radius: 20px;
          background: linear-gradient(135deg, rgba(139,92,246,.96), rgba(80,40,180,.96)); color: #fff;
          border: 1px solid rgba(255,255,255,.25); box-shadow: 0 20px 50px -10px rgba(139,92,246,.7); animation: drop .5s cubic-bezier(.3,1.4,.5,1); }
        .ol-card.toast { padding-left: 22px; }
        .ol-card.raid { background: linear-gradient(135deg, #c8ff4d, #7dffb0); color: #12091f; box-shadow: 0 20px 60px -12px rgba(200,255,77,.65); }
        .ol-card.raid .avatar { box-shadow: 0 0 0 3px #12091f; }
        .ol-card.clip { background: linear-gradient(135deg, #ff4fa3, #8b5cf6); box-shadow: 0 20px 60px -12px rgba(255,79,163,.7); }
        .ol-card.recap { align-items: flex-start; background: linear-gradient(160deg, rgba(18,11,34,.96), rgba(40,22,80,.96)); border-color: rgba(68,225,255,.5); box-shadow: 0 20px 60px -12px rgba(68,225,255,.45); padding-left: 22px; }
        .ol-icon { width: 52px; height: 52px; border-radius: 16px; display: grid; place-items: center; font-size: 22px; background: rgba(255,255,255,.18); border: 2px solid rgba(255,255,255,.5); }
        .ol-card-body { display: grid; gap: 2px; min-width: 0; }
        .ol-badge { justify-self: start; font-size: 11px; font-weight: 700; letter-spacing: .12em; padding: 2px 8px; border-radius: 6px; background: rgba(0,0,0,.22); }
        .ol-card.raid .ol-badge { background: #12091f; color: #c8ff4d; }
        .ol-card.recap .ol-badge { background: rgba(68,225,255,.16); color: #44e1ff; }
        .ol-card-title { font: 800 22px var(--font-display); line-height: 1.15; }
        .ol-card-sub { font-weight: 700; opacity: .88; }
        .ol-lines { margin: 6px 0 0; padding: 0; list-style: none; display: grid; gap: 3px; font-weight: 600; font-size: 15px; }
        @keyframes drop { from { transform: translate(var(--tx, 0), -30px); opacity: 0; } }
        .ol-duel { --tx: -50%; }
      `}</style>
    </div>
  );
}
