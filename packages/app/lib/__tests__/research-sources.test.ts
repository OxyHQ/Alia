import { describe, expect, it, vi } from 'vitest';

/**
 * A research answer's sources, read back the way a search answer's are.
 *
 * The research handler saves the sources as a finished `deepResearch` tool
 * invocation on the assistant message (`lib/chat-modes/deep-research-handler.ts`),
 * because `toolInvocations` is the one column the app already reads sources
 * out of after a reload. So the fixture here is that PERSISTED row — not the
 * stream — and the assertion is that `extractSources`, the Steps list and the
 * live-progress merge all see it. Before this, a research answer had no
 * Sources row at all, live or reloaded (#540).
 *
 * `getToolLabel` is stubbed for the reason `thought-utils.test.ts` gives: the
 * SDK's root entry reaches React Native, which vitest cannot parse.
 */
vi.mock('@alia.onl/sdk', () => ({ getToolLabel: (toolName: string) => toolName }));

const { buildSteps, extractSources, mergeSources, researchSourcesToSources } = await import('@/lib/thought-utils');
type ToolInvocation = NonNullable<Parameters<typeof extractSources>[0]>[number];

const persistedResearch: ToolInvocation = {
  toolCallId: 'research-req-1',
  toolName: 'deepResearch',
  state: 'result',
  args: { query: 'resume en dos frases qué es React con una fuente' },
  result: {
    status: 'complete',
    sources: [
      { id: 1, url: 'https://es.react.dev/', title: 'React' },
      { id: 2, url: 'https://en.wikipedia.org/wiki/React_(software)', title: '' },
      { id: 3, url: 'https://es.react.dev/', title: 'React (again)' },
    ],
    subQuestions: ['qué es React'],
    totalSearches: 4,
  },
};

describe('extractSources — persisted deepResearch invocation', () => {
  it('yields one source per distinct URL, with the host standing in for a missing title', () => {
    expect(extractSources([persistedResearch])).toEqual([
      { title: 'React', url: 'https://es.react.dev/', snippet: '', domain: 'es.react.dev' },
      { title: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/React_(software)', snippet: '', domain: 'en.wikipedia.org' },
    ]);
  });

  it('de-duplicates against a search in the same turn', () => {
    const search: ToolInvocation = {
      toolCallId: 'call_1',
      toolName: 'webSearch',
      state: 'result',
      result: { results: [{ url: 'https://es.react.dev/', title: 'React', snippet: 's' }] },
    };
    expect(extractSources([search, persistedResearch]).map((s) => s.url)).toEqual([
      'https://es.react.dev/',
      'https://en.wikipedia.org/wiki/React_(software)',
    ]);
  });

  it('yields nothing for research that has not finished, or that saved no sources', () => {
    expect(extractSources([{ ...persistedResearch, state: 'call', result: undefined }])).toEqual([]);
    expect(extractSources([{ ...persistedResearch, result: { status: 'partial', sources: [] } }])).toEqual([]);
  });
});

describe('buildSteps — research step', () => {
  it('carries the research sources on the step so the Steps tab shows them', () => {
    const steps = buildSteps({ content: 'answer', toolInvocations: [persistedResearch] }, 'completed');
    expect(steps.map((s) => s.type)).toEqual(['tool', 'done']);
    expect(steps[0].toolName).toBe('deepResearch');
    expect(steps[0].sources?.map((s) => s.domain)).toEqual(['es.react.dev', 'en.wikipedia.org']);
  });
});

describe('live progress sources', () => {
  it('reads the final event shape and merges with the persisted record, URL-first', () => {
    const live = researchSourcesToSources([
      { id: 1, url: 'https://es.react.dev/', title: 'React' },
      { id: 4, url: 'https://react.dev/learn', title: 'Quick Start' },
    ]);
    expect(live.map((s) => s.url)).toEqual(['https://es.react.dev/', 'https://react.dev/learn']);
    expect(mergeSources(extractSources([persistedResearch]), live).map((s) => s.url)).toEqual([
      'https://es.react.dev/',
      'https://en.wikipedia.org/wiki/React_(software)',
      'https://react.dev/learn',
    ]);
    expect(researchSourcesToSources(undefined)).toEqual([]);
  });
});
