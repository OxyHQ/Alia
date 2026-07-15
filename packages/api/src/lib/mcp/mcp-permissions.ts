/**
 * MCP Permissions — Tool Governance Layer
 *
 * Controls which MCP tools are available, rate-limited, or require confirmation.
 * Enables fine-grained access control per user, per tool, or per server.
 */


export interface ToolPermission {
  /** Glob pattern matching tool names (e.g. "mcp_github__*", "mcp_*__delete*") */
  pattern: string;
  /** Permission level */
  level: 'allow' | 'deny' | 'confirm';
  /** Optional rate limit (calls per minute) */
  rateLimit?: number;
  /** Optional description for why this rule exists */
  reason?: string;
}

/** Default permissions applied to all users */
const DEFAULT_PERMISSIONS: ToolPermission[] = [
  // Allow all read operations by default
  { pattern: 'mcp_*__get*', level: 'allow' },
  { pattern: 'mcp_*__list*', level: 'allow' },
  { pattern: 'mcp_*__search*', level: 'allow' },
  { pattern: 'mcp_*__read*', level: 'allow' },
  // Rate-limit write operations
  { pattern: 'mcp_*__create*', level: 'allow', rateLimit: 10 },
  { pattern: 'mcp_*__update*', level: 'allow', rateLimit: 10 },
  // Destructive operations need higher scrutiny
  { pattern: 'mcp_*__delete*', level: 'allow', rateLimit: 5 },
];

/** Rate limit tracking: userId -> toolPattern -> call timestamps */
const rateLimitState = new Map<string, Map<string, number[]>>();

/**
 * Check if a tool call is permitted for a user.
 * Returns { allowed, reason } — if not allowed, reason explains why.
 */
export function checkToolPermission(
  userId: string,
  toolName: string,
  userPermissions?: ToolPermission[],
): { allowed: boolean; reason?: string } {
  // Merge user-specific permissions with defaults (user rules take priority)
  const rules = [...(userPermissions || []), ...DEFAULT_PERMISSIONS];

  // Find the first matching rule
  for (const rule of rules) {
    if (matchGlob(rule.pattern, toolName)) {
      if (rule.level === 'deny') {
        return { allowed: false, reason: rule.reason || `Denied by rule: ${rule.pattern}` };
      }

      // Check rate limit
      if (rule.rateLimit) {
        const limited = checkRateLimit(userId, rule.pattern, rule.rateLimit);
        if (limited) {
          return { allowed: false, reason: `Rate limit exceeded (${rule.rateLimit}/min) for ${rule.pattern}` };
        }
      }

      return { allowed: true };
    }
  }

  // Default: allow if no rule matches
  return { allowed: true };
}

/**
 * Record a tool call for rate limiting purposes.
 */
export function recordToolCall(userId: string, toolName: string): void {
  const rules = DEFAULT_PERMISSIONS;
  for (const rule of rules) {
    if (rule.rateLimit && matchGlob(rule.pattern, toolName)) {
      if (!rateLimitState.has(userId)) {
        rateLimitState.set(userId, new Map());
      }
      const userState = rateLimitState.get(userId)!;
      if (!userState.has(rule.pattern)) {
        userState.set(rule.pattern, []);
      }
      userState.get(rule.pattern)!.push(Date.now());
      break;
    }
  }
}

function checkRateLimit(userId: string, pattern: string, maxPerMinute: number): boolean {
  const userState = rateLimitState.get(userId);
  if (!userState) return false;

  const calls = userState.get(pattern);
  if (!calls) return false;

  const oneMinuteAgo = Date.now() - 60_000;
  // Prune old entries
  const recent = calls.filter(t => t > oneMinuteAgo);
  userState.set(pattern, recent);

  return recent.length >= maxPerMinute;
}

/**
 * Simple glob matching supporting * wildcards.
 */
function matchGlob(pattern: string, text: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
  return regex.test(text);
}

/**
 * Clean up rate limit state for a user (call on disconnect).
 */
export function clearRateLimitState(userId: string): void {
  rateLimitState.delete(userId);
}
