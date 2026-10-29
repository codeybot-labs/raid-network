import { createResource, For, Show } from 'solid-js';
import type { AiFeature, AiSettings, AiSettingsResponse } from '../../shared/types';
import { api } from '../lib/api';
import { toast } from './Toasts';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Skeleton } from './ui/skeleton';
import { Switch, SwitchControl, SwitchDescription, SwitchLabel, SwitchThumb } from './ui/switch';
import { Tooltip } from './ui/tooltip';

const FEATURES: { key: AiFeature; title: string; blurb: string }[] = [
  { key: 'welcome', title: 'Raid welcomes', blurb: 'Personal shout-out using the raider’s game and title.' },
  { key: 'recap', title: '!recap', blurb: 'AI-written stream recap with your real numbers.' },
  { key: 'duel', title: 'Duel host', blurb: 'Announces rounds and winners, suggests poll questions.' },
  { key: 'ask', title: '!ask', blurb: 'Viewers ask about the stream; 60s cooldown per viewer.' },
  { key: 'pitch', title: 'Collab pitches', blurb: '“Why you’d collab” line on each match card.' },
];

/** Dashboard panel: per-feature toggles for the AI co-host in Twitch chat + the dashboard. */
export default function AiCohostPanel(props: { onChange?: (s: AiSettings) => void }) {
  const [data, { mutate }] = createResource(() => api<AiSettingsResponse>('/api/ai/settings'));
  const save = async (patch: Partial<AiSettings>) => {
    try {
      const r = await api<AiSettingsResponse>('/api/ai/settings', { json: patch });
      mutate(r); props.onChange?.(r.settings);
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <Card class="ai-panel">
      <CardHeader class="flex-row items-end justify-between gap-4 border-b border-border">
        <div><div class="eyebrow">AI co-host</div><CardTitle class="mt-1.5 text-xl">Chat bot &amp; AI features</CardTitle></div>
        <Show when={data()}>
          {(d) => (
            <Tooltip content={d().status.provider === 'ollama' ? 'Ollama Cloud' : 'Set OLLAMA_API_KEY to switch to Ollama Cloud'}>
              <Badge variant={d().status.provider === 'ollama' ? 'success' : 'muted'}>
                {d().status.provider === 'ollama' ? `Ollama · ${d().status.model}` : d().status.keySet ? 'Templates (demo mode)' : 'Templates (no AI key)'}
              </Badge>
            </Tooltip>
          )}
        </Show>
      </CardHeader>
      <CardContent class="pt-5">
        <Show when={data()} fallback={<Skeleton class="h-[84px]" />}>
          {(d) => (
            <>
              <div class="ai-toggles">
                <For each={FEATURES}>
                  {(f) => (
                    <Switch class="ai-toggle" classList={{ on: d().settings[f.key] }} checked={d().settings[f.key]} onChange={(v) => save({ [f.key]: v })}>
                      <SwitchControl class="mt-0.5"><SwitchThumb /></SwitchControl>
                      <span class="grid gap-1"><SwitchLabel>{f.title}</SwitchLabel><SwitchDescription class="text-xs text-muted-foreground">{f.blurb}</SwitchDescription></span>
                    </Switch>
                  )}
                </For>
              </div>
              <div class="ai-foot">
                <span class="muted">AI chat messages today: <b class="text-foreground">{d().usedToday}</b> /</span>
                <Input type="number" min="0" max="1000" class="h-8 w-20" value={d().settings.dailyCap} aria-label="Daily AI message cap"
                  onChange={(e) => save({ dailyCap: Math.max(0, Math.min(1000, Math.round(+e.currentTarget.value || 0))) })} />
                <span class="dim">Max 1 AI message per 20s per chat · replies under 300 characters · ban-word filter · falls back to templates on any error.</span>
              </div>
            </>
          )}
        </Show>
      </CardContent>
    </Card>
  );
}
