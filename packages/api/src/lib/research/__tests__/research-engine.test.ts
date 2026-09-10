import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What research mode hands back when the request is small, and when the
 * write-up fails.
 *
 * ## Why these three, and not the phase sequence
 *
 * `routes/v1/__tests__/chatFlowFixtures.test.ts` pins the phase sequence and
 * the wire; it cannot say anything about the PROSE, because its fake model
 * returns the same body for every call. The two bugs in #541 were both about
 * the prose:
 *
 *  * a two-sentence request got the 800–1500 word report template, because
 *    the synthesis prompt never knew what the person asked for;
 *  * when synthesis failed, the intermediate findings — joined with
 *    `---` — were handed back under "Research complete".
 *
 * Both are asserted against the WRONG outcome: the prompt the model was handed
 * (not the engine's inputs), and the report's content on failure. The third
 * case is the decomposer keeping "how to write a summary" as a research angle,
 * which is what put "how to summarise" sources under a question about React.
 */

const H = vi.hoisted(() => ({
  /** Every `generateText` call, in order, with the system and user text it received. */
  calls: [] as Array<{ system: string; prompt: string }>,
  /**
   * What `generateText` answers, matched on the SYSTEM prompt so a test can
   * script one step without scripting the others. Unmatched calls answer
   * `fallbackText`; a step whose scripted value is an Error throws it.
   */
  script: [] as Array<{ when: (system: string) => boolean; answer: string | Error | (() => string | Error) }>,
  fallbackText: '["about the subject one","about the subject two"]',
  /** What every web search returns. */
  searchResults: [
    { url: 'https://react.dev/', title: 'React', snippet: 'The library for web and native user interfaces' },
    { url: 'https://en.wikipedia.org/wiki/React_(software)', title: 'React (software)', snippet: 'React is a free and open-source front-end JavaScript library' },
  ] as Array<{ url: string; title: string; snippet: string }>,
}));

vi.mock('../../chat-core.js', () => ({
  resolveModel: vi.fn(async (id: string) => ({ routingProfileId: id, provider: 'p', modelId: 'm' })),
  getAIModel: vi.fn(() => ({ modelId: 'fake' })),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(async (args: { system?: string; prompt?: string }) => {
    const system = args.system ?? '';
    const prompt = args.prompt ?? '';
    H.calls.push({ system, prompt });
    const step = H.script.find((s) => s.when(system));
    const scripted = step ? step.answer : H.fallbackText;
    const answer = typeof scripted === 'function' ? scripted() : scripted;
    if (answer instanceof Error) throw answer;
    return { text: answer };
  }),
}));

vi.mock('../../tools/web-search.js', () => ({
  webSearchTool: {
    execute: vi.fn(async () => ({ results: H.searchResults, count: H.searchResults.length })),
  },
}));

vi.mock('../../logger.js', () => {
  const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: sink, v1: sink, tools: sink, chat: sink } };
});

const { runDeepResearch, PARTIAL_REPORT_NOTE } = await import('../research-engine.js');

const isSynthesis = (system: string) => system.includes('Do NOT include a references section');
const isDecomposition = (system: string) => system.includes('research planning assistant');
const isGaps = (system: string) => system.includes('identify gaps');

const progress = () => vi.fn();

beforeEach(() => {
  H.calls.length = 0;
  H.script.length = 0;
});

describe('runDeepResearch — synthesis failure', () => {
  it('reports a partial result rather than the joined findings as a report', async () => {
    H.script.push(
      { when: isDecomposition, answer: '["what React is","what React is used for"]' },
      // Findings extraction answers with prose that carries the old separator's
      // ingredients, so a report built from them is recognisable.
      { when: (s) => s.includes('Extract key findings'), answer: 'FINDING-ALPHA [1]. FINDING-BETA [2].' },
      { when: isSynthesis, answer: new Error('upstream refused the write-up') },
    );

    const onProgress = progress();
    const result = await runDeepResearch('what is React', [], { userId: 'u1', onProgress });

    expect(result.status).not.toBe('complete');
    expect(result.status).toBe('partial');

    // The message is the explicit note, and never the findings.
    expect(result.report).toContain(PARTIAL_REPORT_NOTE);
    expect(result.report).not.toContain('\n\n---\n\n');
    expect(result.report).not.toContain('FINDING-ALPHA');
    expect(result.report).not.toMatch(/research complete/i);
    // …but the sources found so far are listed, as links.
    expect(result.report).toContain('[React](https://react.dev/)');

    // The findings still travel, bounded, for the activity surfaces.
    expect(result.findingsSummary).toContain('FINDING-ALPHA');
    expect(result.findingsSummary.length).toBeLessThanOrEqual(1200);

    // The final phase says what happened; nothing said "complete".
    const phases = onProgress.mock.calls.map((call) => (call[0] as { phase: string }).phase);
    expect(phases.at(-1)).toBe('failed');
    expect(phases).not.toContain('complete');
    // And no follow-up round ran on a report that does not exist.
    expect(phases).not.toContain('follow_up');
    expect(H.calls.some((c) => isGaps(c.system))).toBe(false);
  });

  it('keeps a complete first write-up when only a follow-up re-synthesis fails', async () => {
    let synthesisCalls = 0;
    H.script.push(
      { when: isDecomposition, answer: '["angle one"]' },
      { when: isGaps, answer: '["a gap"]' },
      {
        when: isSynthesis,
        // The first write-up succeeds; every later round refuses.
        answer: () => {
          synthesisCalls += 1;
          return synthesisCalls > 1 ? new Error('later round refused') : 'FIRST WRITE-UP [1].';
        },
      },
    );

    const result = await runDeepResearch('what is React', [], { userId: 'u1', onProgress: progress(), maxIterations: 2 });

    expect(synthesisCalls).toBe(2);
    expect(result.status).toBe('complete');
    expect(result.report).toContain('FIRST WRITE-UP [1].');
    expect(result.report).not.toContain(PARTIAL_REPORT_NOTE);
  });
});

