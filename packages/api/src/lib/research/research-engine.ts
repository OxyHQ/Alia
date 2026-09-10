/**
 * Deep Research Engine
 *
 * Multi-step research flow:
 *   0. Read the OUTPUT CONTRACT off the request — length, shape, language,
 *      how many sources — and the subject it leaves behind
 *   1. Decompose the subject into 3-5 sub-questions (2-3 for a short answer)
 *   2. For each sub-question: multiple web searches with varied query formulations
 *   3. Extract key findings from each source with URL tracking
 *   4. Synthesize into the contracted shape with inline citations [1], [2]
 *   5. Identify gaps, do 1-2 follow-up iterations (long-form reports only)
 *   6. Normalise the citation markers and append the references section
 *
 * Streams progress events via a callback for real-time UI updates.
 *
 * ## What a failure looks like
 *
 * Every model step here is best-effort and falls back — except the write-up.
 * When synthesis fails there is no report, and the result says so: `status`
 * is `'partial'`, `report` is a short note plus the sources found, and the
 * final progress phase is `'failed'`. It used to hand the joined intermediate
 * findings to the reader under "Research complete" (#541), which is a report
 * nobody wrote presented as one somebody did. The findings still travel, in
 * `findingsSummary`, for the activity panel and the persisted tool record —
 * never as the message.
 */

import { generateText } from 'ai';
import { resolveModel, getAIModel } from '../chat-core.js';
import { webSearchTool } from '../tools/web-search.js';
import { SourceTracker, formatSourceLink } from './source-tracker.js';
import { normalizeCitationMarkers } from './citations.js';
import {
  describeOutputContract,
  isMetaSubQuestion,
  parseOutputContract,
  type OutputContract,
} from './output-contract.js';
import { log } from '../logger.js';

// ── Types ──

export type ResearchPhase =
  | 'decomposing'
  | 'searching'
  | 'reading'
  | 'synthesizing'
  | 'follow_up'
  | 'finalizing'
  | 'complete'
  /** Research ran but the final write-up could not be produced; the report is a partial note. */
  | 'failed';

/**
 * `complete`: the report is the model's write-up. `partial`: searching
 * finished but the write-up failed, and `report` is the explicit note.
 * `failed` is reserved for a run that produced nothing at all (thrown, not
 * returned, today) so the two remaining values are what a caller branches on.
 */
export type ResearchStatus = 'complete' | 'partial' | 'failed';

export interface ResearchProgress {
  phase: ResearchPhase;
  message: string;
  subQuestions?: string[];
  sourcesFound?: number;
  currentQuery?: string;
  iteration?: number;
}

export interface ResearchResult {
  status: ResearchStatus;
  report: string;
  sources: Array<{ id: number; url: string; title: string }>;
  subQuestions: string[];
  totalSearches: number;
  /** The contract the answer was written to; `report` shape when none was requested. */
  outputContract: OutputContract;
  /**
   * A bounded digest of the intermediate findings. Never part of the message:
   * it is for progress/activity surfaces and the persisted tool record.
   */
  findingsSummary: string;
}

interface ResearchOptions {
  userId: string;
  onProgress: (progress: ResearchProgress) => void;
  signal?: AbortSignal;
  maxIterations?: number;
}

// ── Constants ──

const MAX_SOURCES_PER_QUERY = 5;
const MAX_FOLLOW_UP_ITERATIONS = 2;
/** How many sources the partial note lists before it says "and N more". */
const PARTIAL_NOTE_SOURCES = 10;
/** Upper bound on `findingsSummary`, in characters. */
const FINDINGS_SUMMARY_CHARS = 1200;
/** What a partial result says in place of the write-up. */
export const PARTIAL_REPORT_NOTE =
  'Research finished searching but the final write-up failed; here is what was found so far:';

// ── Main Entry Point ──

