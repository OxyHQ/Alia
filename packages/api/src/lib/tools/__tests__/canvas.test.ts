/**
 * The canvas draws decks and dashboards only in the shape a surface can open,
 * and leaves every other type as it was.
 */
import { asSchema } from 'ai';
import { describe, expect, it } from 'vitest';

import { canvasTool } from '../canvas.js';

async function run(input: { type: string; title: string; data: unknown }) {
  return (await (
    canvasTool as unknown as {
      execute: (args: typeof input, options: unknown) => Promise<Record<string, unknown>>;
    }
  ).execute(input, { toolCallId: 't', messages: [] })) as Record<string, unknown>;
}

async function validate(input: unknown) {
  const schema = asSchema(canvasTool.inputSchema);
  return (await schema.validate?.(input)) ?? { success: true as const, value: input };
}

describe('canvas', () => {
  it('accepts deck and dashboard as types', async () => {
    expect((await validate({ type: 'deck', title: 'Pitch', data: {} })).success).toBe(true);
    expect((await validate({ type: 'dashboard', title: 'Sales', data: {} })).success).toBe(true);
    expect((await validate({ type: 'poster', title: 'X', data: {} })).success).toBe(false);
  });

  it('draws a deck in the shape the tool describes', async () => {
    const out = await run({
      type: 'deck',
      title: 'Pitch',
      data: {
        slides: [
          { title: 'Astro', subtitle: 'A browser' },
          { title: 'Why', bullets: ['Fast'], notes: 'Say it slowly' },
        ],
      },
    });
    expect(out.error).toBeUndefined();
    expect(out.type).toBe('deck');
    expect((out.data as { slides: unknown[] }).slides).toHaveLength(2);
  });

  it('draws a dashboard of stats, charts, tables and text', async () => {
    const out = await run({
      type: 'dashboard',
      title: 'Sales',
      data: {
        widgets: [
          { kind: 'stat', label: 'Revenue', value: '10M', delta: '+12%' },
          {
            kind: 'chart',
            title: 'Monthly',
            chartType: 'bar',
            labels: ['Jan'],
            datasets: [{ label: 'R', values: [1] }],
          },
          { kind: 'table', headers: ['Region'], rows: [['EU']] },
          { kind: 'text', content: 'Steady.' },
        ],
      },
    });
    expect(out.error).toBeUndefined();
    expect((out.data as { widgets: unknown[] }).widgets).toHaveLength(4);
  });

  it('tells the model what is wrong with a malformed deck or dashboard', async () => {
    const deck = await run({ type: 'deck', title: 'Pitch', data: { slides: [] } });
    expect(deck.error).toMatch(/^The deck was not drawn: slides: /);
    expect(deck.id).toBeUndefined();
    const dashboard = await run({
      type: 'dashboard',
      title: 'S',
      data: { widgets: [{ kind: 'gauge' }] },
    });
    expect(dashboard.error).toMatch(/^The dashboard was not drawn: widgets\.0\.kind/);
  });

  it('leaves the other types untouched', async () => {
    const out = await run({ type: 'markdown', title: 'Report', data: { content: '# Q3' } });
    expect(out).toMatchObject({ type: 'markdown', title: 'Report', data: { content: '# Q3' } });
  });
});
