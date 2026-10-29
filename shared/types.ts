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

export type OverlayEvent =
  | { type: 'hello'; channel: string; activeDuelId: string | null }
  | { type: 'duel'; duelId: string | null; status?: DuelStatus }
  | { type: 'raid'; from: ChannelRef; viewers: number }
  | { type: 'toast'; text: string };