export async function runDeepResearch(
  query: string,
  messages: Array<{ role: string; content: string }>,
  options: ResearchOptions,
): Promise<ResearchResult> {
  const { userId, onProgress, signal, maxIterations = MAX_FOLLOW_UP_ITERATIONS } = options;
  const sourceTracker = new SourceTracker();
  let totalSearches = 0;

  // ── Phase 0: The output contract, before anything is decomposed ──
  //
  // Deterministic, so it adds no model call and no progress phase. The
  // decomposer sees `contract.subject`; the synthesiser sees the whole contract.

  const contract = parseOutputContract(query);
  const isShortAnswer = contract.shape !== 'report';

  // ── Phase 1: Decompose into sub-questions ──

  onProgress({ phase: 'decomposing', message: 'Breaking down the research question...' });

  const subQuestions = await decomposeQuery(query, contract, messages, userId);
  onProgress({
    phase: 'decomposing',
    message: `Identified ${subQuestions.length} research angles`,
    subQuestions,
  });

  if (signal?.aborted) throw new Error('Research aborted');

  // ── Phase 2: Search for each sub-question (parallelized with concurrency limit) ──

  const allFindings: string[] = new Array(subQuestions.length).fill('');
  const SEARCH_CONCURRENCY = 3;

  // Process sub-questions in batches for parallelism
  for (let batch = 0; batch < subQuestions.length; batch += SEARCH_CONCURRENCY) {
    if (signal?.aborted) throw new Error('Research aborted');

    const batchQuestions = subQuestions.slice(batch, batch + SEARCH_CONCURRENCY);

    onProgress({
      phase: 'searching',
      message: `Searching ${batchQuestions.length} questions in parallel...`,
      sourcesFound: sourceTracker.count(),
    });

    const batchResults = await Promise.allSettled(
      batchQuestions.map(async (sq, batchIdx) => {
        const globalIdx = batch + batchIdx;

        // Search with the sub-question and a reformulated variant
        const queries = [sq, reformulateQuery(sq)];
        for (const q of queries) {
          totalSearches++;
          try {
            if (!webSearchTool.execute) throw new Error('webSearchTool has no executor');
            const searchResult = await webSearchTool.execute(
              { query: q },
              { messages: [], toolCallId: `research-${totalSearches}`, abortSignal: signal },
            );
            if ('results' in searchResult && searchResult.results) {
              for (const result of searchResult.results.slice(0, MAX_SOURCES_PER_QUERY)) {
                sourceTracker.add(result.url, result.title, result.snippet, q);
              }
            }
          } catch (err) {
            // The sub-question is model output about the user's research topic.
            log.general.warn({ err }, 'Research: search failed');
          }
        }

        // Extract findings for this sub-question
        const findings = await extractFindings(sq, sourceTracker.getAll(), userId);
        allFindings[globalIdx] = findings;
      }),
    );

    // Log any failures
    for (const result of batchResults) {
      if (result.status === 'rejected') {
        log.general.warn({ err: result.reason }, 'Research: batch search failed');
      }
    }
  }

  if (signal?.aborted) throw new Error('Research aborted');

  // ── Phase 3: Initial synthesis ──

  onProgress({
    phase: 'synthesizing',
    message: 'Synthesizing findings into report...',
    sourcesFound: sourceTracker.count(),
  });

  let report = await synthesize(query, contract, subQuestions, allFindings, sourceTracker, userId);

  // ── Phase 4: Follow-up iterations (identify gaps + targeted search) ──
  //
  // Only for a long-form report, and only when there IS a report to find gaps
  // in. A two-sentence answer has "gaps" by construction, and chasing them
  // would only widen a result the person asked to be narrow.

  const followUpRounds = report !== null && !isShortAnswer ? maxIterations : 0;

  for (let iter = 0; iter < followUpRounds; iter++) {
    if (signal?.aborted) throw new Error('Research aborted');

    onProgress({
      phase: 'follow_up',
      message: `Follow-up research (round ${iter + 1})...`,
      iteration: iter + 1,
      sourcesFound: sourceTracker.count(),
    });

    const gaps = await identifyGaps(query, report ?? '', userId);
    if (!gaps || gaps.length === 0) break;

    // Search for each gap
    for (const gap of gaps.slice(0, 3)) {
      totalSearches++;
      try {
        if (!webSearchTool.execute) throw new Error('webSearchTool has no executor');
        const searchResult = await webSearchTool.execute({ query: gap }, { messages: [], toolCallId: `followup-${totalSearches}`, abortSignal: signal });
        if ('results' in searchResult && searchResult.results) {
          for (const result of searchResult.results.slice(0, 3)) {
            sourceTracker.add(result.url, result.title, result.snippet, gap);
          }
        }
      } catch (err) {
        log.general.warn({ err }, 'Research: follow-up search failed');
      }
    }

    // Re-synthesize with new sources. A failed re-synthesis keeps the report
    // we already have — it was a complete write-up, and a later round failing
    // does not make it less of one — and stops iterating.
    const gapFindings = await extractFindings(gaps.join('; '), sourceTracker.getAll(), userId);
    allFindings.push(gapFindings);
    const revised = await synthesize(query, contract, subQuestions, allFindings, sourceTracker, userId);
    if (revised === null) break;
    report = revised;
  }

  // ── Phase 5: Final polish ──

  onProgress({
    phase: 'finalizing',
    message: 'Polishing final report...',
    sourcesFound: sourceTracker.count(),
  });

  const sources = sourceTracker.toJSON();
  const findingsSummary = summarizeFindings(allFindings);

  if (report === null) {
    onProgress({
      phase: 'failed',
      message: 'Research finished searching, but the final write-up failed',
      sourcesFound: sourceTracker.count(),
    });

    return {
      status: 'partial',
      report: formatPartialReport(sourceTracker),
      sources,
      subQuestions,
      totalSearches,
      outputContract: contract,
      findingsSummary,
    };
  }

  // Markers are normalised against the tracker, so a number the model made up
  // never reaches the reader as a dangling `[9]`.
  const body = normalizeCitationMarkers(report, sources.map((s) => s.id)).trim();
  const finalReport = body + sourceTracker.formatReferences();

  onProgress({
    phase: 'complete',
    message: 'Research complete',
    sourcesFound: sourceTracker.count(),
  });

  return {
    status: 'complete',
    report: finalReport,
    sources,
    subQuestions,
    totalSearches,
    outputContract: contract,
    findingsSummary,
  };
}

