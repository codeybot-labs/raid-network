import { createResource, For, Show } from 'solid-js';
import type { AiFeature, AiSettings, AiSettingsResponse } from '../../shared/types';
import { api } from '../lib/api';
import { toast } from './Toasts';

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
    <section class="panel ai-panel">
      <div class="panel-head">
        <div><div class="eyebrow">AI co-host</div><h2>Chat bot & AI features</h2></div>
        <Show when={data()}>
          {(d) => (
            <span class={`chip ${d().status.provider === 'ollama' ? 'lime' : ''}`} title={d().status.provider === 'ollama' ? 'Ollama Cloud' : 'Set OLLAMA_API_KEY to switch to Ollama Cloud'}>
              {d().status.provider === 'ollama' ? `Ollama · ${d().status.model}` : d().status.keySet ? 'Templates (demo mode)' : 'Templates (no AI key)'}
            </span>
          )}
        </Show>
      </div>
      <div class="panel-body">
        <Show when={data()} fallback={<div class="skeleton" style={{ height: '84px' }} />}>
          {(d) => (
            <>
              <div class="ai-toggles">
                <For each={FEATURES}>
                  {(f) => (
                    <button type="button" class="ai-toggle" classList={{ on: d().settings[f.key] }} aria-pressed={d().settings[f.key]} onClick={() => save({ [f.key]: !d().settings[f.key] })}>
                      <span class="switch" />
                      <span><b>{f.title}</b><span class="dim">{f.blurb}</span></span>
                    </button>
                  )}
                </For>
              </div>
              <div class="ai-foot">
                <span class="muted">AI chat messages today: <b>{d().usedToday}</b> / </span>
                <input type="number" min="0" max="1000" value={d().settings.dailyCap} aria-label="Daily AI message cap"
                  onChange={(e) => save({ dailyCap: Math.max(0, Math.min(1000, Math.round(+e.currentTarget.value || 0))) })} />
                <span class="dim">Max 1 AI message per 20s per chat · replies under 300 characters · ban-word filter · falls back to templates on any error.</span>
              </div>
            </>
          )}
        </Show>
      </div>
    </section>
  );
}
