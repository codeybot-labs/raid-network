import { createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import type { RaidGraph, RaidNode } from '../../shared/types';
import { api } from '../lib/api';
import { Skeleton } from './ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';

const W = 1000;
const H = 560;
type SimNode = RaidNode & { x: number; y: number; vx: number; vy: number; r: number; fixed?: boolean };

/** Small dependency-free force layout: repulsion + edge springs + centering, cooled over ~6s. */
export default function RaidMap() {
  const [scope, setScope] = createSignal<'me' | 'all'>('me');
  const [graph] = createResource(scope, (s) => api<RaidGraph>(`/api/network?scope=${s}`));
  const [tick, setTick] = createSignal(0);
  const [hover, setHover] = createSignal<string | null>(null);
  let nodes: SimNode[] = [];
  let byId = new Map<string, SimNode>();
  let alpha = 1;
  let raf = 0;
  let svgEl: SVGSVGElement | undefined;

  const init = (g: RaidGraph) => {
    nodes = g.nodes.map((n, i) => {
      const a = (i / Math.max(1, g.nodes.length)) * Math.PI * 2;
      const rad = n.isMe ? 0 : 180 + (i % 3) * 40;
      return { ...n, x: W / 2 + Math.cos(a) * rad, y: H / 2 + Math.sin(a) * rad * 0.7, vx: 0, vy: 0,
        r: Math.min(30, 7 + Math.sqrt(Math.max(1, n.viewers)) * 1.7) + (n.isMe ? 6 : 0), fixed: false };
    });
    byId = new Map(nodes.map((n) => [n.id, n]));
    alpha = 1;
    cancelAnimationFrame(raf);
    const step = () => {
      simulate(g);
      setTick((t) => t + 1);
      alpha *= 0.985;
      if (alpha > 0.02) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const simulate = (g: RaidGraph) => {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy || 0.01;
        const min = a.r + b.r + 26;
        const f = (7000 / d2 + (d2 < min * min ? 0.6 : 0)) * alpha;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
      }
    }
    for (const e of g.edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 170) * 0.01 * alpha * Math.min(2, 0.6 + e.count * 0.3);
      a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.004 * alpha * (n.isMe ? 6 : 1);
      n.vy += (H / 2 - n.y) * 0.006 * alpha * (n.isMe ? 6 : 1);
      if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.82; n.vy *= 0.82;
      n.x = Math.max(n.r + 4, Math.min(W - n.r - 4, n.x + n.vx));
      n.y = Math.max(n.r + 4, Math.min(H - n.r - 18, n.y + n.vy));
    }
  };

  onCleanup(() => cancelAnimationFrame(raf));

  const neighbours = (id: string) => {
    const s = new Set([id]);
    for (const e of graph()?.edges ?? []) { if (e.from === id) s.add(e.to); if (e.to === id) s.add(e.from); }
    return s;
  };

  const toSvg = (ev: PointerEvent) => {
    const r = svgEl!.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H };
  };
  const drag = (n: SimNode) => (ev: PointerEvent) => {
    (ev.target as Element).setPointerCapture(ev.pointerId);
    n.fixed = true;
    const g = graph()!;
    const move = (e: PointerEvent) => {
      const p = toSvg(e); n.x = p.x; n.y = p.y;
      alpha = Math.max(alpha, 0.3); simulate(g); setTick((t) => t + 1);
    };
    const up = () => { n.fixed = false; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const edgePath = (ax: number, ay: number, bx: number, by: number, br: number) => {
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const dx = bx - ax, dy = by - ay;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const cx = mx - (dy / d) * d * 0.18, cy = my + (dx / d) * d * 0.18;
    // Stop at target circle edge.
    const tx = bx - cx, ty = by - cy;
    const td = Math.sqrt(tx * tx + ty * ty) || 1;
    return `M${ax},${ay} Q${cx},${cy} ${bx - (tx / td) * (br + 4)},${by - (ty / td) * (br + 4)}`;
  };

  return (
    <div class="raidmap">
      <div class="raidmap-bar">
        <Tabs value={scope()} onChange={(v) => setScope(v as 'me' | 'all')}>
          <TabsList><TabsTrigger value="me">My network</TabsTrigger><TabsTrigger value="all">Everyone</TabsTrigger></TabsList>
        </Tabs>
        <Show when={graph()}>{(g) => <span class="dim mono">{g().nodes.length} channels · {g().edges.reduce((s, e) => s + e.count, 0)} raids</span>}</Show>
      </div>
      <Show when={graph()} fallback={<Skeleton class="m-4 h-[420px]" />}>
        {(g) => {
          init(g());
          return (
            <Show when={g().edges.length} fallback={<div class="empty">No raids recorded yet. Raid someone and it'll appear here.</div>}>
              <svg ref={svgEl} viewBox={`0 0 ${W} ${H}`} class="raidmap-svg" role="img" aria-label="Raid network graph">
                <defs>
                  <marker id="rm-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#a9a6c2" /></marker>
                  <marker id="rm-arrow-hot" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#d4101f" /></marker>
                  <radialGradient id="rm-me"><stop offset="0" stop-color="#f0323f" /><stop offset="1" stop-color="#d4101f" /></radialGradient>
                </defs>
                {(() => { tick(); return null; })()}
                <g>
                  <For each={g().edges}>
                    {(e) => {
                      const meId = g().nodes.find((n) => n.isMe)?.id;
                      const hot = () => e.from === meId || e.to === meId;
                      const dim = () => { const h = hover(); return h !== null && e.from !== h && e.to !== h; };
                      return (
                        <path
                          d={(tick(), (() => { const a = byId.get(e.from), b = byId.get(e.to); return a && b ? edgePath(a.x, a.y, b.x, b.y, b.r) : ''; })())}
                          fill="none" stroke={hot() ? '#d4101f' : '#a9a6c2'} stroke-opacity={dim() ? 0.08 : hot() ? 0.8 : 0.55}
                          stroke-width={1 + Math.min(4, e.count)} marker-end={hot() ? 'url(#rm-arrow-hot)' : 'url(#rm-arrow)'}>
                          <title>{`${byId.get(e.from)?.displayName} → ${byId.get(e.to)?.displayName}: ${e.count} raid(s), ${e.viewers} viewers`}</title>
                        </path>
                      );
                    }}
                  </For>
                </g>
                <g>
                  <For each={nodes}>
                    {(n) => {
                      const dim = () => { const h = hover(); return h !== null && !neighbours(h).has(n.id); };
                      return (
                        <g transform={(tick(), `translate(${n.x},${n.y})`)} opacity={dim() ? 0.25 : 1} class="rm-node"
                          onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)} onPointerDown={drag(n)}>
                          <circle r={n.r} fill={n.isMe ? 'url(#rm-me)' : n.live ? '#1c4fd8' : '#e6e4ef'} stroke={n.isMe ? '#fff' : n.live ? '#fff' : '#b7b4cc'} stroke-opacity={1} stroke-width={n.isMe ? 4 : 2} />
                          <Show when={n.live && !n.isMe}><circle r={3.5} cx={n.r * 0.7} cy={-n.r * 0.7} fill="#d4101f" stroke="#fff" stroke-width="1.5" /></Show>
                          <text y={n.r + 14} text-anchor="middle" class="rm-label" font-weight={n.isMe ? 800 : 600}>{n.isMe ? `${n.displayName} (you)` : n.displayName}</text>
                        </g>
                      );
                    }}
                  </For>
                </g>
              </svg>
            </Show>
          );
        }}
      </Show>
    </div>
  );
}