// ── Helper Functions ──

/**
 * The message a partial result carries instead of a write-up: the note, then
 * the sources as links, bounded. No findings — those were never written for a
 * reader, and the note is what makes the state honest.
 */
function formatPartialReport(sourceTracker: SourceTracker): string {
  const all = sourceTracker.getAll();
  if (all.length === 0) {
    return `**Research incomplete.** ${PARTIAL_REPORT_NOTE}\n\nNo usable sources were found.`;
  }
  const listed = all.slice(0, PARTIAL_NOTE_SOURCES).map((s) => `- [${s.id}] ${formatSourceLink(s)}`);
  const rest = all.length - listed.length;
  const more = rest > 0 ? `\n- …and ${rest} more source${rest === 1 ? '' : 's'}` : '';
  return `**Research incomplete.** ${PARTIAL_REPORT_NOTE}\n\n${listed.join('\n')}${more}`;
}

/** The findings, flattened and bounded, for surfaces that show process rather than answer. */
function summarizeFindings(findings: string[]): string {
  const joined = findings
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .join('\n')
    .replace(/\n{2,}/g, '\n');
  return joined.length > FINDINGS_SUMMARY_CHARS ? `${joined.slice(0, FINDINGS_SUMMARY_CHARS - 1)}…` : joined;
}

async function decomposeQuery(
  query: string,
  contract: OutputContract,
  messages: Array<{ role: string; content: string }>,
  _userId: string,
): Promise<string[]> {
  const range = contract.shape === 'report' ? '3-5' : '2-3';
  const limit = contract.shape === 'report' ? 5 : 3;

  try {
    const resolved = await resolveModel('route:instant');
    if (!resolved) throw new Error('No model available');
    const model = getAIModel(resolved, 'deep_research');

    const contextSummary = messages
      .filter(m => m.role === 'user')
      .slice(-3)
      .map(m => m.content)
      .join('\n');

    // The subject is what gets decomposed. The original request is shown only
    // when it differs, and labelled as context, so its "two sentences" and
    // "with a source" do not become research angles of their own.
    const requestNote = contract.subject !== query.trim()
      ? `Original request (context only — its length, format and citation instructions are handled elsewhere and must NOT become sub-questions):\n${query}\n\n`
      : '';

    const { text } = await generateText({
      model,
      system: `You are a research planning assistant. Given a research SUBJECT, decompose it into ${range} focused sub-questions that would help answer it comprehensively.
Every sub-question must be ABOUT THE SUBJECT ITSELF. Never produce a sub-question about how to write, summarize, shorten, cite, reference, format or structure an answer — those are not research topics.
Return ONLY a JSON array of strings, nothing else.`,
      prompt: `Subject: ${contract.subject}\n\n${requestNote}${contextSummary ? `Context from conversation:\n${contextSummary}\n\n` : ''}Decompose this into ${range} research sub-questions about the subject:`,
      maxOutputTokens: 500,
    });

    const parsed: unknown = JSON.parse(text.replace(/```json?\n?|\n?```/g, '').trim());
    if (Array.isArray(parsed) && parsed.length > 0) {
      const questions = parsed
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        .map((q) => q.trim());
      const onTopic = questions.filter((q) => !isMetaSubQuestion(q));
      if (onTopic.length < questions.length) {
        log.general.info({ dropped: questions.length - onTopic.length }, 'Research: dropped meta sub-questions about format');
      }
      if (onTopic.length > 0) return onTopic.slice(0, limit);
    }
  } catch (err) {
    log.general.warn({ err }, 'Research: failed to decompose query');
  }

  // Fallback: the subject plus reformulations of it — of the SUBJECT, so the
  // searches are not led by "summarize" or "two sentences".
  const subject = contract.subject;
  return contract.shape === 'report'
    ? [subject, `${subject} latest research`, `${subject} analysis comparison`]
    : [subject, `${subject} overview`];
}

