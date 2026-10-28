/**
 * Image results of awaited host tools (`docs/agent-embedding.md` §2): the contract the answer
 * route enforces, what the model receives in the turn, and the placeholder everything after the
 * turn keeps.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  hostImageResultProblem,
  hostToolModelOutput,
  withoutHostImageData,
} from '../host-image-result.js';
import { parseHostResultBody } from '../host-results.js';
import {
  CHAT_TURN_STEP_BOUNDS,
  HOST_AGENT_TURN_STEP_BOUNDS,
  turnStepBounds,
} from '../model-config.js';
import { HOST_RESULT_MAX_CHARS } from '../../../domain/chat-host-results.js';
import { buildHostTools, hostToolName, type AwaitedHostTurn } from '../../host-tools.js';
import { convertToAISDKMessages } from '../../message-converter.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString(
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]).toString('base64');
const WEBP = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1').toString('base64');

const image = (overrides: Record<string, unknown> = {}) => ({
  type: 'image',
  mediaType: 'image/png',
  data: PNG,
  ...overrides,
});

function refusal(result: unknown): { code: string; param: string } {
  try {
    parseHostResultBody({ toolCallId: 'c', outcome: 'inline', result });
  } catch (error) {
    return error as { code: string; param: string };
  }
  throw new Error('accepted');
}

describe('the image result contract', () => {
  it('accepts a PNG, a JPEG and a WebP, with or without a caption', () => {
    for (const [mediaType, data] of [
      ['image/png', PNG],
      ['image/jpeg', JPEG],
      ['image/webp', WEBP],
    ]) {
      const result = image({ mediaType, data, text: 'https://example.com — Example' });
      expect(parseHostResultBody({ toolCallId: 'c', outcome: 'inline', result }).answer).toEqual({
        outcome: 'inline',
        result,
      });
    }
    expect(hostImageResultProblem(image())).toBeNull();
  });

  it('leaves every result that does not claim to be an image alone', () => {
    expect(hostImageResultProblem('text')).toBeNull();
    expect(hostImageResultProblem({ type: 'snapshot', data: '%%%' })).toBeNull();
    expect(hostImageResultProblem([{ type: 'image' }])).toBeNull();
  });

  it('refuses a malformed image, naming the field', () => {
    expect(refusal(image({ mediaType: 'image/gif' }))).toMatchObject({
      code: 'invalid_host_result',
      param: 'result.mediaType',
    });
    expect(refusal(image({ mediaType: undefined }))).toMatchObject({ param: 'result.mediaType' });
    expect(refusal(image({ data: '' }))).toMatchObject({ param: 'result.data' });
    expect(refusal(image({ data: `data:image/png;base64,${PNG}` }))).toMatchObject({
      param: 'result.data',
    });
    expect(refusal(image({ data: `${PNG.slice(0, 8)}\n${PNG.slice(8)}` }))).toMatchObject({
      param: 'result.data',
    });
    expect(refusal(image({ data: 'abc' }))).toMatchObject({ param: 'result.data' });
    expect(refusal(image({ data: JPEG }))).toMatchObject({ param: 'result.data' });
    expect(refusal(image({ mediaType: 'image/webp', data: PNG }))).toMatchObject({
      param: 'result.data',
    });
    expect(refusal(image({ text: 'x'.repeat(4_001) }))).toMatchObject({ param: 'result.text' });
    expect(refusal(image({ text: 7 }))).toMatchObject({ param: 'result.text' });
    expect(refusal(image({ url: 'https://example.com' }))).toMatchObject({ param: 'result.url' });
  });

  it('bounds an image by the JSON size every result is bounded by', () => {
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const big = Buffer.concat([header, Buffer.alloc(80_000)]).toString('base64');
    expect(big.length).toBeGreaterThan(HOST_RESULT_MAX_CHARS);
    expect(() =>
      parseHostResultBody({ toolCallId: 'c', outcome: 'inline', result: image({ data: big }) }),
    ).toThrow(expect.objectContaining({ code: 'host_result_too_large', param: 'result' }));
  });
});

describe('what the model reads', () => {
  it('sees an image result as the image, after the rest of the answer as text', () => {
    const output = { status: 'inline', detail: 'Visible part', result: image({ text: 'Docs' }) };
    expect(hostToolModelOutput(output)).toEqual({
      type: 'content',
      value: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'inline',
            detail: 'Visible part',
            result: { type: 'image', mediaType: 'image/png', text: 'Docs' },
          }),
        },
        { type: 'image-data', data: PNG, mediaType: 'image/png' },
      ],
    });
  });

  it('reads every other output exactly as before', () => {
    const output = { status: 'applied', result: { title: 'Docs', text: 'Hello' } };
    expect(hostToolModelOutput(output)).toEqual({ type: 'json', value: output });
    expect(hostToolModelOutput('done')).toEqual({ type: 'text', value: 'done' });
  });

  it('is what an awaited host tool hands the model', async () => {
    const results: AwaitedHostTurn['results'] = {
      open: vi.fn(async () => {}),
      wait: vi.fn(async () => ({ outcome: 'inline' as const, result: image() })),
    };
    const tools = buildHostTools(
      {
        app: 'astro',
        version: 1,
        tools: [
          {
            name: 'screenshot',
            description: 'A screenshot of the tab.',
            inputSchema: { type: 'object' },
            awaitsResult: true,
          },
        ],
      },
      { emit: vi.fn() },
      {
        turn: { id: '6f1c2d3e-4b5a-4c6d-8e7f-001122334455', authorityKey: 'a' } as never,
        results,
      },
    );
    const tool = tools[hostToolName('astro', 'screenshot')] as unknown as {
      execute: (input: unknown, options: { toolCallId: string }) => Promise<unknown>;
      toModelOutput: (options: { toolCallId: string; input: unknown; output: unknown }) => unknown;
    };
    const output = await tool.execute({}, { toolCallId: 'call-1' });
    expect(tool.toModelOutput({ toolCallId: 'call-1', input: {}, output })).toMatchObject({
      type: 'content',
      value: [{ type: 'text' }, { type: 'image-data', data: PNG, mediaType: 'image/png' }],
    });
  });
});

describe('after the turn', () => {
  it('keeps everything but the bytes', () => {
    const output = { status: 'inline', result: image({ text: 'Docs' }) };
    expect(withoutHostImageData(output)).toEqual({
      status: 'inline',
      result: { type: 'image', mediaType: 'image/png', text: 'Docs', omitted: true },
    });
    const text = { status: 'applied', result: 'text' };
    expect(withoutHostImageData(text)).toBe(text);
  });

  it('replays a stored screenshot as its placeholder, even when a client resends the bytes', () => {
    const [, tool] = convertToAISDKMessages(
      [
        {
          role: 'assistant',
          content: '',
          toolInvocations: [
            {
              toolCallId: 'call-1',
              toolName: 'host_astro__screenshot',
              state: 'result',
              args: {},
              result: { status: 'inline', result: image() },
            },
          ],
        },
      ] as never,
      new Map(),
    );
    const value = (tool as { content: Array<{ output: { value: string } }> }).content[0].output
      .value;
    expect(JSON.parse(value)).toEqual({
      status: 'inline',
      result: { type: 'image', mediaType: 'image/png', omitted: true },
    });
    expect(value).not.toContain(PNG);
  });
});

describe('the step bound', () => {
  it('gives a turn whose host awaits results sixteen steps, and every other turn five', () => {
    expect(turnStepBounds(false)).toBe(CHAT_TURN_STEP_BOUNDS);
    expect(CHAT_TURN_STEP_BOUNDS).toEqual({ maxSteps: 5, maxToolCalls: 15 });
    expect(turnStepBounds(true)).toBe(HOST_AGENT_TURN_STEP_BOUNDS);
    expect(HOST_AGENT_TURN_STEP_BOUNDS).toEqual({ maxSteps: 16, maxToolCalls: 32 });
  });
});
