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
/** 1v1: two channels. ffa: 3-4 channels, one lane each. teams: Team A vs Team B, up to 4 channels per team. */
export type DuelFormat = '1v1' | 'ffa' | 'teams';
export type DuelStatus =
  | 'pending'
  | 'accepted'
  | 'countdown'
  | 'live'
  | 'finished'
  | 'declined'
  | 'cancelled';
/** Side key. 1v1 and teams use a/b; free-for-all lanes are a-d (host is always a). */
export type Side = 'a' | 'b' | 'c' | 'd';
export const SIDE_KEYS: Side[] = ['a', 'b', 'c', 'd'];
/** host = created the duel; dropped = still pending when the host started (removed from the board). */
export type InviteStatus = 'host' | 'pending' | 'accepted' | 'declined' | 'dropped';

export interface DuelSide extends ChannelRef {
  score: number; // tug: counted pulls; poll: voters
  voters: number;
  poll: number[]; // per-option counts (poll mode)
}

/** One channel taking part in a duel. Its chat counts for `side`. */
export interface DuelChannel extends DuelSide {
  side: Side;
  invite: InviteStatus;
}

/** Aggregated totals for one side (a channel in 1v1/ffa, a whole team in teams). */
export interface DuelSideState {
  key: Side;
  name: string;
  score: number;
  voters: number;
  poll: number[];
  channelIds: string[]; // active (host/accepted) channels on this side
}

export interface TopChatter { side: Side; login: string; channelLogin: string; count: number }

export interface FeedItem {
  side: Side;
  login: string;
  text: string;
  at: number;
  channel?: string; // channel login the message came from (multi-channel duels)
}

export interface DuelState {
  id: string;
  format: DuelFormat;
  mode: DuelMode;
  status: DuelStatus;
  question: string;
  options: string[];
  durationS: number;
  raceTarget: number; // ffa tug: pulls to reach the finish line (0 = none)
  createdAt: number;
  countdownEndsAt?: number;
  endsAt?: number;
  endedAt?: number;
  hostId: string;
  channels: DuelChannel[]; // every invited channel, incl. declined/dropped
  sides: DuelSideState[]; // sides with at least one active channel, in key order
  top: TopChatter[]; // top chatters per side (tug: pulls), refreshed on every broadcast
  /** Back-compat mirrors of sides a and b (in 1v1 these are exactly the two channels). */
  a: DuelSide; // challenger / Team A / lane A
  b: DuelSide; // opponent / Team B / lane B
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
  /** true = AI-personalized welcome; false = template (AI off, rate-limited or failed). */
  ai?: boolean;
}

export type BotMessageStatus = 'sent' | 'demo' | 'failed' | 'dropped' | 'cooldown' | 'offline';
/** Outcome of an AI chat feature: a sent message, or why nothing (or only the template) was sent. */
export type AiChatStatus = BotMessageStatus | 'disabled' | 'rate-limited' | 'daily-cap' | 'blocked';

export type OverlayEvent =
  | { type: 'hello'; channel: string; activeDuelId: string | null }
  | { type: 'duel'; duelId: string | null; status?: DuelStatus }
  | ({ type: 'raid' } & RaidWelcome)
  | { type: 'clip'; clip: ClipInfo }
  | { type: 'recap'; lines: string[]; text: string }
  | { type: 'toast'; text: string }
  | { type: 'size'; size: BoardSize };

// ---------- OBS overlay settings ----------
/** Duel board size on the 1920x1080 overlay: s ≈ 800-920px wide, m ≈ 1200px, l ≈ 1700px (default). */
export type BoardSize = 's' | 'm' | 'l';
export const BOARD_SIZES: readonly BoardSize[] = ['s', 'm', 'l'];
export const DEFAULT_BOARD_SIZE: BoardSize = 'l';
export const isBoardSize = (v: unknown): v is BoardSize => v === 's' || v === 'm' || v === 'l';
export interface OverlaySettings { size: BoardSize }

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
  raidsIn: { from: ChannelRef; viewers: number; at: number; confirmed: boolean }[];
  raidsOut: { to: ChannelRef; viewers: number; at: number; confirmed: boolean }[];
  clips: ClipInfo[];
  duels: { id: string; opponent: ChannelRef; format: DuelFormat; mode: string; result: 'win' | 'loss' | 'tie'; myScore: number; theirScore: number; at: number }[];
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

// ---------- AI co-host ----------
export type AiFeature = 'welcome' | 'recap' | 'duel' | 'ask' | 'pitch';
export const AI_FEATURES: AiFeature[] = ['welcome', 'recap', 'duel', 'ask', 'pitch'];

export interface AiSettings {
  welcome: boolean;
  recap: boolean;
  duel: boolean;
  ask: boolean;
  pitch: boolean;
  /** Max AI chat messages per channel per UTC day. */
  dailyCap: number;
}

export interface AiStatusInfo {
  provider: 'ollama' | 'mock';
  model: string | null;
  keySet: boolean;
  demo: boolean;
}

export interface AiSettingsResponse { settings: AiSettings; status: AiStatusInfo; usedToday: number }

/** Buttons the assistant may offer. The user clicks; the assistant never acts on its own. */
export type AssistantAction =
  | { type: 'raid'; id: string; login: string; displayName: string; viewers: number; gameName: string }
  | { type: 'duel'; id?: string; login: string; displayName: string }
  | { type: 'link'; href: string; label: string };

export type AssistantEvent =
  | { type: 'meta'; provider: 'ollama' | 'mock'; model: string | null; intent: string }
  | { type: 'delta'; text: string }
  | { type: 'actions'; actions: AssistantAction[] }
  | { type: 'error'; error: string }
  | { type: 'done'; ok: boolean };
