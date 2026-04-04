/**
 * Deep Research Engine
 *
 * Multi-step research flow:
 *   1. Decompose query into 3-5 sub-questions
 *   2. For each sub-question: multiple web searches with varied query formulations
 *   3. Extract key findings from each source with URL tracking
 *   4. Synthesize into structured report with inline citations [1], [2]
 *   5. Identify gaps, do 1-2 follow-up iterations
 *   6. Generate final polished report with references section
 *
 * Streams progress events via a callback for real-time UI updates.
 */

import { generateText } from 'ai';
import { resolveModel, getAIModel } from '../chat-core.js';
import { webSearchTool } from '../tools/web-search.js';
import type { WebSearchResult } from '../tools/web-search.js';
import { SourceTracker } from './source-tracker.js';
import { log } from '../logger.js';

// ── Types ──

export type ResearchPhase =
  | 'decomposing'
  | 'searching'
  | 'reading'
  | 'synthesizing'
  | 'follow_up'
  | 'finalizing'
  | 'complete';

export interface ResearchProgress {
  phase: ResearchPhase;
  message: string;
  subQuestions?: string[];
  sourcesFound?: number;
  currentQuery?: string;
  iteration?: number;
}

export interface ResearchResult {
  report: string;
  sources: Array<{ id: number; url: string; title: string }>;
  subQuestions: string[];
  totalSearches: number;
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
const MAX_CONTENT_LENGTH = 3000; // Per source content extraction

// ── Main Entry Point ──

export async function runDeepResearch(
  query: string,
  messages: Array<{ role: string; content: string }>,
  options: ResearchOptions,
): Promise<ResearchResult> {
  const { userId, onProgress, signal, maxIterations = MAX_FOLLOW_UP_ITERATIONS } = options;
  const sourceTracker = new SourceTracker();
  let totalSearches = 0;

  // ── Phase 1: Decompose into sub-questions ──

  onProgress({ phase: 'decomposing', message: 'Breaking down the research question...' });

  const subQuestions = await decomposeQuery(query, messages, userId);
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
            log.general.warn({ err, query: q }, 'Research: search failed');
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

  let report = await synthesize(query, subQuestions, allFindings, sourceTracker, userId);

  // ── Phase 4: Follow-up iterations (identify gaps + targeted search) ──

  for (let iter = 0; iter < maxIterations; iter++) {
    if (signal?.aborted) throw new Error('Research aborted');

    onProgress({
      phase: 'follow_up',
      message: `Follow-up research (round ${iter + 1})...`,
      iteration: iter + 1,
      sourcesFound: sourceTracker.count(),
    });

    const gaps = await identifyGaps(query, report, userId);
    if (!gaps || gaps.length === 0) break;

    // Search for each gap
    for (const gap of gaps.slice(0, 3)) {
      totalSearches++;
      try {
        const searchResult = await webSearchTool.execute({ query: gap }, { messages: [], toolCallId: `followup-${totalSearches}`, abortSignal: signal });
        if ('results' in searchResult && searchResult.results) {
          for (const result of searchResult.results.slice(0, 3)) {
            sourceTracker.add(result.url, result.title, result.snippet, gap);
          }
        }
      } catch (err) {
        log.general.warn({ err, query: gap }, 'Research: follow-up search failed');
      }
    }

    // Re-synthesize with new sources
    const gapFindings = await extractFindings(gaps.join('; '), sourceTracker.getAll(), userId);
    allFindings.push(gapFindings);
    report = await synthesize(query, subQuestions, allFindings, sourceTracker, userId);
  }

  // ── Phase 5: Final polish ──

  onProgress({
    phase: 'finalizing',
    message: 'Polishing final report...',
    sourcesFound: sourceTracker.count(),
  });

  const finalReport = report + sourceTracker.formatReferences();

  onProgress({
    phase: 'complete',
    message: 'Research complete',
    sourcesFound: sourceTracker.count(),
  });

  return {
    report: finalReport,
    sources: sourceTracker.toJSON(),
    subQuestions,
    totalSearches,
  };
}

// ── Helper Functions ──

async function decomposeQuery(
  query: string,
  messages: Array<{ role: string; content: string }>,
  userId: string,
): Promise<string[]> {
  try {
    const resolved = await resolveModel('clarity-fast');
    if (!resolved) throw new Error('No model available');
    const model = getAIModel(resolved.keyConfig);

    const contextSummary = messages
      .filter(m => m.role === 'user')
      .slice(-3)
      .map(m => m.content)
      .join('\n');

    const { text } = await generateText({
      model,
      system: 'You are a research planning assistant. Given a query, decompose it into 3-5 focused sub-questions that would help produce a comprehensive answer. Return ONLY a JSON array of strings, nothing else.',
      prompt: `Query: ${query}\n\n${contextSummary ? `Context from conversation:\n${contextSummary}\n\n` : ''}Decompose this into 3-5 research sub-questions:`,
      maxOutputTokens: 500,
    });

    const parsed = JSON.parse(text.replace(/```json?\n?|\n?```/g, '').trim());
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.slice(0, 5);
    }
  } catch (err) {
    log.general.warn({ err }, 'Research: failed to decompose query');
  }

  // Fallback: use the original query plus two reformulations
  return [query, `${query} latest research`, `${query} analysis comparison`];
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

async function extractFindings(
  question: string,
  sources: Array<{ id: number; url: string; title: string; excerpt: string }>,
  userId: string,
): Promise<string> {
  if (sources.length === 0) return 'No sources found.';

  try {
    const resolved = await resolveModel('clarity-fast');
    if (!resolved) throw new Error('No model available');
    const model = getAIModel(resolved.keyConfig);

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
    return sources.map(s => `[${s.id}] ${s.title}: ${s.excerpt}`).join('\n');
  }
}

async function synthesize(
  originalQuery: string,
  subQuestions: string[],
  findings: string[],
  sourceTracker: SourceTracker,
  userId: string,
): Promise<string> {
  try {
    const resolved = await resolveModel('clarity-v1');
    if (!resolved) throw new Error('No model available');
    const model = getAIModel(resolved.keyConfig);

    const findingsText = findings.map((f, i) =>
      `### Research Angle ${i + 1}: ${subQuestions[i] || 'Follow-up'}\n${f}`
    ).join('\n\n');

    const { text } = await generateText({
      model,
      system: `You are a senior research analyst producing a comprehensive, well-structured report. Requirements:
- Use clear headings and sections
- Include inline citations [1], [2], etc. referencing the source numbers from the findings
- Be thorough but concise — aim for 800-1500 words
- Highlight key takeaways
- Note any limitations or areas needing further research
- Use professional tone
Do NOT include a references section — it will be added automatically.`,
      prompt: `Original Query: ${originalQuery}\n\nResearch Findings:\n${findingsText}\n\nTotal sources found: ${sourceTracker.count()}\n\nSynthesize these findings into a comprehensive research report:`,
      maxOutputTokens: 4000,
    });

    return text;
  } catch (err) {
    log.general.warn({ err }, 'Research: synthesis failed');
    return findings.join('\n\n---\n\n');
  }
}

async function identifyGaps(
  originalQuery: string,
  currentReport: string,
  userId: string,
): Promise<string[]> {
  try {
    const resolved = await resolveModel('clarity-fast');
    if (!resolved) throw new Error('No model available');
    const model = getAIModel(resolved.keyConfig);

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
