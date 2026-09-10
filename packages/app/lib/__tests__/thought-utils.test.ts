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

const { buildSteps, extractSources, turnLifecycle, buildAuditTimeline } = await import('@/lib/thought-utils');
type LifecycleMessage = Parameters<typeof turnLifecycle>[0];
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

describe('turnLifecycle', () => {
  /**
   * The lifecycle is read from what the RUNTIME tracks — the hook's stamp on
   * the message, its `isLoading`, the failed-turn card, the tool states — and
   * never from whether the message happens to have content. Each case below
   * is a message whose content would have said the wrong thing.
   */
  const base = (partial: Partial<LifecycleMessage>): LifecycleMessage => ({ id: 'a1', content: '', ...partial });

  it('keeps a turn running once its first text has arrived', () => {
    // The old test: `!message.content` — so the first chunk ended the turn.
    expect(turnLifecycle(base({ content: 'The first', isStreaming: true }))).toBe('running');
    expect(turnLifecycle(base({ content: [{ type: 'text', text: 'The first' }], isStreaming: true }))).toBe('running');
  });

  it('is queued while the turn is in flight and nothing has arrived', () => {
    expect(turnLifecycle(base({ isStreaming: true }))).toBe('queued');
    expect(turnLifecycle(base({ content: [] , isStreaming: true }))).toBe('queued');
  });

  it('is completed for a contentless turn whose tools all returned', () => {
    // A tool-only reply used to look like it was still streaming forever.
    const done = base({
      isStreaming: false,
      toolInvocations: [invocation({ toolName: 'webSearch', result: { results: [] } } as never)],
    });
    expect(turnLifecycle(done)).toBe('completed');
    expect(turnLifecycle(done, { isLoading: false, isLastAssistant: true })).toBe('completed');
  });

  it('reads a persisted message with no live signal as over', () => {
    // Read back from the server: no stamp, no hook state — and array content.
    expect(turnLifecycle(base({ content: [{ type: 'text', text: 'saved' }] }))).toBe('completed');
    expect(turnLifecycle(base({ content: 'saved' }), {})).toBe('completed');
  });

  it('falls back to the hook state for the last assistant message without a stamp', () => {
    expect(turnLifecycle(base({ content: 'partial' }), { isLoading: true, isLastAssistant: true })).toBe('running');
    // An older message is never the one being written into.
    expect(turnLifecycle(base({ content: 'earlier' }), { isLoading: true, isLastAssistant: false })).toBe('completed');
  });

  it('does not let a stamp that outlived its turn run forever', () => {
    // Saved mid-stream, or left on a row — with the hook explicitly idle, the
    // turn is over whatever the stamp says.
    expect(turnLifecycle(base({ content: 'x', isStreaming: true }), { isLoading: false })).toBe('completed');
  });

  it('is failed when the turn was settled that way, or the failure card is anchored on it', () => {
    expect(turnLifecycle(base({ content: 'partial', turnOutcome: 'failed' }))).toBe('failed');
    expect(
      turnLifecycle(base({ content: 'partial' }), {
        failedTurn: { userMessageId: 'u1', anchorMessageId: 'a1', retryable: true, partial: true },
      }),
    ).toBe('failed');
    // A failure anchored on ANOTHER row (the user message) is not this one's.
    expect(
      turnLifecycle(base({ content: 'fine' }), {
        failedTurn: { userMessageId: 'u1', anchorMessageId: 'u1', retryable: true, partial: false },
      }),
    ).toBe('completed');
  });

  it('is cancelled when the person stopped it', () => {
    expect(turnLifecycle(base({ content: 'partial', turnOutcome: 'cancelled' }))).toBe('cancelled');
    // A failed/cancelled outcome is final even if a stale stamp says streaming.
    expect(turnLifecycle(base({ isStreaming: true, turnOutcome: 'cancelled' }), { isLoading: true, isLastAssistant: true })).toBe('cancelled');
  });

  it('reads a persisted tool that never returned as an interrupted run', () => {
    const interrupted = base({
      content: '',
      toolInvocations: [invocation({ toolName: 'browse', state: 'call' } as never)],
    });
    expect(turnLifecycle(interrupted)).toBe('cancelled');
  });

  it('is waiting while an approval request has no decision, and running once it has one', () => {
    const asked = base({
      isStreaming: true,
      pendingApproval: { requestId: 'r1', toolName: 'sendEmail', description: '', severity: 'high', timeout: 60 },
    });
    expect(turnLifecycle(asked)).toBe('waiting_approval');
    expect(turnLifecycle({ ...asked, pendingApprovalResult: { requestId: 'r1', decision: 'approved' } })).toBe('running');
    // A decision for an earlier request does not answer this one.
    expect(turnLifecycle({ ...asked, pendingApprovalResult: { requestId: 'r0', decision: 'approved' } })).toBe('waiting_approval');
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
      'completed',
    );

    expect(steps.map((s) => s.type)).toEqual(['thinking', 'tool', 'tool', 'done']);
    expect(steps[1].toolName).toBe('webSearch');
  });

  it('shows "writing", never "done", while the answer is still arriving', () => {
    // "Done" under a reply that is still arriving is the one label here that
    // states something false — and the first token used to trigger it.
    const message = { content: 'partial', toolInvocations: [] };
    expect(buildSteps(message, 'running').map((s) => s.type)).toEqual(['writing']);
    expect(buildSteps(message, 'completed').map((s) => s.type)).toEqual(['done']);
  });

  it('shows the tool as the live step while it runs, even after a finished one', () => {
    const steps = buildSteps(
      {
        content: '',
        toolInvocations: [
          invocation({ toolName: 'webSearch', result: { results: [] } } as never),
          invocation({ toolName: 'browse', state: 'call' } as never),
        ],
      },
      'running',
    );
    // No "writing" step is appended over a tool that has not returned: the
    // running tool is the last step, and it keeps its own `call` state.
    expect(steps.map((s) => s.type)).toEqual(['tool', 'tool']);
    expect(steps[1].state).toBe('call');
  });

  it('closes a contentless tool-only turn with done', () => {
    const steps = buildSteps(
      { content: '', toolInvocations: [invocation({ toolName: 'getCurrentDate', result: {} } as never)] },
      'completed',
    );
    expect(steps.map((s) => s.type)).toEqual(['tool', 'done']);
  });

  it('withholds the done step when there is nothing at all', () => {
    expect(buildSteps({ content: '', toolInvocations: [] }, 'completed')).toEqual([]);
    expect(buildSteps({ content: [] }, 'completed')).toEqual([]);
  });

  it('counts multi-part content as content', () => {
    const steps = buildSteps({ content: [{ type: 'text', text: 'hi' }] }, 'completed');
    expect(steps.map((s) => s.type)).toEqual(['done']);
  });

  it('never ends a failed or stopped turn with done', () => {
    const message = { content: 'partial', toolInvocations: [invocation({ toolName: 'webSearch', result: { results: [] } } as never)] };
    expect(buildSteps(message, 'failed').map((s) => s.type)).toEqual(['tool', 'failed']);
    expect(buildSteps(message, 'cancelled').map((s) => s.type)).toEqual(['tool', 'cancelled']);
  });

  it('shows a queued turn as thinking, and a paused one as waiting', () => {
    expect(buildSteps({ content: '' }, 'queued').map((s) => s.type)).toEqual(['thinking']);
    expect(buildSteps({ content: '' }, 'waiting_approval').map((s) => s.type)).toEqual(['waiting']);
  });

  it('attaches the search results to the step that produced them', () => {
    const [step] = buildSteps(
      {
        toolInvocations: [
          searchResult('webSearch', [{ url: 'https://a.test/', title: 'A' }, { title: 'no url' }]),
        ],
      },
      'running',
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
      'running',
    );
    expect(steps.filter((s) => s.type === 'tool').map((s) => s.toolName)).toEqual(['webSearch', 'aToolAddedLaterOnTheServer']);
  });
});

describe('buildAuditTimeline', () => {
  it('pulses an unfinished tool only while its turn is running', () => {
    const unfinished = [invocation({ toolName: 'browse', state: 'call' } as never)];
    const running = buildAuditTimeline([{ id: 'a1', role: 'assistant', content: '', toolInvocations: unfinished, isStreaming: true }]);
    expect(running.map((e) => e.status)).toEqual(['in_progress']);

    // The same call read back after a reload: the turn is over and the tool
    // never returned. It must not pulse forever.
    const persisted = buildAuditTimeline([{ id: 'a1', role: 'assistant', content: '', toolInvocations: unfinished }]);
    expect(persisted.map((e) => e.status)).toEqual(['interrupted']);
  });
});
