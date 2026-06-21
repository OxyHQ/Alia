/**
 * Secret Scanner — Detects and redacts secrets in agent outputs.
 *
 * Scans text for API keys, tokens, passwords, private keys, and connection strings.
 * Returns matches with redacted versions to prevent accidental exposure.
 */

export interface SecretMatch {
  type: string;
  value: string;
  redacted: string;
  severity: 'info' | 'warning' | 'critical';
}

interface SecretPattern {
  type: string;
  pattern: RegExp;
  severity: 'info' | 'warning' | 'critical';
  /** Build redacted string from the match. Defaults to first 6 + "****" + last 4 chars. */
  redact?: (match: string) => string;
}

function defaultRedact(match: string): string {
  if (match.length <= 12) return '****';
  return match.slice(0, 6) + '****' + match.slice(-4);
}

function prefixRedact(prefixLen: number) {
  return (match: string) => match.slice(0, prefixLen) + '****';
}

const SECRET_PATTERNS: SecretPattern[] = [
  // ── AWS ──
  { type: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, severity: 'critical' },
  { type: 'aws_secret_key', pattern: /(?:aws_secret_access_key|aws_secret)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi, severity: 'critical' },

  // ── Stripe ──
  { type: 'stripe_secret_key', pattern: /\bsk_live_[a-zA-Z0-9]{24,}\b/g, severity: 'critical', redact: prefixRedact(8) },
  { type: 'stripe_publishable_key', pattern: /\bpk_live_[a-zA-Z0-9]{24,}\b/g, severity: 'warning', redact: prefixRedact(8) },
  { type: 'stripe_restricted_key', pattern: /\brk_live_[a-zA-Z0-9]{24,}\b/g, severity: 'critical', redact: prefixRedact(8) },

  // ── GitHub ──
  { type: 'github_pat', pattern: /\bghp_[a-zA-Z0-9]{36}\b/g, severity: 'critical', redact: prefixRedact(4) },
  { type: 'github_pat_fine', pattern: /\bgithub_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}\b/g, severity: 'critical', redact: prefixRedact(11) },
  { type: 'github_oauth', pattern: /\bgho_[a-zA-Z0-9]{36}\b/g, severity: 'critical', redact: prefixRedact(4) },

  // ── Google ──
  { type: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, severity: 'critical', redact: prefixRedact(4) },

  // ── OpenAI ──
  { type: 'openai_api_key', pattern: /\bsk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}\b/g, severity: 'critical', redact: prefixRedact(3) },
  { type: 'openai_api_key_v2', pattern: /\bsk-proj-[a-zA-Z0-9_-]{40,}\b/g, severity: 'critical', redact: prefixRedact(8) },

  // ── Anthropic ──
  { type: 'anthropic_api_key', pattern: /\bsk-ant-[a-zA-Z0-9_-]{40,}\b/g, severity: 'critical', redact: prefixRedact(7) },

  // ── Slack ──
  { type: 'slack_token', pattern: /\bxox[bpras]-[0-9]{10,}-[a-zA-Z0-9-]+\b/g, severity: 'critical', redact: prefixRedact(4) },
  { type: 'slack_webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[a-zA-Z0-9]+/g, severity: 'critical' },

  // ── Twilio ──
  { type: 'twilio_api_key', pattern: /\bSK[a-f0-9]{32}\b/g, severity: 'critical', redact: prefixRedact(2) },

  // ── SendGrid ──
  { type: 'sendgrid_api_key', pattern: /\bSG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}\b/g, severity: 'critical', redact: prefixRedact(3) },

  // ── Mailgun ──
  { type: 'mailgun_api_key', pattern: /\bkey-[a-zA-Z0-9]{32}\b/g, severity: 'critical', redact: prefixRedact(4) },

  // ── JWT ──
  { type: 'jwt_token', pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, severity: 'warning', redact: (m) => m.slice(0, 10) + '****' },

  // ── Private Keys ──
  { type: 'private_key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, severity: 'critical', redact: () => '[REDACTED PRIVATE KEY]' },

  // ── Connection Strings ──
  { type: 'mongodb_uri', pattern: /\bmongodb(?:\+srv)?:\/\/[^\s"'`,)}\]]+/g, severity: 'critical', redact: (m) => m.replace(/:\/\/([^@]+)@/, '://****@') },
  { type: 'postgres_uri', pattern: /\bpostgres(?:ql)?:\/\/[^\s"'`,)}\]]+/g, severity: 'critical', redact: (m) => m.replace(/:\/\/([^@]+)@/, '://****@') },
  { type: 'mysql_uri', pattern: /\bmysql:\/\/[^\s"'`,)}\]]+/g, severity: 'critical', redact: (m) => m.replace(/:\/\/([^@]+)@/, '://****@') },
  { type: 'redis_uri', pattern: /\bredis(?:s)?:\/\/[^\s"'`,)}\]]+/g, severity: 'critical', redact: (m) => m.replace(/:\/\/([^@]+)@/, '://****@') },

  // ── Heroku ──
  { type: 'heroku_api_key', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, severity: 'info' },

  // ── Generic Secrets ──
  { type: 'generic_secret', pattern: /(?:password|passwd|secret|api_key|apikey|access_token|auth_token|private_key)\s*[:=]\s*['"]([^'"]{8,})['"](?!\s*[:=])/gi, severity: 'warning' },
  { type: 'bearer_token', pattern: /\bBearer\s+[a-zA-Z0-9_.-]{20,}\b/g, severity: 'warning', redact: (m) => 'Bearer ****' },

  // ── npm token ──
  { type: 'npm_token', pattern: /\bnpm_[a-zA-Z0-9]{36}\b/g, severity: 'critical', redact: prefixRedact(4) },

  // ── PyPI token ──
  { type: 'pypi_token', pattern: /\bpypi-[a-zA-Z0-9_-]{50,}\b/g, severity: 'critical', redact: prefixRedact(5) },
];

/**
 * Scan text for secrets. Returns all matches found.
 */
export function scanForSecrets(text: string): SecretMatch[] {
  if (!text || text.length < 8) return [];

  const matches: SecretMatch[] = [];
  const seen = new Set<string>();

  for (const sp of SECRET_PATTERNS) {
    // Reset regex lastIndex for global patterns
    sp.pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = sp.pattern.exec(text)) !== null) {
      const value = match[1] || match[0]; // Use capture group if present, else full match
      const fullMatch = match[0];

      // Skip Heroku-like UUIDs that are too common (only flag if in context of a secret assignment)
      if (sp.type === 'heroku_api_key') continue;

      // Deduplicate
      if (seen.has(fullMatch)) continue;
      seen.add(fullMatch);

      const redactFn = sp.redact || defaultRedact;
      matches.push({
        type: sp.type,
        value: fullMatch,
        redacted: redactFn(fullMatch),
        severity: sp.severity,
      });
    }
  }

  return matches;
}

/**
 * Scan text and return a redacted version with all secrets replaced.
 */
export function redactSecrets(text: string): { redacted: string; matches: SecretMatch[] } {
  if (!text || text.length < 8) return { redacted: text, matches: [] };

  const matches = scanForSecrets(text);
  if (matches.length === 0) return { redacted: text, matches: [] };

  let redacted = text;
  // Sort by value length descending to replace longest matches first (avoids partial replacements)
  const sorted = [...matches].sort((a, b) => b.value.length - a.value.length);
  for (const m of sorted) {
    redacted = redacted.replaceAll(m.value, m.redacted);
  }

  return { redacted, matches };
}
