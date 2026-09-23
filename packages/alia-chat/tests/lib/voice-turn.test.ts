import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/catalogue', () => ({
  resolveModelId: vi.fn(async (_apiUrl: string, model: string) => model),
}));

import { createAliaVoiceTurnSender } from '../../src/lib/voice-turn';

function stream(...contents: string[]): Response {
  const frames = contents.map((content) =>
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"mode:auto","choices":[{"index":0,"delta":{"content":${JSON.stringify(content)}},"finish_reason":null}]}\n\n`);
  frames.push('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"mode:auto","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
  frames.push('data: [DONE]\n\n');
  return new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

describe('the default voice turn sender', () => {
  it('is an ordinary chat turn marked as voice, streamed back as the whole answer so far', async () => {
    const request = vi.fn(async () => stream('Hola', ', ¿qué tal?'));
    const dispose = vi.fn();
    const createLinkedClient = vi.fn(() => ({ client: { requestAuthenticatedResponse: request }, dispose }));
    const send = createAliaVoiceTurnSender({
      oxyServices: { createLinkedClient },
      apiUrl: 'https://alia.test',
      agentId: 'agent-1',
    });

    const seen: string[] = [];
    await send({
      text: 'Hola Alia',
      history: [{ role: 'user', content: 'antes' }, { role: 'assistant', content: 'vale' }],
      signal: new AbortController().signal,
      onText: (text) => seen.push(text),
    });

    expect(createLinkedClient).toHaveBeenCalledWith({ baseURL: 'https://alia.test' });
    const [config] = request.mock.calls[0] as unknown as [{ url: string; body: string }];
    expect(config.url).toBe('/v1/chat/completions');
    expect(JSON.parse(config.body)).toEqual({
      model: 'mode:auto',
      messages: [
        { role: 'user', content: 'antes' },
        { role: 'assistant', content: 'vale' },
        { role: 'user', content: 'Hola Alia' },
      ],
      stream: true,
      responseMode: 'voice',
      agentId: 'agent-1',
    });
    expect(seen).toEqual(['Hola', 'Hola, ¿qué tal?']);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
