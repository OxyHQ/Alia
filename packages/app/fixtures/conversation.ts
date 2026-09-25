/**
 * A long conversation, generated, for the perf and visual harnesses.
 *
 * Only reachable in a fixtures build (`EXPO_PUBLIC_ALIA_FIXTURES=1`, see
 * `fixtures/entry.tsx`); the production export drops it with the branch that
 * imports it. It is the shape the conversation hook hands the chat page — the
 * persisted `Message` — so the screen draws it exactly as it draws a thread
 * read back from the server: Markdown with code, a user's attached images,
 * web searches with their sources, deep research with citations, and the
 * cards a weather or market call returns.
 *
 * Deterministic: the same id always yields the same thread, byte for byte, so
 * two runs of a harness measure the same work. Nothing here reaches the
 * network — the images are inline SVG data URIs and every link is inert text
 * the harness never follows.
 */
import type { Message } from '@/features/chat/model/chat';

/** Seeded PRNG (mulberry32): small, fast, and the same on every engine. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const WORDS = (
  'the answer depends on what you measure and when a thread grows long every row ' +
  'it draws costs layout style and script so the screen has to stay honest about ' +
  'which parts are work and which are waiting for data that has not arrived yet ' +
  'memory tools search sources images code cards and a composer that keeps up'
).split(' ');

const TOPICS = [
  'How do I paginate a Postgres table without OFFSET?',
  'Summarise what changed in the last release notes.',
  'What will the weather be like in Madrid this week?',
  'Write a TypeScript debounce that cancels on unmount.',
  'Compare these two photos and tell me which is sharper.',
  'Find recent reporting on battery recycling in Europe.',
  'How is BTC doing today?',
  'Explain the difference between a mutex and a semaphore.',
];

const SITES = [
  ['https://github.com/postgres/postgres', 'postgres/postgres'],
  ['https://www.postgresql.org/docs/current/queries-limit.html', 'LIMIT and OFFSET'],
  ['https://developer.mozilla.org/en-US/docs/Web/API/setTimeout', 'setTimeout()'],
  ['https://en.wikipedia.org/wiki/Semaphore_(programming)', 'Semaphore (programming)'],
  ['https://www.reuters.com/business/environment/', 'Environment — Reuters'],
  ['https://reddit.com/r/programming', 'r/programming'],
  ['https://news.ycombinator.com/', 'Hacker News'],
  ['https://www.theverge.com/tech', 'Tech — The Verge'],
] as const;

const CODE = [
  [
    'ts',
    [
      'export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number) {',
      '  let timer: ReturnType<typeof setTimeout> | null = null;',
      '  const run = (...args: Parameters<T>) => {',
      '    if (timer) clearTimeout(timer);',
      '    timer = setTimeout(() => fn(...args), ms);',
      '  };',
      '  run.cancel = () => timer && clearTimeout(timer);',
      '  return run;',
      '}',
    ],
  ],
  [
    'sql',
    [
      'SELECT id, created_at, body',
      '  FROM messages',
      ' WHERE conversation_id = $1',
      '   AND (created_at, id) < ($2, $3)',
      ' ORDER BY created_at DESC, id DESC',
      ' LIMIT 50;',
    ],
  ],
  [
    'python',
    [
      'from threading import Semaphore',
      '',
      'pool = Semaphore(4)',
      'def fetch(url):',
      '    with pool:',
      '        return session.get(url, timeout=10).json()',
    ],
  ],
] as const;

function sentence(rand: () => number, min = 8, max = 22): string {
  const length = min + Math.floor(rand() * (max - min));
  const words: string[] = [];
  for (let i = 0; i < length; i += 1) words.push(WORDS[Math.floor(rand() * WORDS.length)]);
  const text = words.join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function paragraph(rand: () => number): string {
  const count = 2 + Math.floor(rand() * 4);
  return Array.from({ length: count }, () => sentence(rand)).join(' ');
}

/** A flat-colour picture with a label, as an inline SVG — nothing to fetch. */
export function fixtureImage(index: number): string {
  const hue = (index * 47) % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">` +
    `<rect width="240" height="240" fill="hsl(${hue},55%,62%)"/>` +
    `<circle cx="160" cy="80" r="42" fill="hsl(${(hue + 40) % 360},70%,80%)"/>` +
    `<text x="20" y="220" font-family="sans-serif" font-size="28" fill="#fff">#${index}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function sources(rand: () => number, count: number) {
  const start = Math.floor(rand() * SITES.length);
  return Array.from({ length: count }, (_, i) => {
    const [url, title] = SITES[(start + i) % SITES.length];
    return { url, title, snippet: sentence(rand, 6, 12) };
  });
}

/** The kinds of assistant turn the thread cycles through. */
type TurnKind = 'prose' | 'code' | 'search' | 'research' | 'weather' | 'market';
const KINDS: TurnKind[] = ['prose', 'code', 'search', 'prose', 'research', 'weather', 'code', 'market'];

function assistantTurn(rand: () => number, turn: number, id: string, createdAt: string): Message {
  const kind = KINDS[turn % KINDS.length];
  const base = { id, role: 'assistant' as const, createdAt };
  if (kind === 'code') {
    const [lang, lines] = CODE[turn % CODE.length];
    return {
      ...base,
      content: `${paragraph(rand)}\n\n\`\`\`${lang}\n${lines.join('\n')}\n\`\`\`\n\n${sentence(rand)}\n\n- ${sentence(rand, 4, 8)}\n- ${sentence(rand, 4, 8)}`,
    };
  }
  if (kind === 'search') {
    const found = sources(rand, 4);
    return {
      ...base,
      content: `${paragraph(rand)} [1](${found[0].url}) ${paragraph(rand)} [2](${found[1].url})`,
      toolInvocations: [
        {
          toolCallId: `${id}-search`,
          toolName: 'webSearch',
          state: 'result',
          args: { query: TOPICS[turn % TOPICS.length] },
          result: { results: found, count: found.length },
        },
        {
          toolCallId: `${id}-visit`,
          toolName: 'webScraper',
          state: 'result',
          args: { url: found[0].url },
          result: { url: found[0].url, title: found[0].title, content: paragraph(rand) },
        },
      ],
    };
  }
  if (kind === 'research') {
    const cited = sources(rand, 5);
    return {
      ...base,
      content: `## Findings\n\n${paragraph(rand)}\n\n${paragraph(rand)}\n\n| Source | Claim |\n| --- | --- |\n${cited
        .slice(0, 3)
        .map((s) => `| ${s.title} | ${sentence(rand, 4, 7)} |`)
        .join('\n')}`,
      toolInvocations: [
        {
          toolCallId: `${id}-research`,
          toolName: 'deepResearch',
          state: 'result',
          args: { query: TOPICS[turn % TOPICS.length] },
          result: { totalSearches: 6, sources: cited, report: paragraph(rand) },
        },
      ],
    };
  }
  if (kind === 'weather') {
    return {
      ...base,
      content: sentence(rand),
      toolInvocations: [
        {
          toolCallId: `${id}-weather`,
          toolName: 'weather',
          state: 'result',
          args: { location: 'Madrid' },
          result: {
            card: {
              type: 'weather',
              data: {
                place: 'Madrid, Spain',
                timezone: 'Europe/Madrid',
                current: { temperature: 24, humidity: 38, windSpeed: 11, condition: 'clear' },
                hourly: Array.from({ length: 12 }, (_, h) => ({
                  time: `2026-01-01T${String(8 + h).padStart(2, '0')}:00`,
                  temperature: 18 + Math.round(rand() * 9),
                  precipitationChance: Math.round(rand() * 30),
                })),
                daily: Array.from({ length: 5 }, (_, d) => ({
                  date: `2026-01-0${d + 1}`,
                  condition: d % 2 === 0 ? 'clear' : 'cloudy',
                  high: 22 + d,
                  low: 11 + d,
                })),
              },
            },
          },
        },
      ],
    };
  }
  if (kind === 'market') {
    const start = Date.UTC(2026, 0, 1);
    const series = (points: number, stepMs: number) =>
      Array.from({ length: points }, (_, i): [number, number] => [
        start + i * stepMs,
        60000 + Math.round(Math.sin(i / 3) * 900 + rand() * 300),
      ]);
    return {
      ...base,
      content: sentence(rand),
      toolInvocations: [
        {
          toolCallId: `${id}-market`,
          toolName: 'market',
          state: 'result',
          args: { symbol: 'BTC' },
          result: {
            card: {
              type: 'market',
              data: {
                id: 'bitcoin',
                name: 'Bitcoin',
                symbol: 'BTC',
                currency: 'USD',
                price: 61234.5,
                changePct: 1.8,
                changeAbs: 1082.2,
                marketCap: 1.2e12,
                volume24h: 3.1e10,
                series: { '1D': series(48, 1_800_000), '5D': series(60, 7_200_000) },
              },
            },
          },
        },
      ],
    };
  }
  return { ...base, content: `${paragraph(rand)}\n\n${paragraph(rand)}` };
}

