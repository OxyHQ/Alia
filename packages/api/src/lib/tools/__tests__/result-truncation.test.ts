import { describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { wrapToolsWithTruncation } from '../result-truncation.js';

/**
 * What survives the truncation wrapper, and what does not.
 *
 * Every tool's result passes through this on its way to the model AND on its
 * way into `tool_invocations`, so whatever it rewrites is what a reader sees in
 * a reopened thread. A card whose numbers came back with
 * `[truncated — N chars omitted]` glued into them would render as garbage, and
 * nothing upstream would report a failure.
 *
 * The wrapper only rewrites TOP-LEVEL string fields named content/text/output/
 * result — it does not descend into nested objects. That is why a card can live
 * under `card` untouched, and this file is the thing that keeps that property
 * from being changed by accident.
 */

const LIMIT = 40;

const toolReturning = (value: unknown) =>
  wrapToolsWithTruncation(
    { probe: tool({ description: 'p', inputSchema: z.object({}), execute: async () => value }) },
    LIMIT,
  );

const run = async (value: unknown) => {
  const wrapped = toolReturning(value);
  return (wrapped.probe.execute as (i: unknown, o: unknown) => Promise<any>)({}, {});
};

const long = 'x'.repeat(500);

describe('wrapToolsWithTruncation', () => {
  it('truncates a top-level content field, which is what it is for', async () => {
    const out = await run({ content: long });
    expect(out.content).not.toBe(long);
    expect(out.content).toContain('truncated');
  });

  it('leaves a card payload intact, numbers and all', async () => {
    const card = {
      type: 'weather',
      version: 1,
      data: {
        place: 'Barcelona',
        hourly: Array.from({ length: 168 }, (_, i) => ({ time: `h${i}`, temperature: 20 + (i % 10) })),
      },
    };
    const out = await run({ card, summary: 'Barcelona: 28°C.' });

    expect(out.card).toEqual(card);
    expect(out.card.data.hourly).toHaveLength(168);
    expect(JSON.stringify(out.card)).not.toContain('truncated');
  });

  it('does not reach a content field nested inside a card', async () => {
    const out = await run({ card: { type: 'news', version: 1, data: { content: long } } });
    expect(out.card.data.content).toBe(long);
  });

  it('still truncates a bare string result', async () => {
    const out = await run(long);
    expect(out).toContain('truncated');
  });
});
