/**
 * Threat Detector — Pre-execution analysis of agent tool calls.
 *
 * Scans tool names and arguments against the threat pattern library.
 * Returns a threat result with severity and action recommendation.
 */

import { THREAT_PATTERNS, type ThreatPattern, type ThreatSeverity } from './threat-patterns.js';

export interface ThreatMatch {
  pattern: ThreatPattern;
  match: string;
}

export interface ThreatResult {
  threats: ThreatMatch[];
  maxSeverity: ThreatSeverity | 'none';
  /** Automatically block — do not execute */
  shouldBlock: boolean;
  /** Requires user approval before execution */
  shouldApprove: boolean;
}

const SEVERITY_ORDER: Record<ThreatSeverity | 'none', number> = {
  none: 0,
  info: 1,
  warning: 2,
  critical: 3,
  block: 4,
};

const EMPTY_RESULT: ThreatResult = {
  threats: [],
  maxSeverity: 'none',
  shouldBlock: false,
  shouldApprove: false,
};

/**
 * Analyze a tool call for security threats before execution.
 */
export function analyzeThreat(toolName: string, args: Record<string, unknown>): ThreatResult {
  const textToScan = extractTextFromArgs(toolName, args);
  if (!textToScan) return EMPTY_RESULT;

  const threats: ThreatMatch[] = [];

  for (const pattern of THREAT_PATTERNS) {
    // Skip patterns that don't apply to this tool
    if (pattern.tools && !pattern.tools.includes(toolName)) continue;

    // Reset regex state
    pattern.pattern.lastIndex = 0;

    const match = pattern.pattern.exec(textToScan);
    if (match) {
      threats.push({ pattern, match: match[0] });
    }
  }

  if (threats.length === 0) return EMPTY_RESULT;

  const maxSeverity = threats.reduce<ThreatSeverity>((max, t) => {
    return SEVERITY_ORDER[t.pattern.severity] > SEVERITY_ORDER[max]
      ? t.pattern.severity
      : max;
  }, 'info');

  return {
    threats,
    maxSeverity,
    shouldBlock: maxSeverity === 'block',
    shouldApprove: maxSeverity === 'warning' || maxSeverity === 'critical',
  };
}

/**
 * Extract the scannable text from tool arguments based on tool type.
 */
function extractTextFromArgs(toolName: string, args: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'shell':
      return typeof args.command === 'string' ? args.command : null;

    case 'file_edit': {
      const parts: string[] = [];
      if (typeof args.path === 'string') parts.push(args.path);
      if (typeof args.content === 'string') parts.push(args.content);
      if (typeof args.action === 'string' && args.action === 'write' && typeof args.content === 'string') {
        parts.push(args.content);
      }
      return parts.length > 0 ? parts.join('\n') : null;
    }

    case 'browser': {
      const parts: string[] = [];
      if (typeof args.url === 'string') parts.push(args.url);
      if (typeof args.query === 'string') parts.push(args.query);
      return parts.length > 0 ? parts.join('\n') : null;
    }

    case 'delegate': {
      const parts: string[] = [];
      if (typeof args.task === 'string') parts.push(args.task);
      if (typeof args.handle === 'string') parts.push(args.handle);
      return parts.length > 0 ? parts.join('\n') : null;
    }

    default: {
      // For unknown tools (MCP, integrations), scan all string args
      const strings = Object.values(args)
        .filter((v): v is string => typeof v === 'string');
      return strings.length > 0 ? strings.join('\n') : null;
    }
  }
}

/**
 * Format a threat result as a human-readable string for event stream logging.
 */
export function formatThreatSummary(result: ThreatResult): string {
  if (result.threats.length === 0) return '';

  const categories = [...new Set(result.threats.map(t => t.pattern.category))];
  const descriptions = result.threats.map(t => t.pattern.description);

  return `[${result.maxSeverity.toUpperCase()}] ${categories.join(', ')}: ${descriptions.join('; ')}`;
}