export interface FixtureConversation {
  id: string;
  title: string;
  messages: Message[];
}

/** A thread's id is `<seed>-<count>`: `a-1000` is 1,000 messages seeded by `a`. */
export function parseFixtureId(id: string): { seed: string; count: number } {
  const match = /^(.*)-(\d+)$/.exec(id);
  if (!match) return { seed: id, count: 1000 };
  return { seed: match[1], count: Math.min(Number(match[2]), 20000) };
}

/**
 * `count` messages, user and assistant in turn, oldest first, one exchange a
 * few minutes after the last so the thread crosses day boundaries and draws
 * its date headers. Every fifth user turn attaches an image.
 */
export function fixtureConversation(id: string): FixtureConversation {
  const { seed, count } = parseFixtureId(id);
  const rand = prng(hash(seed));
  const messages: Message[] = [];
  // Ends on the harness's pinned epoch so "today" and "yesterday" are stable.
  const end = Date.UTC(2026, 0, 1, 12, 0, 0);
  const step = 7 * 60_000;
  for (let i = 0; i < count; i += 1) {
    const createdAt = new Date(end - (count - i) * step).toISOString();
    const turn = Math.floor(i / 2);
    const msgId = `${id}-m${i}`;
    if (i % 2 === 0) {
      const text = `${TOPICS[turn % TOPICS.length]} ${sentence(rand, 3, 10)}`;
      messages.push({
        id: msgId,
        role: 'user',
        createdAt,
        content:
          turn % 5 === 4
            ? [
                { type: 'text', text },
                { type: 'image_url', image_url: { url: fixtureImage(turn) } },
              ]
            : text,
      });
    } else {
      messages.push(assistantTurn(rand, turn, msgId, createdAt));
    }
  }
  return { id, title: `Fixture ${seed} (${count})`, messages };
}

/** The reply the simulated stream types out, long enough to wrap and to carry code. */
export function fixtureReply(seed: string): string {
  const rand = prng(hash(`reply:${seed}`));
  const [lang, lines] = CODE[0];
  return `${paragraph(rand)}\n\n${paragraph(rand)}\n\n\`\`\`${lang}\n${lines.join('\n')}\n\`\`\`\n\n${paragraph(rand)}\n\n1. ${sentence(rand)}\n2. ${sentence(rand)}\n3. ${sentence(rand)}`;
}
