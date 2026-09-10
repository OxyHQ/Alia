import { describe, expect, it } from 'vitest';

import { citedIds, normalizeCitationMarkers } from '../citations.js';
import { describeOutputContract, isMetaSubQuestion, parseOutputContract } from '../output-contract.js';
import { SourceTracker, formatSourceLink } from '../source-tracker.js';

/**
 * The pure pieces under research mode: what the request asks for, what a
 * citation marker looks like, and what a reference line is.
 *
 * Each is a function of a string, fed by either the person or the model, and
 * each fails by producing a plausible wrong answer — a report where two
 * sentences were asked for, a `【1†L1-L3】` the reader sees raw, a URL under a
 * title that nothing links. So the cases below are the ones from #540 and
 * #541 verbatim, plus the near-misses that must NOT match.
 */

describe('parseOutputContract', () => {
  it('reads two sentences and one source out of the Spanish request from #541', () => {
    const c = parseOutputContract('resume en dos frases qué es React con una fuente');
    expect(c).toMatchObject({ shape: 'sentences', count: 2, sourceCount: 1, wantsSources: true });
    expect(c.language).toBeUndefined();
    expect(c.subject).toBe('React');
  });

  it('reads English counts, words, paragraphs and bullets', () => {
    expect(parseOutputContract('Summarize what React is in two sentences with a source')).toMatchObject({
      shape: 'sentences', count: 2, sourceCount: 1, subject: 'what React is',
    });
    expect(parseOutputContract('explain GraphQL in one paragraph')).toMatchObject({ shape: 'paragraphs', count: 1, subject: 'GraphQL' });
    expect(parseOutputContract('describe Rust ownership in under 100 words')).toMatchObject({ shape: 'words', count: 100 });
    expect(parseOutputContract('give me a bullet list of the pros of Postgres')).toMatchObject({ shape: 'bullets' });
    expect(parseOutputContract('3 bullet points on why the sky is blue, with sources')).toMatchObject({ shape: 'bullets', count: 3, wantsSources: true });
    expect(parseOutputContract('briefly, what is a monad')).toMatchObject({ shape: 'brief' });
  });

  it('reads an explicitly named language', () => {
    expect(parseOutputContract('explain React in English in two sentences').language).toBe('English');
    expect(parseOutputContract('resume qué es React en inglés').language).toBe('English');
    expect(parseOutputContract('what is React').language).toBeUndefined();
  });

  it('is the report default when nothing is asked, with the request as the subject', () => {
    const c = parseOutputContract('compare the two approaches');
    expect(c).toEqual({ shape: 'report', wantsSources: false, subject: 'compare the two approaches' });
  });

  it('does not read an article as a count', () => {
    // "a sentence embedding" is a subject, not a one-sentence contract.
    expect(parseOutputContract('what is a sentence embedding').shape).toBe('report');
    expect(parseOutputContract('how does a word processor work').shape).toBe('report');
    expect(parseOutputContract('the brief history of Rome').shape).toBe('report');
  });

  it('keeps indices aligned across accented characters', () => {
    // A precomposed é used to shift every later span by one code unit.
    const c = parseOutputContract('explícame qué es Kubernetes en tres frases con dos fuentes');
    expect(c).toMatchObject({ shape: 'sentences', count: 3, sourceCount: 2 });
    expect(c.subject).toBe('Kubernetes');
  });
});

describe('describeOutputContract', () => {
  it('keeps the long-form report prompt for the default', () => {
    const text = describeOutputContract(parseOutputContract('compare the two approaches'));
    expect(text).toContain('800-1500 words');
    expect(text).toContain('Use clear headings');
  });

  it('states the exact shape, the language and no scaffolding for a short answer', () => {
    const text = describeOutputContract(parseOutputContract('resume en dos frases qué es React con una fuente'));
    expect(text).toContain('EXACTLY 2 sentences');
    expect(text).toContain('same language as the original query');
    expect(text).toContain('Cite exactly 1 source');
    expect(text).toContain('Do NOT add headings');
    expect(text).not.toContain('800-1500');
  });
});

describe('isMetaSubQuestion', () => {
  it('flags angles about writing, summarising and citing', () => {
    for (const q of [
      'How to write a two-sentence summary',
      'Best practices for summarizing technical topics',
      'Citation styles for short summaries',
      'Tips for citing a single source',
      'Cómo resumir un texto en dos frases',
      'Técnicas de resumen y cita de fuentes',
    ]) {
      expect(isMetaSubQuestion(q), q).toBe(true);
    }
  });

  it('keeps angles about the subject, even when the subject is writing', () => {
    for (const q of [
      'What is React and who maintains it?',
      'How does React reconcile the virtual DOM?',
      'What are the main criticisms of React?',
      'How do citation networks reveal research communities?',
      '¿Qué es React y para qué se usa?',
    ]) {
      expect(isMetaSubQuestion(q), q).toBe(false);
    }
  });
});

describe('normalizeCitationMarkers', () => {
  it('rewrites the fullwidth retrieval form into [n]', () => {
    expect(normalizeCitationMarkers('React is a library【1†L1-L3】【5†L1-L4】.')).toBe('React is a library[1][5].');
    expect(normalizeCitationMarkers('see【7】 and [2†source]')).toBe('see[7] and [2]');
  });

  it('splits a comma list into one marker per source and keeps adjacent markers', () => {
    expect(normalizeCitationMarkers('cited [1, 2] and [12][3]')).toBe('cited [1][2] and [12][3]');
  });

  it('drops markers whose number has no source, only when the sources are known', () => {
    expect(normalizeCitationMarkers('true [1], made up [9], and [2].', [1, 2])).toBe('true [1], made up, and [2].');
    // Without the list there is nothing to drop against.
    expect(normalizeCitationMarkers('made up [9]')).toBe('made up [9]');
  });

  it('leaves links, reference definitions and years alone', () => {
    const text = '[1](https://a.test) and [1]: https://a.test and in [2024] it';
    expect(normalizeCitationMarkers(text, [1])).toBe(text);
  });

  it('lists the cited ids in order of first appearance', () => {
    expect(citedIds('a [3] b【1†L1】 c [3][2]')).toEqual([3, 1, 2]);
  });
});

describe('SourceTracker.formatReferences', () => {
  it('emits each reference as a Markdown link, numbered', () => {
    const tracker = new SourceTracker();
    tracker.add('https://es.react.dev/', 'React', 'excerpt', 'q');
    tracker.add('https://en.wikipedia.org/wiki/React_(software)', 'React (software) [Wikipedia]', 'excerpt', 'q');
    tracker.add('https://example.test/no-title', '', 'excerpt', 'q');

    const refs = tracker.formatReferences();
    expect(refs).toContain('## References');
    expect(refs).toContain('[1] [React](https://es.react.dev/)');
    // Brackets in a title and parentheses in a URL would break the link.
    expect(refs).toContain('[2] [React (software) \\[Wikipedia\\]](https://en.wikipedia.org/wiki/React_%28software%29)');
    // An empty title falls back to the host rather than an empty link.
    expect(refs).toContain('[3] [example.test](https://example.test/no-title)');
    // No plain-text URL line remains.
    expect(refs).not.toMatch(/\n\s+https?:/);
  });

  it('is empty with no sources', () => {
    expect(new SourceTracker().formatReferences()).toBe('');
    expect(formatSourceLink({ url: 'https://a.test/x', title: ' spaced   title ' })).toBe('[spaced title](https://a.test/x)');
  });
});