function reformulateQuery(query: string): string {
  // Simple reformulation strategies
  const strategies = [
    (q: string) => `${q} research analysis 2025 2026`,
    (q: string) => `"${q}" expert opinion`,
    (q: string) => q.split(' ').slice(0, 5).join(' ') + ' comprehensive review',
  ];
  const strategy = strategies[Math.floor(Math.random() * strategies.length)];
  return strategy(query);
}

/**
 * Key findings for one sub-question, with `[n]` citations into the tracker.
 *
 * Returns the empty string when extraction fails. It used to return the raw
 * excerpts joined per source, which then reached the reader whenever synthesis
 * failed too (#541); an empty finding is skipped by the synthesiser, which
 * sees the source list separately and loses nothing it can cite.
 */
async function extractFindings(
  question: string,
  sources: Array<{ id: number; url: string; title: string; excerpt: string }>,
  _userId: string,
): Promise<string> {
  if (sources.length === 0) return 'No sources found.';

  try {
    const resolved = await resolveModel('route:instant');
    if (!resolved) throw new Error('No model available');
    const model = getAIModel(resolved, 'deep_research');

    const sourcesText = sources
      .slice(-15) // Most recent sources
      .map(s => `[${s.id}] ${s.title}\n${s.excerpt}`)
      .join('\n\n');

    const { text } = await generateText({
      model,
      system: 'You are a research analyst. Extract key findings from the provided search results relevant to the question. Use inline citations like [1], [2] referencing the source numbers. Be factual and concise.',
      prompt: `Question: ${question}\n\nSearch Results:\n${sourcesText}\n\nExtract the key findings with citations:`,
      maxOutputTokens: 1500,
    });

    return text;
  } catch (err) {
    log.general.warn({ err }, 'Research: failed to extract findings');
    return '';
  }
}

/** How many tracker entries the synthesis prompt lists for citing. */
const SYNTHESIS_SOURCE_LIST = 40;

/**
 * The write-up, in the contracted shape — or `null` when the model call fails.
 *
 * `null` and not a fallback: there is no honest text to put in a report's
 * place, and the caller decides what a partial result says.
 */
async function synthesize(
  originalQuery: string,
  contract: OutputContract,
  subQuestions: string[],
  findings: string[],
  sourceTracker: SourceTracker,
  _userId: string,
): Promise<string | null> {
  try {
    const resolved = await resolveModel('route:auto');
    if (!resolved) throw new Error('No model available');
    const model = getAIModel(resolved, 'deep_research');

    const findingsText = findings
      .map((f, i) => ({ finding: f.trim(), angle: subQuestions[i] || 'Follow-up' }))
      .filter(({ finding }) => finding.length > 0)
      .map(({ finding, angle }, i) => `### Research Angle ${i + 1}: ${angle}\n${finding}`)
      .join('\n\n');

    // The numbered source list is what `[n]` resolves against, so the model
    // sees every id it may cite even where a finding failed to extract.
    const sourceList = sourceTracker
      .getAll()
      .slice(0, SYNTHESIS_SOURCE_LIST)
      .map((s) => `[${s.id}] ${s.title} — ${s.url}`)
      .join('\n');

    const task = contract.shape === 'report'
      ? 'Synthesize these findings into a comprehensive research report:'
      : 'Answer the original query from these findings, in exactly the requested shape:';

    const { text } = await generateText({
      model,
      system: describeOutputContract(contract),
      prompt: `Original Query: ${originalQuery}\n\nResearch Findings:\n${findingsText || '(no findings were extracted)'}\n\nSources (cite by number):\n${sourceList || '(none)'}\n\nTotal sources found: ${sourceTracker.count()}\n\n${task}`,
      maxOutputTokens: 4000,
    });

    return text;
  } catch (err) {
    log.general.warn({ err }, 'Research: synthesis failed');
    return null;
  }
}

async function identifyGaps(
  originalQuery: string,
  currentReport: string,
  _userId: string,
): Promise<string[]> {
  try {
    const resolved = await resolveModel('route:instant');
    if (!resolved) throw new Error('No model available');
    const model = getAIModel(resolved, 'deep_research');

    const { text } = await generateText({
      model,
      system: 'You identify gaps in research reports. Given a query and current report, identify 1-3 specific search queries that would fill important gaps. Return ONLY a JSON array of search query strings. Return an empty array [] if the report is sufficiently comprehensive.',
      prompt: `Original query: ${originalQuery}\n\nCurrent report (excerpt):\n${currentReport.slice(0, 2000)}\n\nWhat gaps remain? Return JSON array of follow-up search queries:`,
      maxOutputTokens: 300,
    });

    const parsed = JSON.parse(text.replace(/```json?\n?|\n?```/g, '').trim());
    if (Array.isArray(parsed)) return parsed.slice(0, 3);
  } catch {
    // No gaps found or parse error — that's fine
  }

  return [];
}
