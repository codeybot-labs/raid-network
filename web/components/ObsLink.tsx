import { createSignal, onMount } from 'solid-js';
import Copy from 'lucide-solid/icons/copy';
import ExternalLink from 'lucide-solid/icons/external-link';
import { DEFAULT_BOARD_SIZE, isBoardSize, type BoardSize, type OverlaySettings } from '../../shared/types';
import { api } from '../lib/api';
import { toast } from './Toasts';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

export const SIZE_LABEL: Record<BoardSize, string> = { s: 'Small', m: 'Medium', l: 'Large' };
const SIZE_HINT: Record<BoardSize, string> = { s: '~800px, a corner of the stream', m: '~1200px wide', l: '~1700px, near full width' };
export const overlayUrl = (login: string, size: BoardSize) => `${location.origin}/overlay/${login}?size=${size}`;

/** The streamer's own saved default size, shared by every ObsLink on the page (one GET per page load). */
let mineP: Promise<BoardSize> | null = null;
const [mySize, setMySize] = createSignal<BoardSize>(DEFAULT_BOARD_SIZE);
const loadMine = () => (mineP ??= api<OverlaySettings>('/api/overlay-settings').then((r) => { setMySize(r.size); return r.size; }).catch(() => DEFAULT_BOARD_SIZE));

/**
 * OBS browser-source link card with a small / medium / large picker for the duel board.
 * On your own channel the pick is also saved as your default, so plain /overlay/<you> links use it too
 * (open overlays resize live). For other channels it only changes the copied URL.
 */
export default function ObsLink(props: { login: string; displayName?: string; mine: boolean; title?: string; note?: string }) {
  const [other, setOther] = createSignal<BoardSize>(DEFAULT_BOARD_SIZE);
  const size = () => (props.mine ? mySize() : other());
  onMount(() => { if (props.mine) loadMine(); });
  const pick = async (v: string | null) => {
    if (!isBoardSize(v)) return;
    if (!props.mine) return setOther(v);
    const prev = mySize(); setMySize(v);
    try { await api<OverlaySettings>('/api/overlay-settings', { json: { size: v } }); toast(`Duel board size saved: ${SIZE_LABEL[v]}`); }
    catch (e) { setMySize(prev); toast((e as Error).message, true); }
  };
  const url = () => overlayUrl(props.login, size());
  const copy = () => navigator.clipboard?.writeText(url()).then(() => toast('Copied'));
  return (
    <Card class="obs-link grid gap-2.5 p-5">
      <div class="eyebrow">{props.title ?? `OBS browser source · ${props.displayName ?? props.login}`}</div>
      <div class="flex flex-wrap items-center gap-3">
        <span class="text-xs font-bold text-muted-foreground">Duel board size</span>
        <ToggleGroup value={size()} onChange={pick} aria-label={`Duel board size for ${props.displayName ?? props.login}`}>
          <ToggleGroupItem value="s" class="data-[pressed]:bg-blue">S</ToggleGroupItem>
          <ToggleGroupItem value="m" class="data-[pressed]:bg-blue">M</ToggleGroupItem>
          <ToggleGroupItem value="l" class="data-[pressed]:bg-blue">L</ToggleGroupItem>
        </ToggleGroup>
        <span class="text-xs text-muted-foreground">{SIZE_LABEL[size()]} · {SIZE_HINT[size()]}{props.mine ? ' · saved as your default' : ''}</span>
      </div>
      <div class="ol-row"><code class="obs-url">{url()}</code>
        <Button size="sm" variant="soft" onClick={copy}><Copy /> Copy</Button>
        <Button as="a" size="sm" variant="ghost" href={`/overlay/${props.login}?size=${size()}&debug`} target="_blank"><ExternalLink /> Preview</Button></div>
      <div class="dim" style={{ 'font-size': '12px' }}>{props.note ?? 'Size 1920×1080, transparent background. The board appears when a duel starts.'}</div>
    </Card>
  );
}
