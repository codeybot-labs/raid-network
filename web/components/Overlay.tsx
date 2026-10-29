import { createSignal, For, onCleanup, Show } from 'solid-js';
import { DEFAULT_BOARD_SIZE, isBoardSize, type BoardSize, type DuelState, type OverlayEvent, type OverlaySettings } from '../../shared/types';
import { api } from '../lib/api';
import { liveSocket } from '../lib/api';
import Avatar from './Avatar';
import DuelBoard from './DuelBoard';
import './duel.css';

/** OBS browser source: /overlay/:channel. Transparent; shows duel board, raid welcomes and toasts. */
export default function Overlay() {
  const channel = (location.pathname.split('/').filter(Boolean)[1] ?? '').toLowerCase();
  const debug = new URLSearchParams(location.search).has('debug');
  // Board size: ?size=s|m|l wins; otherwise the streamer's saved default (one fetch on load, live 'size' pushes after).
  const sizeParam = new URLSearchParams(location.search).get('size')?.toLowerCase().slice(0, 1);
  const fixedSize = isBoardSize(sizeParam) ? sizeParam : null;
  const [size, setSize] = createSignal<BoardSize>(fixedSize ?? DEFAULT_BOARD_SIZE);
  if (!fixedSize) api<OverlaySettings>(`/api/overlay/${channel}/config`).then((r) => isBoardSize(r.size) && setSize(r.size)).catch(() => {});
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
      sub: `${ev.viewers} ${ev.viewers === 1 ? 'raider' : 'raiders'}${ev.game ? ` from ${ev.game}` : ''} · welcome in ❤️💙`,
      badge: ev.raidCount > 1 ? `RAID #${ev.raidCount}` : 'FIRST RAID',
    });
    else if (ev.type === 'clip') card({
      kind: 'clip', title: 'Clipped that!', badge: `${ev.clip.score.toFixed(1)}× HYPE`,
      sub: ev.clip.quote ? `chat: “${ev.clip.quote}”` : 'chat went wild',
    });
    else if (ev.type === 'recap') card({ kind: 'recap', title: 'Stream recap', sub: '', lines: ev.lines, badge: '!recap' });
    else if (ev.type === 'size') { if (!fixedSize && isBoardSize(ev.size)) setSize(ev.size); }
    else if (ev.type === 'toast') card({ kind: 'toast', title: ev.text, sub: 'Raid Network' });
  }, setUp);
  onCleanup(() => { stop(); stopDuel?.(); });

  return (
    <div class="overlay-root" data-board-size={size()}>
      <Show when={debug}><div class="ol-debug mono">overlay:{channel} · {up() ? 'connected' : 'connecting…'}</div></Show>
      <Show when={duel()}>{(s) => <div class="ol-duel"><div class={`ol-scale size-${size()}`} data-size={size()}><DuelBoard state={s()} offset={offset()} variant="overlay" /></div></div>}</Show>
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
        .overlay-root { position: fixed; inset: 0; font-family: var(--font-body); color: var(--ink); }
        .ol-debug { position: absolute; top: 8px; left: 8px; font-size: 12px; background: #fff; color: var(--ink); padding: 4px 8px; border-radius: 6px; }
        .ol-duel { position: absolute; top: 24px; left: 50%; transform: translateX(-50%); animation: drop .5s cubic-bezier(.3,1.4,.5,1); }
        .ol-cards { position: absolute; bottom: 40px; left: 40px; display: grid; gap: 14px; justify-items: start; }
        .ol-card { --acc: var(--red); --acc2: var(--blue); position: relative; display: flex; align-items: center; gap: 16px; min-width: 400px; max-width: 580px;
          padding: 16px 24px 16px 22px; border-radius: 20px; overflow: hidden; background: #fff; color: var(--ink);
          border: 1px solid var(--border); box-shadow: 6px 6px 0 var(--acc2), 0 24px 50px -16px rgba(20,18,43,.55); animation: drop .5s cubic-bezier(.3,1.4,.5,1); }
        .ol-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 7px; background: var(--acc); }
        .ol-card.clip, .ol-card.toast { --acc: var(--blue); --acc2: var(--red); }
        .ol-card.recap { align-items: flex-start; --acc: var(--ink); --acc2: var(--red); }
        .ol-card .avatar { box-shadow: 0 0 0 3px #fff, 0 0 0 6px var(--acc); }
        .ol-icon { width: 52px; height: 52px; flex: none; border-radius: 16px; display: grid; place-items: center; font-size: 20px; color: #fff; background: var(--acc); box-shadow: 3px 3px 0 var(--acc2); }
        .ol-card-body { display: grid; gap: 3px; min-width: 0; }
        .ol-badge { justify-self: start; font-size: 11px; font-weight: 800; letter-spacing: .12em; padding: 3px 9px; border-radius: 999px; background: var(--acc); color: #fff; }
        .ol-card-title { font: 900 23px var(--font-display); line-height: 1.15; letter-spacing: -0.01em; }
        .ol-card-sub { font-weight: 700; color: var(--muted-foreground); font-size: 15px; }
        .ol-lines { margin: 6px 0 0; padding: 0; list-style: none; display: grid; gap: 4px; font-weight: 600; font-size: 15px; }
        .ol-lines li::before { content: '▸ '; color: var(--red); }
        @keyframes drop { from { transform: translate(var(--tx, 0), -30px); opacity: 0; } }
        .ol-duel { --tx: -50%; }
        /* Board sizes on a 1920x1080 canvas. CSS zoom re-lays out at the bigger size (text stays vector-crisp, no transform blur).
           1v1 base is 800px wide, free-for-all/teams 920px. */
        .ol-scale { zoom: var(--board-zoom, 1); }
        .ol-scale.size-s { --board-zoom: 1; }
        .ol-scale.size-m { --board-zoom: 1.5; }
        .ol-scale.size-m:has(.board.ffa, .board.teams) { --board-zoom: 1.3; }
        .ol-scale.size-l { --board-zoom: 2.1; }
        .ol-scale.size-l:has(.board.ffa) { --board-zoom: 1.83; }
        /* Team boards are taller (rosters + top pullers), so large stops at ~1470px to keep the bottom of the stream visible. */
        .ol-scale.size-m:has(.board.teams) { --board-zoom: 1.25; }
        .ol-scale.size-l:has(.board.teams) { --board-zoom: 1.6; }
      `}</style>
    </div>
  );
}
