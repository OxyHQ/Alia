import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The thread's turns are Bloom's, and stay Bloom's.
 *
 * Alia drew its own: a `rounded-[22px] bg-muted` bubble capped at 70% of the
 * column for the person's message, and a bare `View` for the reply. Bloom's
 * AI Chat family already composes both — the turn's radius, the column half it
 * hugs, the 6px bleed past the column, the card shadow, and the reveal that
 * fades the turn in while its blocks rise and un-blur 180ms apart. Keeping a
 * private copy of that is how the app and the library drift apart, which is
 * the whole subject of #608.
 *
 * Three properties are asserted rather than remembered, because each one is
 * quietly reversible by an edit that looks like a tidy-up:
 *
 * 1. **The composition comes from the published package**, through its public
 *    subpath. An import of `Bloom/src`, or a local fork of these two
 *    components, would typecheck and render and would also put us back where
 *    we started.
 *
 * 2. **History does not re-animate.** Bloom's reveal is driven by `animate`,
 *    and the only correct value is `isNewMessage` — the flag the list already
 *    computes, which excludes both restored history and a page loaded above.
 *    Hardcoding `animate` to true, or dropping it to take the default, makes
 *    every reload replay the whole conversation as if it had just arrived.
 *
 * 3. **One entrance per arrival.** The row used to run `FadeInUp.springify()`
 *    of its own. With Bloom revealing the turn inside it, that is two
 *    animations for one message — and only Bloom's honours reduced motion.
 *
 * A source gate rather than a render: `ChatInterface` reaches TTS, audio
 * generation, the clipboard, the query cache, five stores and a dozen card
 * renderers, and a test that mocked all of them would be asserting against its
 * own scaffolding rather than against the composition.
 */

const INTERFACE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'chat-interface.tsx',
);

const source = readFileSync(INTERFACE, 'utf8');

/** Source with block and line comments removed — the prose explains the old code. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the thread renders Bloom AI Chat turns', () => {
  it('imports both turn components from the published subpath', () => {
    expect(code).toMatch(
      /import\s*\{[^}]*AiChatAssistantMessage[^}]*AiChatUserMessage[^}]*\}\s*from\s*'@oxy\.so\/bloom\/ai-chat'/,
    );
  });

  it('reaches no Bloom internal', () => {
    expect(code).not.toMatch(/@oxy\.so\/bloom\/(lib|src)\//);
    expect(code).not.toMatch(/Bloom\/src/);
  });

  it('no longer draws a bubble of its own', () => {
    expect(code).not.toContain('rounded-[22px]');
    expect(code).not.toContain('max-w-[70%]');
  });

  it('reveals only a turn that has just arrived', () => {
    const animateProps = code.match(/animate=\{[^}]*\}/g) ?? [];

    expect(animateProps).toHaveLength(2);
    for (const prop of animateProps) {
      expect(prop).toBe('animate={isNewMessage}');
    }
  });

  it('leaves the entrance to Bloom alone, with no second one on the row', () => {
    expect(code).not.toContain('entering=');
    expect(code).not.toContain('FadeInUp');
  });

  it("draws the template's feedback row, and only once the reply is done", () => {
    // Bloom's like / dislike / copy row, wired to Alia's votes and clipboard,
    // with Alia's own actions handed to it rather than drawn in a bar of its
    // own under a reply. A turn that is only its work log (no words) has
    // nothing to copy or rate.
    expect(code).toContain('const replyHasFeedback = !m.isStreaming && hasText;');
    expect(code).toContain('feedback={replyHasFeedback}');
    expect(code).toMatch(/actions: replyActions,/);
    expect(code).toMatch(/feedbackProps=\{\{\s*onLike:/);
    expect(code).not.toContain('ACTION_BAR');
  });
});
