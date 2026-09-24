/**
 * Threat Patterns — Categorized security patterns for agent tool call analysis.
 *
 * Each pattern targets a specific threat category with a severity level:
 *   - info:     Logged for awareness, no action taken
 *   - warning:  Requires user approval before execution
 *   - critical: Requires user approval, highlighted as dangerous
 *   - block:    Automatically blocked, never executed
 */

export type ThreatCategory =
  | 'destructive_command'
  | 'privilege_escalation'
  | 'data_exfiltration'
  | 'network_abuse'
  | 'credential_access'
  | 'injection'
  | 'resource_abuse'
  | 'pii_exposure'
  | 'prompt_injection'
  | 'secret_exposure';

export type ThreatSeverity = 'info' | 'warning' | 'critical' | 'block';

export interface ThreatPattern {
  id: string;
  category: ThreatCategory;
  pattern: RegExp;
  severity: ThreatSeverity;
  description: string;
  /** Which tool types this pattern applies to. null = all tools. */
  tools?: string[];
}

// ── Network Abuse ──

/**
 * What remains once the patterns for `shell` and `file_edit` went with those
 * primitives: a hundred regexes over bash commands and workspace paths, scoped
 * by `tools` to two tools that no longer exist, match nothing and were deleted
 * rather than left to read as protection.
 *
 * These two stay because a URL is still an argument something can carry. The
 * `browser` primitive is also guarded by `validateUrl` before Clarity is asked
 * anything; this is the belt to that brace, and it is what makes the attempt
 * visible in the event stream.
 */
const NETWORK_ABUSE: ThreatPattern[] = [
  { id: 'na-001', category: 'network_abuse', pattern: /169\.254\.169\.254/i, severity: 'block', description: 'Cloud metadata endpoint access', tools: ['browser'] },
  { id: 'na-002', category: 'network_abuse', pattern: /metadata\.google\.internal/i, severity: 'block', description: 'GCP metadata endpoint', tools: ['browser'] },
];

// ── PII Exposure ──

const PII_EXPOSURE: ThreatPattern[] = [
  { id: 'pi-001', category: 'pii_exposure', pattern: /\b\d{3}-\d{2}-\d{4}\b/i, severity: 'warning', description: 'Social Security Number pattern' },
  { id: 'pi-002', category: 'pii_exposure', pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/i, severity: 'warning', description: 'Credit card number pattern' },
  { id: 'pi-003', category: 'pii_exposure', pattern: /\b[A-Z]{2}\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{0,2}\b/i, severity: 'info', description: 'IBAN pattern' },
];

// ── Prompt Injection ──

const PROMPT_INJECTION: ThreatPattern[] = [
  { id: 'pj-001', category: 'prompt_injection', pattern: /ignore\s+(all\s+)?previous\s+instructions/i, severity: 'warning', description: 'Prompt injection: ignore previous instructions' },
  { id: 'pj-002', category: 'prompt_injection', pattern: /you\s+are\s+now\s+(?:a|an|the)\s+/i, severity: 'info', description: 'Prompt injection: role override attempt' },
  { id: 'pj-003', category: 'prompt_injection', pattern: /system\s*:\s*you\s+are\b/i, severity: 'warning', description: 'Prompt injection: system prompt override' },
  { id: 'pj-004', category: 'prompt_injection', pattern: /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|system\|>/i, severity: 'warning', description: 'Prompt injection: special tokens' },
  { id: 'pj-005', category: 'prompt_injection', pattern: /\bDAN\b.*\bjailbreak\b/i, severity: 'critical', description: 'Prompt injection: DAN jailbreak' },
];

/**
 * All threat patterns combined.
 */
export const THREAT_PATTERNS: ThreatPattern[] = [
  ...NETWORK_ABUSE,
  ...PII_EXPOSURE,
  ...PROMPT_INJECTION,
];

/** Total pattern count (for health checks / metrics) */
export const PATTERN_COUNT = THREAT_PATTERNS.length;
