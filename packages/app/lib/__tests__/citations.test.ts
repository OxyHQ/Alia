import { describe, expect, it } from 'vitest';

import {
  citationLabel,
  extractCitationSources,
  linkifyCitations,
  normalizeCitationMarkers,
  splitReferences,
} from '@/lib/citations';

/**
 * What a `[n]` in a research answer turns into on screen.
 *
 * `normalizeCitationMarkers` is the app's copy of the API's
 * (`packages/api/src/lib/research/citations.ts`), kept for messages saved
 * before the API normalised its output; the marker cases here are the same
 * ones the API pins, so a drift between the two fails on both sides. The
 * rest is the app's own: which sources a marker can resolve to (only the
 * persisted `deepResearch` record carries NUMBERED sources), and how the
 * references section — new link form and legacy title-over-URL form — splits
 * off the body.
 */

const persistedResearch = (sources: Array<{ id: number; url: string; title: string }>) => [
  {
    toolCallId: 'research-req-1',
    toolName: 'deepResearch',
    state: 'result' as const,
    args: { query: 'qué es React' },
    result: { status: 'complete', sources, subQuestions: ['q'], totalSearches: 4 },
  },
];

describe('normalizeCitationMarkers', () => {
  it('rewrites the fullwidth retrieval form into [n]', () => {
    expect(normalizeCitationMarkers('React is a library【1†L1-L3】【5†L1-L4】.')).toBe('React is a library[1][5].');
  });

  it('splits a comma list and keeps adjacent markers', () => {
    expect(normalizeCitationMarkers('cited [1, 2] and [12][3]')).toBe('cited [1][2] and [12][3]');
  });

  it('drops unknown ids only when the sources are known', () => {
    expect(normalizeCitationMarkers('true [1], made up [9].', [1])).toBe('true [1], made up.');
    expect(normalizeCitationMarkers('made up [9]')).toBe('made up [9]');
  });

  it('leaves links and years alone', () => {
    const text = '[1](https://a.test) and in [2024] it';
    expect(normalizeCitationMarkers(text, [1])).toBe(text);
  });
});

describe('extractCitationSources', () => {
  it('reads numbered sources out of a persisted deepResearch invocation', () => {
    const sources = extractCitationSources(
      persistedResearch([
        { id: 2, url: 'https://en.wikipedia.org/wiki/React_(software)', title: 'React (software)' },
        { id: 1, url: 'https://es.react.dev/', title: 'React' },
      ]),
    );
    expect(sources).toEqual([
      { id: 1, url: 'https://es.react.dev/', title: 'React', domain: 'es.react.dev' },
      { id: 2, url: 'https://en.wikipedia.org/wiki/React_(software)', title: 'React (software)', domain: 'en.wikipedia.org' },
    ]);
  });

  it('takes the live progress sources before the record is persisted', () => {
    const sources = extractCitationSources(undefined, [{ id: 1, url: 'https://a.test/x', title: '' }]);
    expect(sources).toEqual([{ id: 1, url: 'https://a.test/x', title: 'a.test', domain: 'a.test' }]);
  });

  it('ignores search tools, unfinished research and malformed entries', () => {
    expect(
      extractCitationSources([
        { toolCallId: 'c1', toolName: 'webSearch', state: 'result', result: { results: [{ url: 'https://a.test', title: 'A' }] } },
        { toolCallId: 'c2', toolName: 'deepResearch', state: 'call', args: { query: 'q' } },
        { toolCallId: 'c3', toolName: 'deepResearch', state: 'result', result: { sources: [{ id: 'x', url: 'https://b.test' }, { id: 1 }, null] } },
      ]),
    ).toEqual([]);
  });
});

describe('linkifyCitations', () => {
  const sources = extractCitationSources(persistedResearch([{ id: 1, url: 'https://es.react.dev/', title: 'React' }]));

  it('turns a known marker into a titled link and leaves an unknown one as text', () => {
    expect(linkifyCitations('React is a library [1] used widely [7].', sources)).toBe(
      'React is a library [1](https://es.react.dev/ "Source 1: React") used widely [7].',
    );
    expect(citationLabel(sources[0])).toBe('Source 1: React');
  });

  it('links legacy marker spellings too', () => {
    expect(linkifyCitations('library【1†L1-L3】.', sources)).toBe('library[1](https://es.react.dev/ "Source 1: React").');
  });

  it('still normalises when there are no sources to link', () => {
    expect(linkifyCitations('library【1†L1-L3】 and [1, 2].', [])).toBe('library[1] and [1][2].');
  });
});

describe('splitReferences', () => {
  it('splits the link form the API writes now', () => {
    const text = 'React es una biblioteca [1].\n\n---\n\n## References\n\n[1] [React](https://es.react.dev/)\n\n[2] [React \\[Wikipedia\\]](https://en.wikipedia.org/wiki/React_%28software%29)';
    const { body, references } = splitReferences(text);
    expect(body).toBe('React es una biblioteca [1].');
    expect(references).toEqual([
      { id: 1, title: 'React', url: 'https://es.react.dev/', domain: 'es.react.dev' },
      { id: 2, title: 'React [Wikipedia]', url: 'https://en.wikipedia.org/wiki/React_%28software%29', domain: 'en.wikipedia.org' },
    ]);
  });

  it('splits the legacy title-over-URL form', () => {
    const text = 'Body [1].\n\n---\n\n## References\n\n[1] React\n    https://es.react.dev/\n\n[2] Docs\n    https://react.dev/learn';
    const { body, references } = splitReferences(text);
    expect(body).toBe('Body [1].');
    expect(references).toEqual([
      { id: 1, title: 'React', url: 'https://es.react.dev/', domain: 'es.react.dev' },
      { id: 2, title: 'Docs', url: 'https://react.dev/learn', domain: 'react.dev' },
    ]);
  });

  it('fills a missing URL from the known sources and renders nothing special otherwise', () => {
    const sources = extractCitationSources(persistedResearch([{ id: 1, url: 'https://es.react.dev/', title: 'React' }]));
    expect(splitReferences('Body\n\n## References\n\n[1] React', sources).references).toEqual([
      { id: 1, title: 'React', url: 'https://es.react.dev/', domain: 'es.react.dev' },
    ]);
    // No section: the whole text is the body.
    expect(splitReferences('Just an answer [1].')).toEqual({ body: 'Just an answer [1].', references: null });
    // A section with nothing parseable is left in the body rather than lost.
    expect(splitReferences('Body\n\n## References\n\nnothing here').references).toBeNull();
  });
});
