// Dashboard assistant: grounded in the streamer's own data (matchmaking, growth, duels, raid map).
// It answers and may *offer* actions as buttons (Raid / Duel / links). It never raids or invites by itself:
// buttons open the same confirm dialogs as the dashboard.
import { isDemo, overlayStub, type Env } from '../env';
import type { AssistantAction, AssistantEvent, GrowthReport, Match, MatchmakingResponse, Viewer } from '../../shared/types';
import { aiConfig, aiStream, type AiMessage } from './ai';
import { fmtDur } from './cohost';
import { demoFindStream, ensureDemoSeed } from './demo';
import { listStreams, streamReport } from './growth';
import { appToken, getUsers } from './helix';
import { matchmaking, raidGraph } from './matchmaking';

export type Intent = 'raid' | 'duel' | 'growth' | 'network' | 'duels' | 'help';

export interface AssistantCtx {
  mm: MatchmakingResponse;
  report: GrowthReport | null;
  reportIsLive: boolean;
  duels: { id: string; format: string; mode: string; result: 'win' | 'loss' | 'tie'; others: string; endedAt: number }[];
  network: { partners: number; raidsIn: number; raidsOut: number; topIn: { name: string; n: number }[]; topOut: { name: string; n: number }[] };
}

const STOP = new Set(['me', 'someone', 'somebody', 'anyone', 'a', 'an', 'the', 'my', 'with', 'against', 'them', 'him', 'her', 'up', 'tonight', 'now', 'who', 'one', 'someone?']);

