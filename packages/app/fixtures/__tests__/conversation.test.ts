import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { cardOf } from '@/features/chat/model/tool-cards';
import { fixtureConversation, parseFixtureId } from '../conversation';

const APP = join(__dirname, '..', '..');

/** The SDK's `getImagesFromContent`, restated: the SDK's index pulls in React Native. */
const imagesOf = (content: unknown): string[] =>
  Array.isArray(content)
    ? content.flatMap((p: { type?: string; image_url?: { url?: string } }) =>
        p.type === 'image_url' && typeof p.image_url?.url === 'string' ? [p.image_url.url] : [],
      )
    : [];

/** `work-log.ts`'s web tools, which that module cannot be imported here to read. */
const WEB_TOOLS = new Set(['webSearch', 'browse', 'webScraper', 'deepResearch']);

describe('fixtureConversation', () => {
  it('is the same thread every time for the same id', () => {
    expect(JSON.stringify(fixtureConversation('a-200'))).toBe(
      JSON.stringify(fixtureConversation('a-200')),
    );
    expect(JSON.stringify(fixtureConversation('a-200'))).not.toBe(
      JSON.stringify(fixtureConversation('b-200')),
    );
  });

  it('holds the count the id asks for, user and assistant in turn, oldest first', () => {
    const { messages } = fixtureConversation('a-1000');
    expect(messages).toHaveLength(1000);
    expect(messages.every((m, i) => m.role === (i % 2 === 0 ? 'user' : 'assistant'))).toBe(true);
    const times = messages.map((m) => Date.parse(m.createdAt ?? ''));
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true);
    expect(parseFixtureId('warm-2')).toEqual({ seed: 'warm', count: 2 });
  });

  it('carries what the thread has to draw: code, images, sources and cards', () => {
    const { messages } = fixtureConversation('a-1000');
    const text = (m: (typeof messages)[number]) =>
      typeof m.content === 'string' ? m.content : '';
    const calls = messages.flatMap((m) => m.toolInvocations ?? []);

    expect(messages.filter((m) => text(m).includes('```')).length).toBeGreaterThan(100);
    expect(messages.filter((m) => imagesOf(m.content).length > 0).length).toBeGreaterThan(
      50,
    );
    expect(calls.filter((c) => WEB_TOOLS.has(c.toolName)).length).toBeGreaterThan(100);
    expect(calls.filter((c) => cardOf(c) !== null).map((c) => cardOf(c)?.type)).toEqual(
      expect.arrayContaining(['weather', 'market']),
    );
    // Nothing to fetch: every picture is inline.
    for (const m of messages) {
      for (const url of imagesOf(m.content)) expect(url.startsWith('data:')).toBe(true);
    }
  });
});

describe('the fixtures stay out of the product', () => {
  it('are mounted only behind the build-time flag', () => {
    const entry = readFileSync(join(APP, 'index.web.tsx'), 'utf8');
    expect(entry).toMatch(
      /process\.env\.EXPO_PUBLIC_ALIA_FIXTURES === "1"\s*\?[^:]*require\("\.\/fixtures\/entry"\)/,
    );
  });

  it('are imported by no product module', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.[tj]sx?$/.test(entry.name) && /(@\/|\.\.?\/)fixtures\//.test(readFileSync(path, 'utf8'))) {
          offenders.push(path);
        }
      }
    };
    for (const dir of ['app', 'src']) walk(join(APP, dir));
    expect(offenders).toEqual([]);
  });
});
