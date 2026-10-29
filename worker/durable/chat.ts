// Chat command parsing shared by DuelDO (votes) and OverlayDO (future: !recap, hype detection).
import type { DuelMode } from '../../shared/types';

export type ParsedVote = { kind: 'pull' } | { kind: 'poll'; option: number } | null;

export function parseVote(mode: DuelMode, text: string, optionCount: number): ParsedVote {
  const t = text.trim().toLowerCase();
  if (mode === 'tug') {
    return /^(!pull|!tug|!p|pull|tug)\b/.test(t) ? { kind: 'pull' } : null;
  }
  const m = /^(?:!vote\s*|!)?([1-9])\b/.exec(t);
  if (!m) return null;
  const option = Number(m[1]) - 1;
  return option < optionCount ? { kind: 'poll', option } : null;
}

const ADJ = ['sleepy', 'turbo', 'cozy', 'feral', 'pixel', 'sneaky', 'mega', 'tiny', 'spicy', 'lucky', 'chaotic', 'silent', 'cosmic', 'crispy'];
const NOUN = ['otter', 'gremlin', 'potato', 'wizard', 'badger', 'noodle', 'falcon', 'pancake', 'goblin', 'comet', 'frog', 'llama', 'yeti', 'moth'];

export function fakeChatter(seed: number, sideTag: string): { id: string; login: string } {
  const a = ADJ[seed % ADJ.length];
  const n = NOUN[Math.floor(seed / ADJ.length) % NOUN.length];
  const num = (seed * 37) % 97;
  return { id: `sim-${sideTag}-${seed}`, login: `${a}${n}${num}` };
}

export const CHATTER_NOISE = ['LUL', 'lets gooo', 'PogChamp', 'KEKW', 'first time here!', 'o7', 'gg', 'HYPE', 'catJAM', 'W'];