export function detectIntent(q: string): { intent: Intent; target: string | null } {
  const t = q.toLowerCase();
  const m = /(?:duel|challenge|battle|versus|vs\.?|against|collab)\s+(?:with\s+|against\s+|vs\.?\s+)?@?([a-z0-9_]{2,25})\b/i.exec(q);
  const target = m && !STOP.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
  if (/\b(duel|challenge|battle)\b/.test(t) && !/\b(history|record|how did|won|lost|results?)\b/.test(t)) return { intent: 'duel', target };
  if (/\b(last stream|stream go|how did (my|i|the)|growth|new chatters|my stats|today'?s stream|recap|how am i doing)\b/.test(t)) return { intent: 'growth', target: null };
  if (/\b(network|map|who raids|raided me|raid history|my raiders)\b/.test(t)) return { intent: 'network', target: null };
  if (/\b(duels?|record|wins?|losses)\b/.test(t)) return { intent: 'duels', target: null };
  if (/\b(raid|partner|collab|who should|host|shout ?out|similar|my size)\b/.test(t)) return { intent: 'raid', target };
  return { intent: 'help', target };
}

export async function buildContext(env: Env, v: Viewer): Promise<AssistantCtx> {
  if (isDemo(env)) await ensureDemoSeed(env);
  const ref = { id: v.id, login: v.login, displayName: v.displayName };
  const [mm, live] = await Promise.all([matchmaking(env, v), overlayStub(env, v.login).currentStream(ref).catch(() => null)]);
  const streams = await listStreams(env, v.id, 6);
  // "Last stream" = the most recent finished one; fall back to the live session.
  const ended = streams.find((s) => s.endedAt);
  const pickId = ended?.id ?? live ?? streams[0]?.id ?? null;
  const report = pickId ? await streamReport(env, pickId) : null;
  const rows = await env.DB.prepare(`SELECT d.id, d.format, d.mode, d.winner, d.ended_at, dc.side,
      (SELECT group_concat(COALESCE(o.display_name, o.login), ', ') FROM duel_channels o WHERE o.duel_id = d.id AND o.channel_id != ?1 AND o.status IN ('host', 'accepted')) AS others
    FROM duels d JOIN duel_channels dc ON dc.duel_id = d.id AND dc.channel_id = ?1
    WHERE d.status = 'finished' ORDER BY d.ended_at DESC LIMIT 10`).bind(v.id)
    .all<{ id: string; format: string; mode: string; winner: string | null; ended_at: number; side: string; others: string | null }>();
  const duels = rows.results.map((r) => ({
    id: r.id, format: r.format, mode: r.mode, others: r.others ?? '?', endedAt: r.ended_at,
    result: r.winner === 'tie' ? 'tie' as const : r.winner === r.side ? 'win' as const : 'loss' as const,
  }));
  const g = await raidGraph(env, v, 'me');
  const name = new Map(g.nodes.map((n) => [n.id, n.displayName]));
  const ins = g.edges.filter((e) => e.to === v.id);
  const outs = g.edges.filter((e) => e.from === v.id);
  const top = (es: typeof ins, key: 'from' | 'to') => [...es].sort((a, b) => b.count - a.count).slice(0, 3).map((e) => ({ name: name.get(e[key]) ?? '?', n: e.count }));
  return {
    mm, report, reportIsLive: !!report?.live, duels,
    network: { partners: new Set([...ins.map((e) => e.from), ...outs.map((e) => e.to)]).size, raidsIn: ins.reduce((s, e) => s + e.count, 0),
      raidsOut: outs.reduce((s, e) => s + e.count, 0), topIn: top(ins, 'from'), topOut: top(outs, 'to') },
  };
}

async function resolveTarget(env: Env, ctx: AssistantCtx, target: string): Promise<{ id?: string; login: string; displayName: string } | null> {
  const m = ctx.mm.matches.find((x) => x.stream.login === target || x.stream.displayName.toLowerCase() === target);
  if (m) return { id: m.stream.id, login: m.stream.login, displayName: m.stream.displayName };
  if (isDemo(env)) { const s = demoFindStream(target); return s ? { id: s.id, login: s.login, displayName: s.displayName } : null; }
  try {
    const [u] = await getUsers(env, await appToken(env), { logins: [target] });
    return u ? { id: u.id, login: u.login, displayName: u.display_name } : null;
  } catch { return null; }
}

const raidAction = (m: Match): AssistantAction => ({ type: 'raid', id: m.stream.id, login: m.stream.login, displayName: m.stream.displayName, viewers: m.stream.viewerCount, gameName: m.stream.gameName });
const duelAction = (m: Match): AssistantAction => ({ type: 'duel', id: m.stream.id, login: m.stream.login, displayName: m.stream.displayName });

// ---------------------------------------------------------------- Template answers (mock provider + fallback) ----------------------------------------------------------------

function growthMd(r: GrowthReport): string {
  const s = r.stream;
  const raidV = r.raidsIn.reduce((a, x) => a + x.viewers, 0);
  const w = r.duels.filter((d) => d.result === 'win').length;
  const l = r.duels.filter((d) => d.result === 'loss').length;
  const newShare = s.chatters ? Math.round((s.newChatters / s.chatters) * 100) : 0;
  const tip = r.raidsIn.length && !r.raidsOut.length ? 'You received raids but did not raid out. Raiding back is the easiest way to keep those friendships going.'
    : newShare >= 30 ? `${newShare}% of chatters were new. A \`!recap\` near the end helps them stick around.`
    : 'Try a duel with a partner your size: duels bring a second chat into yours for the whole round.';
  return [
    `**${s.title ?? 'Your stream'}**${s.gameName ? ` · *${s.gameName}*` : ''} · ${r.live ? 'live now' : 'ended'} · ${fmtDur(r.durationMs)}`,
    '',
    `- 👀 Peak viewers: **${s.peakViewers}**`,
    `- 💬 ${s.messages} messages from ${s.chatters} chatters (**${s.newChatters} new**, ${r.returningChatters} returning)`,
    `- 🚀 Raids in: **${r.raidsIn.length}**${r.raidsIn.length ? ` (+${raidV} viewers)` : ''} · raids out: ${r.raidsOut.length}`,
    `- 🎬 Auto-clips: ${r.clips.length}`,
    `- ⚔ Duels: ${r.duels.length ? `${w}W-${l}L` : 'none'}`,
    '',
    `**Tip:** ${tip}`,
  ].join('\n');
}

export async function templateAnswer(env: Env, ctx: AssistantCtx, intent: Intent, target: string | null): Promise<{ text: string; actions: AssistantAction[] }> {
  const mm = ctx.mm;
  const top = mm.matches.slice(0, 3);
  switch (intent) {
    case 'raid': {
      if (!top.length) return { text: `Nobody in your range (${mm.range[0]}–${mm.range[1]} viewers) is live in **${mm.gameName || 'your category'}** right now. Check back in a few minutes; the live list refreshes every 10 minutes.`, actions: [] };
      const lines = top.map((m, i) => `${i + 1}. **${m.stream.displayName}** · ${m.stream.viewerCount} viewers · score ${m.score}: ${m.reasons.slice(0, 2).join(', ').toLowerCase()}`);
      return {
        text: [`**Best raid picks right now** in *${mm.gameName}* (you're at ~${mm.baseViewers} viewers, matching ${mm.range[0]}–${mm.range[1]}):`, '', ...lines, '',
          `**${top[0].stream.displayName}** is my top pick${top[0].raidedYou ? ': they raided you before, so this returns the favor' : ''}. Tap a **Raid** button below to start; nothing happens until you confirm.`].join('\n'),
        actions: top.map(raidAction),
      };
    }
    case 'duel': {
      if (target) {
        const t = await resolveTarget(env, ctx, target);
        if (!t) return { text: `I couldn't find a Twitch channel called **${target}**. Check the spelling, or pick a live partner below.`, actions: top.slice(0, 2).map(duelAction) };
        const m = mm.matches.find((x) => x.stream.login === t.login);
        const size = m ? ` They're live with ${m.stream.viewerCount} viewers (${m.ratio.toFixed(1)}× your size).` : '';
        return {
          text: `Ready to set up a duel with **${t.displayName}**.${size}\n\n- **Tug of War**: both chats spam \`!pull\`\n- **Chat Poll**: both chats vote \`!1\`–\`!4\` on one question\n\nTap **Duel ${t.displayName}** to open the duel setup. The invite is only sent when you confirm there.`,
          actions: [{ type: 'duel', ...t }],
        };
      }
      if (!top.length) return { text: 'Nobody your size is live to duel right now. You can still challenge anyone by Twitch name: say "set up a duel with *name*".', actions: [] };
      return { text: `Good duel partners live now: ${top.map((m) => `**${m.stream.displayName}** (${m.stream.viewerCount})`).join(', ')}. Tap one to open the duel setup, or say "set up a duel with *name*".`, actions: top.map(duelAction) };
    }
    case 'growth':
      if (!ctx.report) return { text: "I don't have a stream on record yet. Once you go live, I'll track chatters, raids, clips and duels for your growth report.", actions: [] };
      return { text: growthMd(ctx.report), actions: [{ type: 'link', href: `/growth/?stream=${encodeURIComponent(ctx.report.stream.id)}`, label: 'Open growth report' }] };
    case 'network': {
      const n = ctx.network;
      const list = (xs: { name: string; n: number }[]) => (xs.length ? xs.map((x) => `${x.name} (${x.n}×)`).join(', ') : 'none yet');
      return {
        text: `**Your raid network** (last 180 days)\n\n- 🤝 ${n.partners} raid partners\n- ⬅ Raids in: **${n.raidsIn}**, mostly from ${list(n.topIn)}\n- ➡ Raids out: **${n.raidsOut}**, mostly to ${list(n.topOut)}\n\n${n.raidsIn > n.raidsOut ? "You've received more raids than you've sent. Raiding back keeps the network healthy." : 'Nice balance of give and take.'}`,
        actions: [{ type: 'link', href: '/dashboard/#network', label: 'Open raid map' }],
      };
    }
    case 'duels': {
      if (!ctx.duels.length) return { text: 'No finished duels yet. Want to start one? Say "set up a duel with *name*".', actions: top.slice(0, 2).map(duelAction) };
      const w = ctx.duels.filter((d) => d.result === 'win').length;
      const l = ctx.duels.filter((d) => d.result === 'loss').length;
      const lines = ctx.duels.slice(0, 5).map((d) => `- ${d.result === 'win' ? '🏆 Won' : d.result === 'loss' ? '💀 Lost' : '🤝 Tied'} vs ${d.others} (${d.format === 'ffa' ? 'free-for-all' : d.format}, ${d.mode === 'tug' ? 'tug' : 'poll'})`);
      return { text: [`**Duel record: ${w}W-${l}L** over your last ${ctx.duels.length} duels.`, '', ...lines].join('\n'), actions: top.slice(0, 1).map(duelAction) };
    }
    default:
      return {
        text: [`Hi ${mm.me.displayName}! I can help with:`, '', '- **Who to raid**: live streamers your size in your game',
          '- **Duels**: "set up a duel with *name*"', '- **Growth**: "how did my last stream go?"', '- **Raid network**: who raids you and who you raid', '',
          'I only suggest. Raids and invites happen when you tap the buttons and confirm.'].join('\n'),
        actions: [],
      };
  }
}

// ---------------------------------------------------------------- Run ----------------------------------------------------------------

function compactContext(ctx: AssistantCtx) {
  const r = ctx.report;
  return {
    me: { name: ctx.mm.me.displayName, live: ctx.mm.live, viewers: ctx.mm.baseViewers, game: ctx.mm.gameName, matchRange: ctx.mm.range },
    matches: ctx.mm.matches.slice(0, 8).map((m) => ({ name: m.stream.displayName, login: m.stream.login, viewers: m.stream.viewerCount, score: m.score, ratio: +m.ratio.toFixed(2), reasons: m.reasons, title: m.stream.title.slice(0, 80) })),
    lastStream: r ? {
      title: r.stream.title, game: r.stream.gameName, live: r.live, duration: fmtDur(r.durationMs), peakViewers: r.stream.peakViewers, messages: r.stream.messages,
      chatters: r.stream.chatters, newChatters: r.stream.newChatters, returningChatters: r.returningChatters, raidsIn: r.raidsIn.map((x) => `${x.from.displayName} (+${x.viewers})`),
      raidsOut: r.raidsOut.map((x) => x.to.displayName), clips: r.clips.length, duels: r.duels.map((d) => `${d.result} vs ${d.opponent.displayName} ${d.myScore}-${d.theirScore}`),
      topChatters: r.topChatters.slice(0, 3).map((t) => t.login),
    } : null,
    duelHistory: ctx.duels.slice(0, 8).map((d) => `${d.result} vs ${d.others} (${d.format}/${d.mode})`),
    raidNetwork: ctx.network,
  };
}

const SYSTEM = [
  'You are the Raid Network assistant inside a Twitch streamer\'s dashboard. You help them grow with raids, duels and stats.',
  'Answer in concise markdown (short paragraphs, bullet lists, **bold** names), under 160 words.',
  'Use ONLY facts from CONTEXT; never invent numbers or streamers. If something is not in CONTEXT, say you don\'t have it.',
  'You cannot take actions. Raids and duel invites only happen when the streamer taps the buttons the app shows under your reply and confirms.',
  'Never say you started a raid or sent an invite; say "tap the button below". Be friendly, never negative about other streamers.',
].join(' ');

export async function runAssistant(env: Env, v: Viewer, history: AiMessage[], send: (ev: AssistantEvent) => Promise<void>): Promise<void> {
  const question = history[history.length - 1]?.content ?? '';
  const { intent, target } = detectIntent(question);
  const ctx = await buildContext(env, v);
  const tpl = await templateAnswer(env, ctx, intent, target);
  const cfg = aiConfig(env);
  await send({ type: 'meta', provider: cfg.provider, model: cfg.provider === 'ollama' ? cfg.model : null, intent });
  let full = '';
  let provider: 'ollama' | 'mock' = cfg.provider;
  let ok = true;
  const stream = aiStream(env, {
    messages: [
      { role: 'system', content: `${SYSTEM}\nDetected intent: ${intent}${target ? ` (target: ${target})` : ''}. Buttons the app will show: ${JSON.stringify(tpl.actions.map((a) => a.type === 'link' ? a.label : `${a.type} ${a.displayName}`))}.\nCONTEXT: ${JSON.stringify(compactContext(ctx))}` },
      ...history.slice(-10),
    ],
    maxTokens: 420, temperature: 0.5, timeoutMs: 15_000,
  }, () => tpl.text, { onProvider: (p, good) => { provider = p; ok = good; } });
  for await (const piece of stream) { full += piece; await send({ type: 'delta', text: piece }); }
  // Buttons: whatever the intent offers, plus raid buttons for live partners the model recommended by name.
  const actions = [...tpl.actions];
  if (provider === 'ollama' && ok && (intent === 'raid' || intent === 'help')) {
    for (const m of ctx.mm.matches.slice(0, 8)) {
      if (actions.length >= 4) break;
      if (full.includes(m.stream.displayName) && !actions.some((a) => a.type === 'raid' && a.id === m.stream.id)) actions.push(raidAction(m));
    }
  }
  if (actions.length) await send({ type: 'actions', actions });
  await send({ type: 'done', ok });
}
