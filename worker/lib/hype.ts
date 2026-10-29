/**
 * Chat-velocity hype detector (pure, in-memory; lives inside a channel's OverlayDO).
 *
 * Chat is bucketed per second. A "hype moment" is when the rate over the last WINDOW seconds is
 * both above an absolute floor and RATIO× the baseline rate of the BASELINE seconds before it,
 * with enough distinct chatters (one spammer can't trigger it), and the channel's clip cooldown has passed.
 */
export interface HypeConfig {
  windowS: number;
  baselineS: number;
  minRate: number; // msgs/sec floor for the window
  ratio: number; // window rate must be ≥ ratio × baseline
  baselineFloor: number; // msgs/sec; a silent chat still needs a real burst
  minChatters: number;
  cooldownMs: number;
}

export const DEFAULT_HYPE: HypeConfig = {
  windowS: 10, baselineS: 120, minRate: 2, ratio: 4, baselineFloor: 0.25, minChatters: 8, cooldownMs: 120_000,
};

export interface HypeCheck {
  hype: boolean;
  reason: 'hype' | 'quiet' | 'few-chatters' | 'cooldown';
  rate: number;
  baseline: number;
  ratio: number;
  chatters: number;
  quote: string;
}

interface Bucket { n: number; users: Set<string>; texts: Map<string, number> }

export class HypeDetector {
  private buckets = new Map<number, Bucket>();
  constructor(private cfg: HypeConfig = DEFAULT_HYPE) {}

  add(atMs: number, userId: string, text: string): void {
    const sec = Math.floor(atMs / 1000);
    let b = this.buckets.get(sec);
    if (!b) this.buckets.set(sec, (b = { n: 0, users: new Set(), texts: new Map() }));
    b.n++;
    b.users.add(userId);
    const t = normalize(text);
    if (t) b.texts.set(t, (b.texts.get(t) ?? 0) + 1);
  }

  check(nowMs: number, lastClipAt: number): HypeCheck {
    const { windowS, baselineS } = this.cfg;
    const now = Math.floor(nowMs / 1000);
    this.prune(now);
    let wN = 0, bN = 0;
    const users = new Set<string>();
    const texts = new Map<string, number>();
    for (const [sec, b] of this.buckets) {
      const age = now - sec;
      if (age < windowS) {
        wN += b.n;
        b.users.forEach((u) => users.add(u));
        b.texts.forEach((c, t) => texts.set(t, (texts.get(t) ?? 0) + c));
      } else if (age < windowS + baselineS) bN += b.n;
    }
    const rate = wN / windowS;
    const baseline = bN / baselineS;
    const ratio = rate / Math.max(baseline, this.cfg.baselineFloor);
    const quote = [...texts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const out = { rate: round(rate), baseline: round(baseline), ratio: round(ratio), chatters: users.size, quote };
    if (rate < this.cfg.minRate || ratio < this.cfg.ratio) return { hype: false, reason: 'quiet', ...out };
    if (users.size < this.cfg.minChatters) return { hype: false, reason: 'few-chatters', ...out };
    if (nowMs - lastClipAt < this.cfg.cooldownMs) return { hype: false, reason: 'cooldown', ...out };
    return { hype: true, reason: 'hype', ...out };
  }

  private prune(nowSec: number) {
    const keep = this.cfg.windowS + this.cfg.baselineS;
    for (const sec of this.buckets.keys()) if (nowSec - sec >= keep) this.buckets.delete(sec);
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

/** "LETS GOOOOO!!!" → "lets goooo!!!": lowercased, trimmed, long letter runs collapsed, commands ignored. */
function normalize(text: string): string {
  const t = text.trim().toLowerCase().replace(/(.)\1{4,}/g, '$1$1$1$1').slice(0, 40);
  return t.startsWith('!') ? '' : t;
}
