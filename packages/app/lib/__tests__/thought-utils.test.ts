import { describe, expect, it, vi } from 'vitest';

/**
 * `getToolLabel` is stubbed to the identity.
 *
 * Not to avoid testing it — the SDK's own `pure-helpers.test.ts` covers the
 * registry, including its prototype-key guard — but because the real import is
 * `@alia.onl/sdk`, whose root entry reaches React Native, and vitest cannot
 * parse Flow. Stubbing the LABEL keeps every assertion below about the step
 * STRUCTURE, which is what this file is for; the one thing it must not do is
 * stub `thought-utils` itself.
 */
vi.mock('@alia.onl/sdk', () => ({ getToolLabel: (toolName: string) => toolName }));

const { buildSteps, extractSources } = await import('@/lib/thought-utils');
type ToolInvocation = NonNullable<Parameters<typeof extractSources>[0]>[number];

/**
 * What the person watching a turn is shown while it runs.
 *
 * ## Why this file exists
 *
 * `thought-utils.ts` turns tool invocations into the step list and the source
 * cards under an answer, and it had no test. It is 239 lines of pure function
 * fed entirely by SERVER output — tool names, result shapes, URLs — so every
 * one of its branches is reachable by a payload nobody here writes, and it
 * fails by rendering something wrong rather than by throwing.
 *
 * Two properties are worth pinning above the rest, and both are about
 * deduplication and shape rather than about labels:
 *
 *  * `extractSources` de-duplicates by URL ACROSS invocations. A turn that
 *    searches and then reads one of its own results is the normal case, so
 *    without that the same page appears twice under the answer.
 *  * Results with no `url` are dropped rather than rendered. A source card with
 *    an undefined href is a dead link, which reads as a broken product rather
 *    than as missing data.
 *
 * The tool result shapes here are the ones the server actually emits, taken
 * from the branches the function tests for: `webSearch` and `browse`+`search`
 * carry `results[]`; `browse`+`read` and `webScraper` carry a single `url`.
 */

const invocation = (partial: Partial<ToolInvocation> & { toolName: string }): ToolInvocation =>
  ({ toolCallId: `call-${partial.toolName}`, state: 'result', ...partial }) as ToolInvocation;

const searchResult = (toolName: string, results: unknown[]) =>
  invocation({
    toolName,
    state: 'result',
    result: toolName === 'browse' ? { action: 'search', results } : { results },
  } as never);

describe('extractSources', () => {
  it('reads the results of a web search', () => {
    const sources = extractSources([
      searchResult('webSearch', [
        { url: 'https://www.example.com/a', title: 'A', snippet: 'first' },
        { url: 'https://other.test/b', title: 'B', snippet: 'second' },
      ]),
    ]);

    expect(sources).toEqual([
      { title: 'A', url: 'https://www.example.com/a', snippet: 'first', domain: 'example.com' },
      { title: 'B', url: 'https://other.test/b', snippet: 'second', domain: 'other.test' },
    ]);
  });

  it('de-duplicates one URL across DIFFERENT invocations', () => {
    // The ordinary shape of a turn: search, then read one of the hits. Without
    // the shared `seen` set the page appears twice under the answer.
    const sources = extractSources([
      searchResult('webSearch', [{ url: 'https://example.com/a', title: 'From search' }]),
      invocation({
        toolName: 'browse',
        result: { action: 'read', url: 'https://example.com/a', title: 'From read' },
      } as never),
    ]);

    expect(sources).toHaveLength(1);
    // The FIRST sighting wins, so the list stays in the order the work happened.
    expect(sources[0].title).toBe('From search');
  });

  it('drops a result with no url rather than emitting a dead link', () => {
    const sources = extractSources([
      searchResult('webSearch', [{ title: 'No href here' }, { url: 'https://ok.test/', title: 'Fine' }]),
    ]);
    expect(sources.map((s) => s.url)).toEqual(['https://ok.test/']);
  });

  it('falls back to the domain when a result carries no title', () => {
    const [source] = extractSources([
      searchResult('webSearch', [{ url: 'https://www.example.com/deep/path' }]),
    ]);
    expect(source.title).toBe('example.com');
    expect(source.domain).toBe('example.com');
  });

  it('keeps an unparseable url visible instead of discarding it', () => {
    // `getDomain` returns the input when `new URL` throws, so a malformed href
    // still renders — losing it silently would be worse than showing it raw.
    const [source] = extractSources([searchResult('webSearch', [{ url: 'not a url' }])]);
    expect(source.domain).toBe('not a url');
  });

  it('truncates a scraped page to a snippet', () => {
    const [source] = extractSources([
      invocation({
        toolName: 'webScraper',
        result: { url: 'https://long.test/', content: 'x'.repeat(500) },
      } as never),
    ]);
    expect(source.snippet).toHaveLength(200);
  });

  it('ignores invocations that have not produced a result yet', () => {
    expect(
      extractSources([
        invocation({ toolName: 'webSearch', state: 'call' } as never),
        invocation({ toolName: 'webSearch', state: 'partial-call' } as never),
      ]),
    ).toEqual([]);
  });

  it('answers empty rather than throwing on absent input', () => {
    expect(extractSources(undefined)).toEqual([]);
    expect(extractSources([])).toEqual([]);
  });
});

describe('buildSteps', () => {
  it('puts thinking first, then the tools, in order', () => {
    const steps = buildSteps(
      {
        thinking: 'let me look that up',
        content: 'the answer',
        toolInvocations: [
          invocation({ toolName: 'webSearch', result: { results: [] } } as never),
          invocation({ toolName: 'getCurrentDate', result: {} } as never),
        ],
      },
      false,
    );

    expect(steps.map((s) => s.type)).toEqual(['thinking', 'tool', 'tool', 'done']);
    expect(steps[1].toolName).toBe('webSearch');
  });

  it('withholds the done step while the answer is still streaming', () => {
    // "Done" under a reply that is still arriving is the one label here that
    // states something false.
    const message = { content: 'partial', toolInvocations: [] };
    expect(buildSteps(message, true).some((s) => s.type === 'done')).toBe(false);
    expect(buildSteps(message, false).some((s) => s.type === 'done')).toBe(true);
  });

  it('withholds the done step when there is no content at all', () => {
    expect(buildSteps({ content: '', toolInvocations: [] }, false)).toEqual([]);
    expect(buildSteps({ content: [] }, false)).toEqual([]);
  });

  it('counts multi-part content as content', () => {
    const steps = buildSteps({ content: [{ type: 'text', text: 'hi' }] }, false);
    expect(steps.map((s) => s.type)).toEqual(['done']);
  });

  it('attaches the search results to the step that produced them', () => {
    const [step] = buildSteps(
      {
        toolInvocations: [
          searchResult('webSearch', [{ url: 'https://a.test/', title: 'A' }, { title: 'no url' }]),
        ],
      },
      true,
    );

    expect(step.sources?.map((s) => s.url)).toEqual(['https://a.test/']);
  });

  it('carries the tool name on every tool step', () => {
    // The label itself comes from the SDK registry, which has its own test; what
    // this asserts is that the step keeps the name the UI needs to key on.
    const steps = buildSteps(
      {
        toolInvocations: [
          invocation({ toolName: 'webSearch', result: { results: [] } } as never),
          invocation({ toolName: 'aToolAddedLaterOnTheServer' } as never),
        ],
      },
      true,
    );
    expect(steps.map((s) => s.toolName)).toEqual(['webSearch', 'aToolAddedLaterOnTheServer']);
  });
});
