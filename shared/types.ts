// Types shared by the Worker and the Astro/Solid frontend.

export interface ChannelRef {
  id: string;
  login: string;
  displayName: string;
  avatarUrl?: string;
}

export interface StreamInfo extends ChannelRef {
  streamId: string;
  gameId: string;
  gameName: string;
  title: string;
  viewerCount: number;
  language: string;
  tags: string[];
  startedAt: string;
}

export interface StreamCache {
  gameId: string;
  gameName: string;
  fetchedAt: number;
  streams: StreamInfo[];
}

export interface Match {
  stream: StreamInfo;
  score: number;
  ratio: number;
  reasons: string[];
  raidedYou: number;
  youRaided: number;
}

export interface MatchmakingResponse {
  me: ChannelRef;
  myStream: StreamInfo | null;
  live: boolean;
  baseViewers: number;
  gameName: string;
  range: [number, number];
  matches: Match[];
  cacheAge: number;
  demo: boolean;
}

export interface Viewer extends ChannelRef {
  demo: boolean;
}

export interface RaidNode {
  id: string;
  login: string;
  displayName: string;
  viewers: number;
  live: boolean;
  isMe: boolean;
}

export interface RaidEdge {
  from: string;
  to: string;
  count: number;
  viewers: number;
  last: number;
}

export interface RaidGraph {
  nodes: RaidNode[];
  edges: RaidEdge[];
}

export type DuelMode = 'tug' | 'poll';
export type DuelStatus =
  | 'pending'
  | 'accepted'
  | 'countdown'
  | 'live'
  | 'finished'
  | 'declined'
  | 'cancelled';
export type Side = 'a' | 'b';

export interface DuelSide extends ChannelRef {
  score: number; // tug: counted pulls; poll: voters
  voters: number;
  poll: number[]; // per-option counts (poll mode)
}

export interface FeedItem {
  side: Side;
  login: string;
  text: string;
  at: number;
}

export interface DuelState {
  id: string;
  mode: DuelMode;
  status: DuelStatus;
  question: string;
  options: string[];
  durationS: number;
  createdAt: number;
  countdownEndsAt?: number;
  endsAt?: number;
  endedAt?: number;
  a: DuelSide; // challenger
  b: DuelSide; // opponent
  winner?: Side | 'tie';
  feed: FeedItem[];
  simulate: boolean;
  demo: boolean;
  serverNow: number;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  channelLogin: string;
  userId: string;
  login: string;
  displayName?: string;
  text: string;
  at: number;
}

export interface ClipInfo {
  id: string;
  url: string;
  editUrl?: string | null;
  score: number; // hype ratio: window rate / baseline
  rate: number; // messages per second in the hype window
  quote: string; // most common message in the window
  demo: boolean;
  createdAt: number;
}

export interface RaidWelcome {
  from: ChannelRef;
  viewers: number;
  raidCount: number; // including this one
  game?: string | null;
  message?: string | null; // chat shout-out text that was sent
  status?: BotMessageStatus;
}

export type BotMessageStatus = 'sent' | 'demo' | 'failed' | 'dropped' | 'cooldown' | 'offline';

export type OverlayEvent =
  | { type: 'hello'; channel: string; activeDuelId: string | null }
  | { type: 'duel'; duelId: string | null; status?: DuelStatus }
  | ({ type: 'raid' } & RaidWelcome)
  | { type: 'clip'; clip: ClipInfo }
  | { type: 'recap'; lines: string[]; text: string }
  | { type: 'toast'; text: string };

// ---------- Growth page ----------
export interface TimelinePoint { t: number; msgs: number; chatters: number; viewers: number }

export interface StreamSummary {
  id: string;
  title: string | null;
  gameName: string | null;
  startedAt: number;
  endedAt: number | null;
  peakViewers: number;
  messages: number;
  chatters: number;
  newChatters: number;
  raidsIn: number;
  source: string;
}

export interface GrowthReport {
  stream: StreamSummary;
  durationMs: number;
  live: boolean;
  timeline: TimelinePoint[];
  raidsIn: { from: ChannelRef; viewers: number; at: number }[];
  raidsOut: { to: ChannelRef; viewers: number; at: number }[];
  clips: ClipInfo[];
  duels: { id: string; opponent: ChannelRef; mode: string; result: 'win' | 'loss' | 'tie'; myScore: number; theirScore: number; at: number }[];
  newChatterList: { login: string; messages: number }[];
  topChatters: { login: string; messages: number; isNew: boolean }[];
  returningChatters: number;
  botMessages: { kind: string; text: string; status: string; at: number }[];
}

export interface GrowthResponse {
  channel: ChannelRef;
  streams: StreamSummary[];
  report: GrowthReport | null;
  demo: boolean;
}
