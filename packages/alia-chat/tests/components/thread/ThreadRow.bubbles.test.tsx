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
  it("always draws the person's turn as a ChatBubble in a bubbles thread, never Bloom's larger default", () => {
    expect(row).toMatch(/bubbles \? \(\s*[\s\S]*?<ChatBubble\s+side="user"/);
    // No colour of its own: the theme is seeded by the agent's, and ChatBubble reads the theme's.
  });

  it('puts the words of a reply in a bubble, and leaves the work log and the cards whole', () => {
    expect(row).toMatch(
      /\{bubbled \? \(\s*<ChatBubble\s+side="reply"\s+reactions=\{reactions\}\s+onReact=\{onReact\}\s+menu=\{moreActions\}\s+onReply=\{onReply\}\s*>\s*\{replyBody\}/,
    );
    expect(row).toMatch(/const bubbled = useBubbles\(\) \|\| agent !== undefined;/);
  });

  it("splits a reply's actions as the chat it is modelled on does: react is the emoji bar, the rest (votes included) is under more", () => {
    expect(row).toMatch(
      /const moreActions = hasFeedback\s*\?\s*\[readAloudAction, copyAction, regenerateAction, likeAction, dislikeAction\]\.filter\(isPresent\)/,
    );
    expect(row).toMatch(
      /const reactions = actions\.reactionsOf\(\s*message\.id,\s*message\.reactions,\s*storedIn,\s*message\.reactionRevision,?\s*\)/,
    );
  });

  it("never reacts on the person's own turn: a reaction is a vote on a reply, and the bubble has no react button", () => {
    expect(row).not.toMatch(/questionReactions|onQuestionReact/);
    expect(row).toMatch(/<ChatBubble\s+side="user"\s+menu=\{questionActions\}/);
  });

  it('shows nothing of the work in an agent\'s thread: no "Worked" line, task list or search trail', () => {
    // The thread reads as a chat; what the agent did along the way is the agent's own business.
    expect(row).toMatch(/const showsWork = !bubbled;/);
    expect(row).toMatch(/!showsWork \|\| workInvocations\.length === 0 \|\| turnWorking \? null/);
    expect(row).toMatch(
      /!showsWork\s*\|\|\s*workInvocations\.length > 0\s*\|\|\s*!message\.thinking/,
    );
    expect(row).toMatch(/!showsWork \|\| taskInvocations\.length === 0/);
    expect(row).toMatch(/showsWork && \(webLog\.steps\.length > 0/);
    expect(row).toMatch(/showsWork \? message\.researchProgress : undefined/);
  });

  it("turns Bloom's feedback row off when the icons are beside the bubble", () => {
    expect(row).toMatch(/feedback=\{hasFeedback && !bubbled\}/);
  });

  it('reads a bubble at the compact markdown size, as compact as the person’s own', () => {
    expect(row).toMatch(/size=\{bubbled \? 'md' : 'lg'\}/);
  });
});

describe('useBubbles', () => {
  function read(value: boolean | 'none') {
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

  it('is false outside a thread that asked for bubbles', () => {
    expect(read('none')).toBe(false);
  });

  it('carries what the thread gave', () => {
    expect(read(true)).toBe(true);
    expect(read(false)).toBe(false);
  });
});
