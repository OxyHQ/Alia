import { describe, expect, it, vi } from 'vitest';

/**
 * What a conversation looks like as a document.
 *
 * The builder is pure, so what is pinned here is the TEXT: which turn gets
 * which heading, that an answer's Markdown — a fenced code block above all —
 * comes out byte-for-byte, that an image attached to a question becomes an
 * image link, that the sources an answer stood on are listed under it, and
 * that the model's thinking is not in the document at all.
 */

// `thought-utils` reaches the SDK barrel for `getToolLabel`, which drags the
// whole React Native component library in. `extractSources` — the part the
// exporter uses — never touches it.
vi.mock('@alia.onl/sdk', () => ({ getToolLabel: (n: string) => n }));

import { buildConversationMarkdown, exportFilename, localDate } from '@/lib/conversation-export';
import type { Message } from '@/lib/hooks/use-conversations';

/** Noon on 10 September 2026, local time, so the date never straddles midnight in UTC. */
const EXPORTED_AT = new Date(2026, 8, 10, 12, 0, 0);

const user = (content: Message['content'], id = 'u'): Message => ({ id, role: 'user', content });
const alia = (content: string, extra: Partial<Message> = {}, id = 'a'): Message => ({
  id,
  role: 'assistant',
  content,
  ...extra,
});

describe('buildConversationMarkdown', () => {
  it('opens with the title and the date, then one heading per turn', () => {
    const markdown = buildConversationMarkdown({
      title: 'Meeting with Sarah',
      exportedAt: EXPORTED_AT,
      messages: [user('Prepare my meeting with Sarah'), alia('Here is a plan.')],
    });

    expect(markdown).toBe(
      [
        '# Meeting with Sarah',
        '_Exported 2026-09-10_',
        '## You',
        'Prepare my meeting with Sarah',
        '## Alia',
        'Here is a plan.',
      ].join('\n\n') + '\n',
    );
  });

  it('keeps multi-line answers and fenced code blocks exactly as written', () => {
    const answer = [
      'Two steps:',
      '',
      '1. Install it',
      '2. Run it',
      '',
      '```ts',
      'const x = 1;',
      '',
      'console.log(x);',
      '```',
      '',
      'Done.',
    ].join('\n');

    const markdown = buildConversationMarkdown({
      title: 'Code',
      exportedAt: EXPORTED_AT,
      messages: [user('how?'), alia(answer)],
    });

    // Verbatim, blank lines inside the fence included: a document that
    // reflowed the answer would break the one thing worth exporting.
    expect(markdown).toContain(`## Alia\n\n${answer}\n`);
  });

  it('writes a multi-part question as its text followed by image links', () => {
    const markdown = buildConversationMarkdown({
      title: 'A picture',
      exportedAt: EXPORTED_AT,
      messages: [
        user([
          { type: 'text', text: 'What is in this picture?' },
          { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ]),
      ],
    });

    expect(markdown).toContain(
      [
        '## You',
        'What is in this picture?',
        '![Image 1](https://example.test/a.png)',
        '![Image 2](data:image/png;base64,AAAA)',
      ].join('\n\n'),
    );
  });

  it('lists the sources an answer used, read from its stored tool invocations', () => {
    const markdown = buildConversationMarkdown({
      title: 'Research',
      exportedAt: EXPORTED_AT,
      messages: [
        user('what happened?'),
        alia('This happened.', {
          toolInvocations: [
            {
              toolCallId: 'c1',
              toolName: 'webSearch',
              state: 'result',
              args: { query: 'what happened' },
              result: {
                results: [
                  { title: 'First report', url: 'https://news.example/one', snippet: 's' },
                  { title: 'Second report', url: 'https://news.example/two', snippet: 's' },
                ],
              },
            },
          ],
        }),
      ],
    });

    expect(markdown).toContain(
      [
        '## Alia',
        'This happened.',
        '### Sources\n- [First report](https://news.example/one)\n- [Second report](https://news.example/two)',
      ].join('\n\n'),
    );
  });

  it('leaves the thinking out, and system turns with it', () => {
    const markdown = buildConversationMarkdown({
      title: 'Quiet',
      exportedAt: EXPORTED_AT,
      messages: [
        { id: 's', role: 'system', content: 'You are Alia.' },
        user('hi'),
        alia('hello', { thinking: 'The user greets me; I should greet back.' }),
      ],
    });

    expect(markdown).not.toContain('greets me');
    expect(markdown).not.toContain('You are Alia.');
    expect(markdown).not.toContain('## System');
  });

  it('names the turns after the agent, and after the person in their language', () => {
    const markdown = buildConversationMarkdown({
      title: 'Con Pepe',
      exportedAt: EXPORTED_AT,
      assistantName: 'Pepe',
      userLabel: 'Tú',
      messages: [
        user('hola'),
        alia('hola', {}, 'a1'),
        alia('yo también', { agentInfo: { id: 'x', name: 'Ana', handle: 'ana' } }, 'a2'),
      ],
    });

    expect(markdown).toContain('## Tú\n\nhola');
    expect(markdown).toContain('## Pepe\n\nhola');
    // A delegated agent's turn is under ITS name, not the thread's.
    expect(markdown).toContain('## Ana\n\nyo también');
  });

  it('skips an assistant placeholder that never got its answer', () => {
    const markdown = buildConversationMarkdown({
      title: 'Empty',
      exportedAt: EXPORTED_AT,
      messages: [user('hi'), alia('')],
    });

    expect(markdown).not.toContain('## Alia');
  });
});

describe('exportFilename', () => {
  it('slugs the title and stamps the date', () => {
    expect(exportFilename('Reunión con Sarah: plan', EXPORTED_AT)).toBe('reunion-con-sarah-plan-2026-09-10.md');
  });

  it('never yields a nameless file', () => {
    expect(exportFilename('¿?', EXPORTED_AT)).toBe('conversation-2026-09-10.md');
  });
});

describe('localDate', () => {
  it('reads the calendar date in local time, zero-padded', () => {
    expect(localDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
