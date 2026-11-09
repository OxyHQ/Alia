import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { BubblesProvider, useBubbles } from '../../../src/lib/bubbles';

/**
 * An agent's thread is drawn as chat bubbles: the person's in the agent's colour, every reply in a
 * neutral one. Alia's own chat keeps its plain replies, and a consulted agent's reply is a bubble
 * wherever it comes. The row is a source gate for the same reason `ThreadRow.composition` is.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const row = readFileSync(join(HERE, '../../../src/components/thread/ThreadRow.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the bubbles of an agent thread', () => {
  it("draws the person's turn as a ChatBubble in the agent's colour, only where there is one", () => {
    expect(row).toMatch(
      /bubbles\?\.colors \? \(\s*[\s\S]*?<ChatBubble side="user" colors=\{bubbles\.colors\}/,
    );
    // Without colours the person keeps Bloom's own bubble.
    expect(row).toMatch(/<AiChatUserMessage/);
  });

  it('puts the words of a reply in a bubble, and leaves the work log and the cards whole', () => {
    expect(row).toMatch(
      /\{bubbled \? \(\s*<ChatBubble side="reply" actions=\{menuActions\}>\s*\{replyBody\}/,
    );
    expect(row).toMatch(/const bubbled = useBubbles\(\) !== null \|\| agent !== undefined;/);
  });

  it("turns Bloom's feedback row off when the icons are beside the bubble", () => {
    expect(row).toMatch(/feedback=\{hasFeedback && !bubbled\}/);
  });

  it('reads a bubble at the compact markdown size, as compact as the person’s own', () => {
    expect(row).toMatch(/size=\{bubbled \? 'md' : 'lg'\}/);
  });
});

describe('useBubbles', () => {
  function read(value: Parameters<typeof BubblesProvider>[0]['value'] | 'none') {
    let seen: unknown = 'unset';
    function Probe() {
      seen = useBubbles();
      return null;
    }
    act(() => {
      create(
        value === 'none' ? (
          <Probe />
        ) : (
          <BubblesProvider value={value}>
            <Probe />
          </BubblesProvider>
        ),
      );
    });
    return seen;
  }

  it('is null outside a thread that asked for bubbles', () => {
    expect(read('none')).toBeNull();
  });

  it('carries the colours the thread gave', () => {
    const colors = { background: '#009957', foreground: '#ffffff' };
    expect(read({ colors })).toEqual({ colors });
  });
});
