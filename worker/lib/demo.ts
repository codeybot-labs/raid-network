// DEMO_MODE data: realistic fake streamers, deterministic per 10-minute bucket, plus seeded raid history.
import type { Env } from '../env';
import type { StreamCache, StreamInfo } from '../../shared/types';

export const DEMO_ME = 'pixelpaladin';

export const DEMO_GAMES: { id: string; name: string; tags: string[] }[] = [
  { id: '490744', name: 'Stardew Valley', tags: ['Cozy', 'Chill', 'Farming', 'English', 'Vtuber', 'NoBackseating', 'FirstPlaythrough'] },
  { id: '27471', name: 'Minecraft', tags: ['Survival', 'Hardcore', 'Building', 'English', 'Modded', 'Chill', 'Speedrun'] },
  { id: '1469308723', name: 'Software and Game Development', tags: ['Coding', 'GameDev', 'Godot', 'Rust', 'English', 'Learning', 'Chill'] },
  { id: '516575', name: 'VALORANT', tags: ['Competitive', 'Ranked', 'FPS', 'English', 'Español', 'Grind', 'Funny'] },
];

const NAMES: Record<string, string[]> = {
  '490744': ['PixelPaladin', 'TurnipTycoon', 'CozyCorvid', 'MossyMarigold', 'ParsnipPrincess', 'HarvestHex', 'LunaLanterns', 'SlimeHutchSam',
    'OakenOtter', 'FernAndFriends', 'CrabPotCass', 'StarDropSteph', 'ValleyVibesVic', 'JunimoJen', 'PickleJarPete', 'QuietQuarry',
    'SprinkleSpud', 'WillowWisp', 'GingerIsleGabe', 'BlueberryBea', 'MinecartMika', 'FairyRoseFaye', 'TapperTheo', 'GreenhouseGia'],
  '27471': ['RedstoneRae', 'BlockyBard', 'CreeperCarl', 'NetherNell', 'EndermanEd', 'DiamondDeb', 'GravelGus', 'SkyblockSkye',
    'ObsidianOli', 'MineshaftMo', 'TorchTessa', 'BeaconBenji', 'PistonPia', 'CopperCody', 'AxolotlAmi', 'ElytraEli'],
  '1469308723': ['ShaderShiv', 'GodotGwen', 'RustyRefactor', 'PixelPushPat', 'NullPointerNia', 'TileMapTom', 'DevlogDara', 'BugHuntBex',
    'CommitCadet', 'LerpLord', 'SpriteSmith', 'JamWeekJules', 'ECSEmma', 'VoxelVince'],
  '516575': ['ClutchCleo', 'EcoRoundEnzo', 'OneTapTara', 'SpikeRushSid', 'FlankFiona', 'OperatorOmar', 'SmokesBySol', 'PeekPablo',
    'AcePendingAva', 'DefuseDex', 'LurkLuca', 'WhiffWendy', 'RadiantRio', 'HeadshotHana'],
};

const TITLES = ['day {n} of the grind', 'chill vibes + chat games', '!duel me — first playthrough', 'cozy morning stream ☕',
  'ranked until we win (or cry)', 'building the big thing', 'new viewers welcome!', 'raid train tonight 🚂', 'learning live, ask me anything'];

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Stable fake id for a demo login. */
export const demoId = (login: string) => `d${hash(login.toLowerCase()) % 90000000 + 10000000}`;

export function demoStreams(gameId: string, now = Date.now()): StreamCache {
  const game = DEMO_GAMES.find((g) => g.id === gameId) ?? DEMO_GAMES[0];
  const bucket = Math.floor(now / 600_000);
  const streams: StreamInfo[] = (NAMES[game.id] ?? []).map((name, i) => {
    const base = mulberry32(hash(name));
    // Log-normal-ish base audience: most streamers are small, a couple are mid-size.
    let baseViewers = Math.round(Math.exp(1.6 + base() * 3.4));
    if (name === 'PixelPaladin') baseViewers = 38;
    const jitter = mulberry32(hash(name) ^ bucket);
    const viewers = Math.max(1, Math.round(baseViewers * (0.85 + jitter() * 0.3)));
    const tags = [...game.tags].sort(() => base() - 0.5).slice(0, 2 + Math.floor(base() * 3));
    const startedAt = new Date(now - (15 + Math.floor(base() * 300)) * 60_000).toISOString();
    const login = name.toLowerCase();
    return {
      id: demoId(login), login, displayName: name, streamId: `s${hash(name + bucket)}`, gameId: game.id, gameName: game.name,
      title: TITLES[(i + Math.floor(base() * 9)) % TITLES.length].replace('{n}', String(3 + Math.floor(base() * 60))),
      viewerCount: viewers, language: game.id === '516575' && base() > 0.7 ? 'es' : 'en', tags, startedAt,
    };
  });
  streams.sort((a, b) => b.viewerCount - a.viewerCount);
  return { gameId: game.id, gameName: game.name, fetchedAt: now, streams };
}

export function demoFindStream(login: string): StreamInfo | null {
  for (const g of DEMO_GAMES) {
    const s = demoStreams(g.id).streams.find((x) => x.login === login.toLowerCase());
    if (s) return s;
  }
  return null;
}

export const allDemoLogins = () => DEMO_GAMES.flatMap((g) => (NAMES[g.id] ?? []).map((n) => n.toLowerCase()));

/** Seeds ~45 historical raids (mostly within Stardew Valley, a few cross-game) once per local DB. */
export async function ensureDemoSeed(env: Env): Promise<void> {
  if (await env.KV.get('demo:seeded')) return;
  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM raids WHERE source = 'demo'").first<{ n: number }>();
  if (!existing || existing.n === 0) {
    const rnd = mulberry32(42);
    const stardew = NAMES['490744'];
    const others = [...NAMES['27471'].slice(0, 5), ...NAMES['1469308723'].slice(0, 4)];
    const pick = (arr: string[]) => arr[Math.floor(rnd() * arr.length)];
    const now = Date.now();
    const rows: [string, string, number, number][] = [];
    // Your history: a few in, a few out.
    rows.push(['TurnipTycoon', 'PixelPaladin', 31, 2], ['TurnipTycoon', 'PixelPaladin', 27, 9], ['CozyCorvid', 'PixelPaladin', 44, 5],
      ['PixelPaladin', 'MossyMarigold', 36, 3], ['PixelPaladin', 'LunaLanterns', 29, 12], ['GodotGwen', 'PixelPaladin', 18, 20]);
    for (let i = 0; i < 40; i++) {
      const pool = rnd() < 0.8 ? stardew : [...stardew, ...others];
      const from = pick(pool);
      let to = pick(pool);
      if (to === from) to = pick(stardew);
      if (to === from) continue;
      rows.push([from, to, Math.round(5 + rnd() * 80), Math.floor(rnd() * 30)]);
    }
    const stmt = env.DB.prepare(
      `INSERT INTO raids (from_id, from_login, from_name, to_id, to_login, to_name, viewers, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'demo', ?)`);
    await env.DB.batch(rows.map(([f, t, v, daysAgo]) =>
      stmt.bind(demoId(f.toLowerCase()), f.toLowerCase(), f, demoId(t.toLowerCase()), t.toLowerCase(), t, v, now - daysAgo * 86_400_000)));
  }
  await env.KV.put('demo:seeded', '1');
}
