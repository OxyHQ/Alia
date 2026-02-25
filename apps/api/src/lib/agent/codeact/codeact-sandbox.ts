/**
 * CodeAct Sandbox — Static Analysis Safety Layer
 *
 * Provides pre-execution safety checks for agent-generated Python code.
 * Blocks dangerous patterns (shell injection, network abuse, file system escape)
 * while allowing legitimate use of the Python ecosystem.
 *
 * Defense-in-depth: This is a first line of defense. The container itself
 * provides the real isolation boundary (no host access, resource limits).
 */

/** Patterns that indicate potentially dangerous operations */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Shell injection
  { pattern: /os\.system\s*\(/, reason: 'os.system() is blocked — use subprocess.run() instead' },
  { pattern: /subprocess\.\w+\([^)]*shell\s*=\s*True/, reason: 'subprocess with shell=True is blocked' },
  { pattern: /exec\s*\(\s*['"].*\bsh\b/, reason: 'exec() with shell commands is blocked' },

  // Network abuse
  { pattern: /socket\.socket\s*\(/, reason: 'Raw sockets are blocked — use requests/httpx instead' },
  { pattern: /\bftplib\b/, reason: 'FTP access is blocked' },
  { pattern: /\bsmtplib\b/, reason: 'SMTP (email sending) is blocked' },

  // Filesystem escape
  { pattern: /open\s*\(\s*['"]\/etc\//, reason: 'Reading system files outside /workspace is blocked' },
  { pattern: /open\s*\(\s*['"]\/proc\//, reason: 'Reading /proc is blocked' },
  { pattern: /open\s*\(\s*['"]\/sys\//, reason: 'Reading /sys is blocked' },

  // Resource exhaustion
  { pattern: /while\s+True\s*:(?!\s*#)(?!.*break)/, reason: 'Infinite loops without break are blocked' },
  { pattern: /fork\s*\(/, reason: 'os.fork() is blocked' },
];

/** Imports that should trigger a warning (not blocked, but logged) */
const WARNED_IMPORTS = [
  'ctypes',
  'multiprocessing',
  'threading',
];

export interface SandboxCheckResult {
  safe: boolean;
  violations: string[];
  warnings: string[];
}

/**
 * Analyze Python code for safety before execution.
 * Returns a result indicating whether the code is safe to execute.
 */
export function checkCodeSafety(code: string): SandboxCheckResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  // Check for blocked patterns
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      violations.push(reason);
    }
  }

  // Check for warned imports
  for (const imp of WARNED_IMPORTS) {
    if (new RegExp(`\\bimport\\s+${imp}\\b|\\bfrom\\s+${imp}\\b`).test(code)) {
      warnings.push(`Use of '${imp}' module detected — proceed with caution`);
    }
  }

  return {
    safe: violations.length === 0,
    violations,
    warnings,
  };
}

/**
 * Maximum allowed code length (characters).
 * Prevents agents from generating excessively large scripts.
 */
export const MAX_CODE_LENGTH = 50_000;

/**
 * Default execution timeout (milliseconds).
 * Prevents runaway scripts from consuming resources indefinitely.
 */
export const DEFAULT_EXEC_TIMEOUT = 60_000;