describe('runDeepResearch — output contract', () => {
  it('hands the synthesis model a two-sentence contract and returns its answer unchanged', async () => {
    const answer = 'React es una biblioteca de JavaScript para construir interfaces de usuario [1]. La mantiene Meta y una comunidad de desarrolladores [1].';
    H.script.push(
      { when: isDecomposition, answer: '["qué es React","para qué se usa React"]' },
      { when: isSynthesis, answer },
    );

    const result = await runDeepResearch(
      'resume en dos frases qué es React con una fuente',
      [],
      { userId: 'u1', onProgress: progress() },
    );

    const synthesis = H.calls.filter((c) => isSynthesis(c.system));
    expect(synthesis.length).toBeGreaterThan(0);
    const system = synthesis[0].system;
    // The contract, on the prompt the model was actually handed.
    expect(system).toContain('EXACTLY 2 sentences');
    expect(system).toContain('Cite exactly 1 source');
    expect(system).toMatch(/Do NOT add headings/);
    expect(system).not.toContain('800-1500 words');
    expect(result.outputContract).toMatchObject({ shape: 'sentences', count: 2, sourceCount: 1, wantsSources: true });

    // The report is the model's text plus the references, and nothing else:
    // no "Research complete", no angle headings, no findings.
    expect(result.status).toBe('complete');
    expect(result.report.startsWith(answer)).toBe(true);
    const afterAnswer = result.report.slice(answer.length);
    expect(afterAnswer).toMatch(/^\n\n---\n\n## References\n\n/);
    expect(result.report).not.toContain('Research Angle');
    expect(result.report).not.toMatch(/research complete/i);

    // A short answer takes no follow-up rounds.
    expect(H.calls.some((c) => isGaps(c.system))).toBe(false);

    // And the references are links, one per source.
    expect(result.report).toContain('[1] [React](https://react.dev/)');
  });

  it('keeps the long-form report contract when nothing was requested', async () => {
    H.script.push({ when: isSynthesis, answer: 'A long report [1].' });
    await runDeepResearch('compare the two approaches', [], { userId: 'u1', onProgress: progress(), maxIterations: 0 });
    const synthesis = H.calls.find((c) => isSynthesis(c.system));
    expect(synthesis?.system).toContain('800-1500 words');
  });

  it('normalises upstream marker forms and drops numbers that have no source', async () => {
    H.script.push({ when: isSynthesis, answer: 'React is a library【1†L1-L3】 maintained by Meta [1, 2] and widely used [9].' });
    const result = await runDeepResearch('what is React', [], { userId: 'u1', onProgress: progress(), maxIterations: 0 });
    expect(result.report).toContain('React is a library[1] maintained by Meta [1][2] and widely used.');
    expect(result.report).not.toContain('【');
    expect(result.report).not.toContain('[9]');
  });
});

describe('runDeepResearch — decomposition', () => {
  it('never keeps sub-questions about summarising or citing', async () => {
    H.script.push({
      when: isDecomposition,
      answer: JSON.stringify([
        'What is React and who maintains it?',
        'How to write a two-sentence summary',
        'Citation styles for summaries',
        'Cómo resumir un texto en dos frases',
        'What is React used for?',
      ]),
    });
    H.script.push({ when: isSynthesis, answer: 'ok [1]' });

    const onProgress = progress();
    const result = await runDeepResearch(
      'resume en dos frases qué es React con una fuente',
      [],
      { userId: 'u1', onProgress },
    );

    expect(result.subQuestions).toEqual(['What is React and who maintains it?', 'What is React used for?']);
    for (const q of result.subQuestions) {
      expect(q).not.toMatch(/summar|citation|resumir/i);
    }

    // The decomposer was asked about the SUBJECT, with the format stripped.
    const decomposition = H.calls.find((c) => isDecomposition(c.system));
    expect(decomposition?.prompt).toContain('Subject: React');
    expect(decomposition?.system).toMatch(/Never produce a sub-question about how to write, summarize/);
  });

  it('falls back to the subject, not the formatting request, when the decomposer fails', async () => {
    H.script.push({ when: isDecomposition, answer: new Error('no planner') });
    H.script.push({ when: isSynthesis, answer: 'ok [1]' });
    const result = await runDeepResearch('summarize in two sentences what React is with a source', [], { userId: 'u1', onProgress: progress() });
    expect(result.subQuestions[0]).toBe('what React is');
    for (const q of result.subQuestions) {
      expect(q).not.toMatch(/summarize|two sentences|with a source/i);
    }
  });
});
