/**
 * A call the model wrote as TEXT never reaches the wire (`tool-markup.ts`): the words before it
 * do, the markup is withheld for the fallback, and a later step still speaks.
 */

import { describe, expect, it, vi } from 'vitest';

const logMocks = vi.hoisted(() => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { child };
});

vi.mock('../../logger.js', () => ({
  log: {
    v1: logMocks.child,
    chat: logMocks.child,
    general: logMocks.child,
    agents: logMocks.child,
    credits: logMocks.child,
    providers: logMocks.child,
  },
}));
vi.mock('../../observability/index.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../chat-core.js', () => ({ reportModelUsage: vi.fn() }));

const { runChunks } = await import('./stream-harness.js');

const DSML =
  '<｜DSML｜invoke name="oxy_nilo_memories__recallMemories"> <｜DSML｜parameter name="query" string="true">';
const text = (value: string) => ({ type: 'text-delta', id: 't', text: value });
const finish = { type: 'finish', finishReason: 'stop', totalUsage: {} };

/** The text of every content frame on the wire. */
function shown(written: readonly string[]): string {
  return written
    .filter((frame) => frame.startsWith('data: {'))
    .map((frame) => JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content ?? '')
    .join('');
}

describe('runStream and a tool call written as text', () => {
  it.each([1, 3, 8])(
    'withholds DSML split every %i characters, and shows the words before',
    async (size) => {
      const whole = `Let me look. ${DSML}`;
      const chunks = [];
      for (let i = 0; i < whole.length; i += size) chunks.push(text(whole.slice(i, i + size)));
      const result = await runChunks([...chunks, finish]);
      expect(shown(result.written)).toBe('Let me look. ');
      expect(result.assistantResponse).toBe('Let me look. ');
      expect(result.withheldToolMarkup).toBe(DSML);
      expect(result.written.join('')).not.toContain('DSML');
    },
  );

  it('does not call a turn that is only markup empty: the fallback reads it', async () => {
    const result = await runChunks([text(DSML), finish]);
    expect(shown(result.written)).toBe('');
    expect(result.withheldToolMarkup).toBe(DSML);
  });

  it('speaks again in the step after one that wrote markup', async () => {
    const result = await runChunks([
      text(`One. ${DSML}`),
      { type: 'finish-step', usage: {} },
      text('Two.'),
      finish,
    ]);
    expect(shown(result.written)).toBe('One. Two.');
    expect(result.withheldToolMarkup).toBe(DSML);
  });

  it('shows plain text that only looks like the start of a marker', async () => {
    const result = await runChunks([text('1 < 2 and <fun'), text('ny> yes'), finish]);
    expect(shown(result.written)).toBe('1 < 2 and <funny> yes');
    expect(result.withheldToolMarkup).toBe('');
  });
});
