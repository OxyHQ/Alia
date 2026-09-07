import { describe, expect, it } from 'vitest';

import { analyzeMessage, deriveProfile } from '../style-analyzer.js';
import { STYLE_RAW_ROLLING_WINDOW } from '../../../domain/writing-style.js';

/**
 * The writing-style analyzer.
 *
 * ## Why this file exists
 *
 * 476 lines of pure heuristic, run on every user message, with no test of any
 * kind. It is the single largest genuinely untested module left in
 * `packages/api` — genuinely in the sense that it was checked by importer,
 * not by whether a `__tests__` directory happened to sit beside it.
 *
 * It is also the shape of code that rots quietly. Nothing it does throws:
 * every defect is a profile that comes out slightly wrong, feeding a system
 * prompt that makes Alia write slightly unlike the person it is imitating.
 * There is no error to notice and no user who can report it precisely.
 *
 * ## What is asserted, and what deliberately is not
 *
 * The thresholds themselves (8 words is "simple", 18 is "moderate") are
 * product choices, and a test that restates them measures nothing but the
 * constant. What is asserted instead is the behaviour a caller depends on:
 *
 *  * accumulation is INCREMENTAL and does not mutate the profile it was given,
 *    because callers hold the old one;
 *  * the rolling windows are bounded, since these rows are stored per user and
 *    an unbounded array is a table that grows forever;
 *  * the inputs the analyzer promises to ignore really are ignored;
 *  * derived fields move in the right DIRECTION as evidence arrives — long
 *    sentences are never classified simpler than short ones — which holds
 *    whatever the thresholds are set to.
 */

/** Feed several messages in order, deriving at the end, as the route does. */
function profileFrom(...messages: string[]) {
  let profile = analyzeMessage(messages[0], null);
  for (const message of messages.slice(1)) profile = analyzeMessage(message, profile);
  return deriveProfile(profile);
}

describe('accumulation', () => {
  it('counts a first message into an empty profile', () => {
    const profile = analyzeMessage('The quick brown fox jumps over the lazy dog.', null);
    expect(profile._raw?.totalMessages).toBe(1);
    expect(profile._raw?.totalSentences).toBe(1);
    expect(profile._raw?.totalWords).toBeGreaterThan(5);
  });

  it('does not mutate the profile it was handed', () => {
    // The caller keeps the row it read, and a later write of that row must not
    // carry counts from a message that was analysed after the read.
    const first = analyzeMessage('One sentence here.', null);
    const before = first._raw?.totalMessages;

    analyzeMessage('A second, quite separate sentence.', first);

    expect(first._raw?.totalMessages).toBe(before);
  });

  it('accumulates across messages', () => {
    const profile = profileFrom('First one.', 'Second one.', 'Third one.');
    expect(profile._raw?.totalMessages).toBe(3);
  });

  it('bounds the rolling windows rather than growing forever', () => {
    // These arrays live in a per-user row. Unbounded, the table grows with
    // every message the person ever sends.
    let profile = analyzeMessage('A sentence with several words in it.', null);
    for (let i = 0; i < STYLE_RAW_ROLLING_WINDOW + 25; i++) {
      profile = analyzeMessage(`Message number ${String(i)} with some words.`, profile);
    }

    expect(profile._raw?.messageLengths.length).toBeLessThanOrEqual(STYLE_RAW_ROLLING_WINDOW);
    expect(profile._raw?.sentenceLengths.length).toBeLessThanOrEqual(STYLE_RAW_ROLLING_WINDOW);
  });
});

describe('the inputs it promises to ignore', () => {
  it('ignores a message that is too short to say anything about a style', () => {
    const profile = analyzeMessage('ok', null);
    expect(profile._raw?.totalMessages).toBe(0);
  });

  it('ignores a bare URL', () => {
    // Someone pasting a link is not writing, and the domain would otherwise
    // become one of their "common words".
    const profile = analyzeMessage('https://example.com/some/long/path?q=1', null);
    expect(profile._raw?.totalMessages).toBe(0);
  });

  it('ignores a message that is only a fenced code block', () => {
    const profile = analyzeMessage('```\nconst x = 1;\nconsole.log(x);\n```', null);
    expect(profile._raw?.totalMessages).toBe(0);
  });

  it('still counts a message that merely CONTAINS a link', () => {
    // Only a message that is nothing but a URL is skipped; prose around one is
    // ordinary writing.
    const profile = analyzeMessage('Have a look at https://example.com when you can.', null);
    expect(profile._raw?.totalMessages).toBe(1);
  });
});

