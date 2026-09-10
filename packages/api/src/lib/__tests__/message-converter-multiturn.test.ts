import { describe, expect, it } from 'vitest';
import { convertToAISDKMessages } from '../message-converter.js';

describe('tool history on a later chat turn', () => {
  it('reconstructs AI SDK 6 assistant tool-call parts before their results', () => {
    const converted = convertToAISDKMessages([
      { role: 'user', content: 'Find the weather' },
      {
        role: 'assistant',
        content: '',
        toolInvocations: [{
          toolCallId: 'call-1',
          toolName: 'weather.lookup',
          state: 'result',
          args: { city: 'Madrid' },
          result: { temperature: 22 },
        }],
      },
      { role: 'assistant', content: 'It is 22 degrees.' },
      { role: 'user', content: 'And tomorrow?' },
    ], new Map([['weather_lookup', 'weather.lookup']]));

    expect(converted).toEqual([
      { role: 'user', content: 'Find the weather' },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'weather_lookup',
          input: { city: 'Madrid' },
        }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'weather_lookup',
          output: { type: 'text', value: '{"temperature":22}' },
        }],
      },
      { role: 'assistant', content: 'It is 22 degrees.' },
      { role: 'user', content: 'And tomorrow?' },
    ]);
  });

  it('keeps text and tool calls together in assistant content', () => {
    const [assistant] = convertToAISDKMessages([{
      role: 'assistant',
      content: 'I will check.',
      tool_calls: [{
        id: 'call-2',
        type: 'function',
        function: { name: 'lookup', arguments: '{"q":"Alia"}' },
      }],
    }], new Map());

    expect(assistant).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will check.' },
        { type: 'tool-call', toolCallId: 'call-2', toolName: 'lookup', input: { q: 'Alia' } },
      ],
    });
  });
});
