/**
 * Query-Complexity Router
 *
 * Zero-LLM heuristic classifier that analyzes a user's message and
 * conversation context to determine the optimal Alia model tier.
 * Runs in <1ms using regex/heuristic scoring — no LLM calls.
 *
 * Inspired by TinyClaw's ClawRouter (8-15 dimension classification).
 *
 * Only used when the user hasn't explicitly selected a model (i.e., they're
 * on the default alia-v1). If a user chose a model, their choice is respected.
 */

import { log } from './logger.js';

// ============== TYPES ==============

interface QueryDimensions {
  tokenEstimate: number;
  hasCode: boolean;
  hasReasoning: boolean;
  hasToolIntent: boolean;
  hasMath: boolean;
  hasCreative: boolean;
  conversationDepth: number;
  isMultiPart: boolean;
}

interface ClassificationResult {
  suggestedModel: string;
  complexityScore: number;
  dimensions: QueryDimensions;
}

// ============== DIMENSION SCORERS ==============

// Code markers: backticks, language keywords, error stack traces, file paths
const CODE_PATTERNS = [
  /```[\s\S]*?```/,                           // fenced code blocks
  /`[^`]+`/,                                  // inline code
  /\b(function|class|const|let|var|import|export|return|async|await|def|fn|pub|struct|enum|interface|type)\b/i,
  /\b(error|exception|stacktrace|traceback|TypeError|ReferenceError|SyntaxError)\b/i,
  /\.(ts|js|tsx|jsx|py|rs|go|java|cpp|rb|php|swift|kt)\b/,  // file extensions
  /\b(npm|yarn|pip|cargo|go get|brew|apt)\s+(install|add|remove)/i,
  /\b(git\s+(commit|push|pull|merge|rebase|checkout|branch))\b/i,
];

// Reasoning indicators: analysis, comparison, explanation
const REASONING_PATTERNS = [
  /\b(analyze|analyse|compare|contrast|evaluate|assess|critique|review)\b/i,
  /\b(explain\s+why|how\s+does|what\s+causes|trade-?offs?|pros?\s+and\s+cons?)\b/i,
  /\b(implications?|consequences?|considerations?|nuances?|subtleties?)\b/i,
  /\b(strategy|architect|design\s+pattern|best\s+practice|approach)\b/i,
  /\b(optimize|refactor|improve|debug|diagnose|troubleshoot)\b/i,
  /\b(step[\s-]by[\s-]step|in[\s-]depth|thorough|comprehensive|detailed)\b/i,
];

// Tool intent: web search, URLs, lookups
const TOOL_PATTERNS = [
  /https?:\/\/\S+/,                           // URLs
  /\b(search|look\s+up|find|google|browse|fetch|scrape)\b/i,
  /\b(what\s+is\s+the\s+(latest|current|today))\b/i,
  /\b(weather|news|price|stock|score|time\s+in)\b/i,
];

// Math/logic: equations, calculations
const MATH_PATTERNS = [
  /\b(calculate|compute|solve|equation|formula|integral|derivative|probability)\b/i,
  /\d+\s*[+\-*/^%]\s*\d+/,                   // arithmetic expressions
  /\b(sum|average|mean|median|standard\s+deviation|regression)\b/i,
  /\b(proof|theorem|lemma|axiom|hypothesis)\b/i,
];

// Creative writing: stories, emails, compositions
const CREATIVE_PATTERNS = [
  /\b(write|draft|compose|create|generate)\s+(a\s+)?(story|poem|email|letter|essay|blog|article|script|song|speech)/i,
  /\b(rewrite|rephrase|paraphrase|summarize|summarise)\b/i,
  /\b(creative|fictional|imaginative|narrative)\b/i,
  /\b(tone|voice|style|format)\s+(should|must|needs?\s+to)\b/i,
];

// Multi-part questions: numbered lists, multiple requests
const MULTIPART_PATTERNS = [
  /\b(first|1[.):])\b.*\b(second|2[.):]|then|also|and\s+also|additionally)\b/is,
  /\d+\.\s+\w+.*\n\d+\.\s+\w+/,              // numbered list
  /\b(and\s+also|in\s+addition|furthermore|moreover|plus)\b/i,
];

function countPatternMatches(text: string, patterns: RegExp[]): number {
  return patterns.filter(p => p.test(text)).length;
}

// ============== CLASSIFIER ==============

/**
 * Classify a user query's complexity and return the optimal Alia model.
 *
 * Scoring: each dimension contributes points to a 0-100 complexity score.
 * The score maps to an Alia model tier:
 *   0-20  → alia-lite    (simple greetings, short factual questions)
 *   21-55 → alia-v1      (general conversation, moderate complexity)
 *   56-75 → alia-v1-pro  (code analysis, reasoning, multi-step tasks)
 *   76+   → alia-v1-thinking (deep reasoning, multi-part complex tasks)
 */
export function classifyQuery(
  userMessage: string,
  conversationMessages: Array<{ role: string; content: string }>,
): ClassificationResult {
  const msg = userMessage.trim();

  // Estimate token count (rough: 1 token ≈ 4 chars)
  const tokenEstimate = Math.ceil(msg.length / 4);

  // Score each dimension
  const codeMatches = countPatternMatches(msg, CODE_PATTERNS);
  const hasCode = codeMatches >= 1;

  const reasoningMatches = countPatternMatches(msg, REASONING_PATTERNS);
  const hasReasoning = reasoningMatches >= 1;

  const toolMatches = countPatternMatches(msg, TOOL_PATTERNS);
  const hasToolIntent = toolMatches >= 1;

  const mathMatches = countPatternMatches(msg, MATH_PATTERNS);
  const hasMath = mathMatches >= 1;

  const creativeMatches = countPatternMatches(msg, CREATIVE_PATTERNS);
  const hasCreative = creativeMatches >= 1;

  const conversationDepth = conversationMessages.length;

  const isMultiPart = MULTIPART_PATTERNS.some(p => p.test(msg));

  // Build complexity score (0-100)
  let score = 0;

  // Token count contribution (0-15 points)
  if (tokenEstimate <= 10) score += 0;
  else if (tokenEstimate <= 30) score += 5;
  else if (tokenEstimate <= 100) score += 10;
  else score += 15;

  // Code contribution (0-25 points)
  score += Math.min(codeMatches * 8, 25);

  // Reasoning contribution (0-25 points)
  score += Math.min(reasoningMatches * 10, 25);

  // Tool intent (0-5 points — tools work fine on lite/v1)
  score += Math.min(toolMatches * 3, 5);

  // Math/logic (0-15 points)
  score += Math.min(mathMatches * 8, 15);

  // Creative (0-10 points)
  score += Math.min(creativeMatches * 5, 10);

  // Conversation depth (0-10 points — longer convos may need better context handling)
  if (conversationDepth > 20) score += 10;
  else if (conversationDepth > 10) score += 5;
  else if (conversationDepth > 5) score += 2;

  // Multi-part questions (0-10 points)
  if (isMultiPart) score += 10;

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));

  // Map score to model
  let suggestedModel: string;
  if (score <= 20) {
    suggestedModel = 'alia-lite';
  } else if (score <= 55) {
    suggestedModel = 'alia-v1';
  } else if (score <= 75) {
    suggestedModel = 'alia-v1-pro';
  } else {
    suggestedModel = 'alia-v1-thinking';
  }

  const dimensions: QueryDimensions = {
    tokenEstimate,
    hasCode,
    hasReasoning,
    hasToolIntent,
    hasMath,
    hasCreative,
    conversationDepth,
    isMultiPart,
  };

  log.chat.debug(
    { suggestedModel, complexityScore: score, dimensions },
    'Query classified',
  );

  return { suggestedModel, complexityScore: score, dimensions };
}

/**
 * Get the optimal model for a chat request.
 * Returns the classified model only when the user hasn't explicitly chosen one.
 */
export function getAutoRoutedModel(
  requestedModel: string | undefined,
  userMessage: string,
  conversationMessages: Array<{ role: string; content: string }>,
): string {
  // If user explicitly selected a model, respect their choice
  if (requestedModel) {
    return requestedModel;
  }

  const { suggestedModel, complexityScore } = classifyQuery(userMessage, conversationMessages);

  log.chat.info(
    { suggestedModel, complexityScore },
    'Auto-routed query to model',
  );

  return suggestedModel;
}
