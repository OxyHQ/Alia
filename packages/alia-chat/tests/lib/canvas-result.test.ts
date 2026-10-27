import { describe, expect, it } from 'vitest';
import { canvasResultOf } from '../../src/lib/canvas-result';

/** The artifact a canvas call drew, as a shared conversation draws it inline. */
describe('canvasResultOf', () => {
  const deck = { type: 'deck', title: 'Pitch', data: { slides: [{ title: 'Hi' }] } };

  it("reads a finished canvas call's type, title and data", () => {
    expect(
      canvasResultOf({ toolCallId: 'c', toolName: 'canvas', state: 'result', result: deck }),
    ).toEqual(deck);
    expect(
      canvasResultOf({
        toolCallId: 'c',
        toolName: 'canvas',
        state: 'result',
        result: { type: 'markdown', data: { content: 'x' } },
      }),
    ).toEqual({ type: 'markdown', title: 'markdown', data: { content: 'x' } });
  });

  it('is null for any other tool, a running call, or a refused one', () => {
    expect(
      canvasResultOf({ toolCallId: 'c', toolName: 'generateFile', state: 'result', result: deck }),
    ).toBeNull();
    expect(
      canvasResultOf({ toolCallId: 'c', toolName: 'canvas', state: 'call', args: deck }),
    ).toBeNull();
    expect(
      canvasResultOf({
        toolCallId: 'c',
        toolName: 'canvas',
        state: 'result',
        result: { error: 'The deck was not drawn: slides: Required.' },
      }),
    ).toBeNull();
  });
});