describe('derived fields', () => {
  it('returns the profile untouched when there is no evidence yet', () => {
    const empty = analyzeMessage('hi', null);
    expect(deriveProfile(empty)).toBe(empty);
  });

  it('never calls long sentences simpler than short ones', () => {
    // The thresholds are a product choice and are not restated here; the
    // ORDERING is the property that must hold whatever they are set to.
    const rank = { simple: 0, moderate: 1, complex: 2 } as const;

    const terse = profileFrom('Yes. No. Fine. Sure. Good. Done. Next. Stop.');
    const verbose = profileFrom(
      'I would very much appreciate it if you could possibly take a considered look at the '
        + 'accumulated documentation before we proceed any further with this particular matter.',
    );

    expect(verbose.avgSentenceLength).toBeGreaterThan(terse.avgSentenceLength);
    expect(rank[verbose.sentenceComplexity]).toBeGreaterThanOrEqual(rank[terse.sentenceComplexity]);
  });

  it('never calls a simpler vocabulary more advanced than a denser one', () => {
    // `technical` is in the type but the HEURISTIC never assigns it — only
    // `style-refiner.ts`, which asks a model to correct this profile, can.
    // It is ranked here so the map is total over the type rather than over
    // what this function happens to emit today.
    const rank = { basic: 0, intermediate: 1, advanced: 2, technical: 3 } as const;

    const plain = profileFrom('the cat sat on the mat and then the dog ran to the box and back');
    const dense = profileFrom(
      'epistemological considerations necessarily complicate interdisciplinary methodological '
        + 'frameworks underpinning contemporary organisational transformation initiatives',
    );

    expect(rank[dense.vocabularyLevel]).toBeGreaterThanOrEqual(rank[plain.vocabularyLevel]);
  });

  it('reports no emoji for someone who uses none', () => {
    const profile = profileFrom('A perfectly ordinary sentence.', 'And a second one.');
    expect(profile.usesEmoji).toBe(false);
    expect(profile.emojiFrequency).toBe('never');
  });

  it('notices emoji, and rates a heavy user above a light one', () => {
    const rank = { never: 0, rare: 1, moderate: 2, frequent: 3 } as const;

    const heavy = profileFrom('Great news 🎉🎉 really pleased 😀', 'Another one 🙌 thanks 🎉');
    const light = profileFrom(
      'A plain sentence with nothing in it.',
      'Another plain sentence here.',
      'A third plain one.',
      'Fourth, still plain.',
      'Fifth, and here is one emoji 🙂',
    );

    expect(heavy.usesEmoji).toBe(true);
    expect(light.usesEmoji).toBe(true);
    expect(rank[heavy.emojiFrequency]).toBeGreaterThan(rank[light.emojiFrequency]);
  });

  it('keeps the common words and phrases bounded and free of stop words', () => {
    const profile = profileFrom(
      'the deployment pipeline failed and the deployment pipeline needs a fix',
      'the deployment pipeline is the thing that keeps breaking on us',
    );

    expect(profile.commonWords.length).toBeLessThanOrEqual(20);
    expect(profile.commonPhrases.length).toBeLessThanOrEqual(10);
    expect(profile.commonWords).not.toContain('the');
    expect(profile.commonWords).toContain('deployment');
    expect(profile.commonPhrases).toContain('deployment pipeline');
  });

  it('is stable when derived twice', () => {
    // The route derives on write and the prompt builder reads the row back; a
    // second derive over the same raw counts must not drift.
    const once = profileFrom('A reasonably ordinary message about ordinary things.');
    const twice = deriveProfile({ ...once, _raw: once._raw });
    expect(twice.avgSentenceLength).toBe(once.avgSentenceLength);
    expect(twice.commonWords).toEqual(once.commonWords);
    expect(twice.sentenceComplexity).toBe(once.sentenceComplexity);
  });
});
