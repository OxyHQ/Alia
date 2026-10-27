import { describe, expect, it } from 'vitest';
import type { MessageRow } from '../../db/chat/messageRepository.js';
import { sharedArtifactsOf, sharedMessagesOf } from '../shared-conversation.js';

const row = (overrides: Partial<MessageRow>): MessageRow => ({
  id: 'r',
  conversationId: 'c',
  oxyUserId: 'u',
  clientMessageId: null,
  role: 'user',
  content: '',
  vote: null,
  toolInvocations: null,
  agentInfoId: null,
  agentInfoName: null,
  agentInfoColor: null,
  agentInfoCharacter: null,
  agentInfoHandle: null,
  seq: null,
  interruptedAfterMs: null,
  createdAt: new Date(0),
  ...overrides,
});

describe('what a share link shows', () => {
  it('keeps text and images, in order, and drops every other part', () => {
    expect(
      sharedMessagesOf([
        row({
          content: [
            { type: 'text', text: 'hola' },
            { type: 'file', file: { file_id: 'f' } },
            { type: 'reasoning', text: 'private scratch' },
            { type: 'tool-result', output: { secret: true } },
            { type: 'image_url', image_url: { url: 'https://cdn/x.jpg' } },
          ],
        }),
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hola' },
          { type: 'image_url', image_url: { url: 'https://cdn/x.jpg' } },
        ],
      },
    ]);
  });

  it('never carries tool invocations, system rows or a message left empty', () => {
    expect(
      sharedMessagesOf([
        row({ role: 'system', content: 'prompt' }),
        row({
          role: 'assistant',
          content: '',
          toolInvocations: [{ toolCallId: 't', toolName: 'x', state: 'result', result: 'secret' }],
        }),
        row({ role: 'user', content: [{ type: 'file', file: { file_id: 'f' } }] }),
        row({ role: 'assistant', content: 'answer', toolInvocations: [{ result: 'secret' }] }),
      ]),
    ).toEqual([{ role: 'assistant', content: 'answer' }]);
  });

  it('says which agent spoke', () => {
    expect(
      sharedMessagesOf([
        row({
          role: 'assistant',
          content: 'hi',
          agentInfoId: 'a',
          agentInfoName: 'Sindi',
          agentInfoHandle: 'sindibot',
          agentInfoColor: 'teal',
        }),
      ])[0].agent,
    ).toEqual({ id: 'a', name: 'Sindi', handle: 'sindibot', color: 'teal', character: null });
  });
});

const report = {
  toolCallId: 'call-report',
  toolName: 'canvas',
  state: 'result',
  args: { type: 'markdown', title: 'Q3 report', data: { content: 'draft the model sent' } },
  result: {
    id: 'canvas-uuid',
    type: 'markdown',
    title: 'Q3 report',
    data: { content: '# Q3\n\nRevenue grew.' },
    message: 'Canvas component created',
  },
};

describe('the canvas artifacts a share link shows', () => {
  it('shows a canvas artifact with its type, title and data, and nothing else of the call', () => {
    const [message] = sharedMessagesOf([
      row({ role: 'assistant', content: 'Here is the report.', toolInvocations: [report] }),
    ]);
    expect(message).toEqual({
      role: 'assistant',
      content: 'Here is the report.',
      artifacts: [
        {
          id: 'call-report',
          type: 'markdown',
          title: 'Q3 report',
          data: { content: '# Q3\n\nRevenue grew.' },
        },
      ],
    });
    const wire = JSON.stringify(message);
    expect(wire).not.toContain('draft the model sent');
    expect(wire).not.toContain('canvas-uuid');
    expect(wire).not.toContain('Canvas component created');
  });

  it('keeps a reply that is only an artifact', () => {
    const deck = {
      toolCallId: 'call-deck',
      toolName: 'canvas',
      state: 'result',
      result: { type: 'deck', title: 'Pitch', data: { slides: [{ title: 'Hello' }] } },
    };
    expect(
      sharedMessagesOf([row({ role: 'assistant', content: '', toolInvocations: [deck] })]),
    ).toEqual([
      {
        role: 'assistant',
        content: '',
        artifacts: [
          { id: 'call-deck', type: 'deck', title: 'Pitch', data: { slides: [{ title: 'Hello' }] } },
        ],
      },
    ]);
  });

  it('leaves out every other tool result: email, files, connected apps, page text, host tools', () => {
    const others = [
      {
        toolCallId: 'a',
        toolName: 'oxy_inbox__searchMessages',
        state: 'result',
        result: { messages: ['private mail'] },
      },
      {
        toolCallId: 'b',
        toolName: 'generateFile',
        state: 'result',
        result: { filename: 'notes.md', content: 'private file' },
      },
      {
        toolCallId: 'c',
        toolName: 'notion_createPage',
        state: 'result',
        result: { type: 'markdown', title: 't', data: { content: 'connected app' } },
      },
      {
        toolCallId: 'd',
        toolName: 'host_astro__readTab',
        state: 'result',
        result: { status: 'applied', result: 'page text' },
      },
      {
        toolCallId: 'e',
        toolName: 'readUrl',
        state: 'result',
        result: { content: 'fetched page' },
      },
    ];
    const shown = sharedMessagesOf([
      row({ role: 'assistant', content: 'done', toolInvocations: [...others, report] }),
    ]);
    expect(shown[0]?.artifacts?.map((a) => a.id)).toEqual(['call-report']);
    const wire = JSON.stringify(shown);
    for (const leak of [
      'private mail',
      'private file',
      'connected app',
      'page text',
      'fetched page',
    ]) {
      expect(wire).not.toContain(leak);
    }
  });

  it('leaves out a canvas call that did not finish, was refused, or names no known type', () => {
    expect(
      sharedArtifactsOf([
        { ...report, state: 'call', result: undefined },
        { ...report, state: 'partial-call' },
        { ...report, result: { error: 'The deck was not drawn: slides: Required.' } },
        { ...report, result: { type: 'script', title: 'x', data: { code: 'alert(1)' } } },
        { ...report, result: { type: 'markdown', title: 'x' } },
        { ...report, result: 'Canvas component created' },
        null,
        'canvas',
      ]),
    ).toEqual([]);
    expect(
      sharedMessagesOf([
        row({ role: 'assistant', content: '', toolInvocations: [{ ...report, state: 'call' }] }),
      ]),
    ).toEqual([]);
  });

  it("never takes an artifact from a person's own message", () => {
    expect(
      sharedMessagesOf([row({ role: 'user', content: 'hi', toolInvocations: [report] })]),
    ).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
