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

// ── Destructive Commands ──

const DESTRUCTIVE: ThreatPattern[] = [
  { id: 'dc-001', category: 'destructive_command', pattern: /\brm\s+(-[a-z]*f[a-z]*\s+)?(-[a-z]*r[a-z]*\s+)?\//i, severity: 'block', description: 'Recursive delete from root', tools: ['shell'] },
  { id: 'dc-002', category: 'destructive_command', pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\b/i, severity: 'critical', description: 'Recursive force delete', tools: ['shell'] },
  { id: 'dc-003', category: 'destructive_command', pattern: /\brm\s+-[a-z]*f[a-z]*r[a-z]*\b/i, severity: 'critical', description: 'Recursive force delete', tools: ['shell'] },
  { id: 'dc-004', category: 'destructive_command', pattern: /\bmkfs\b/i, severity: 'block', description: 'Filesystem format command', tools: ['shell'] },
  { id: 'dc-005', category: 'destructive_command', pattern: /\bdd\s+if=/i, severity: 'critical', description: 'Raw disk write (dd)', tools: ['shell'] },
  { id: 'dc-006', category: 'destructive_command', pattern: />\s*\/dev\/[sh]d[a-z]/i, severity: 'block', description: 'Write to disk device', tools: ['shell'] },
  { id: 'dc-007', category: 'destructive_command', pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/i, severity: 'block', description: 'Fork bomb', tools: ['shell'] },
  { id: 'dc-008', category: 'destructive_command', pattern: /\bshred\s+-[a-z]*[vfz]/i, severity: 'critical', description: 'Secure file shredding', tools: ['shell'] },
  { id: 'dc-009', category: 'destructive_command', pattern: /\bwipefs\b/i, severity: 'block', description: 'Wipe filesystem signatures', tools: ['shell'] },
  { id: 'dc-010', category: 'destructive_command', pattern: />\s*\/dev\/null\s*2>&1\s*<\s*\/dev\/null/i, severity: 'warning', description: 'Silent discard of all I/O', tools: ['shell'] },
  { id: 'dc-011', category: 'destructive_command', pattern: /\bfdisk\b/i, severity: 'block', description: 'Disk partition tool', tools: ['shell'] },
  { id: 'dc-012', category: 'destructive_command', pattern: /\bparted\b/i, severity: 'block', description: 'Disk partition tool', tools: ['shell'] },
  { id: 'dc-013', category: 'destructive_command', pattern: /\btruncate\s.*--size\s*0/i, severity: 'critical', description: 'Truncate file to zero', tools: ['shell'] },
  { id: 'dc-014', category: 'destructive_command', pattern: />\s*\/etc\//i, severity: 'block', description: 'Overwrite system config file', tools: ['shell'] },
  { id: 'dc-015', category: 'destructive_command', pattern: /\bmv\s+\/\s/i, severity: 'block', description: 'Move root directory', tools: ['shell'] },
];

// ── Privilege Escalation ──

const PRIVILEGE_ESCALATION: ThreatPattern[] = [
  { id: 'pe-001', category: 'privilege_escalation', pattern: /\bchmod\s+777\b/i, severity: 'warning', description: 'World-writable permissions', tools: ['shell'] },
  { id: 'pe-002', category: 'privilege_escalation', pattern: /\bchmod\s+[0-7]*[24567][0-7]*\s+\/(?:usr|bin|sbin|etc)/i, severity: 'critical', description: 'Changing system directory permissions', tools: ['shell'] },
  { id: 'pe-003', category: 'privilege_escalation', pattern: /\bchmod\s+u\+s\b/i, severity: 'critical', description: 'Setting SUID bit', tools: ['shell'] },
  { id: 'pe-004', category: 'privilege_escalation', pattern: /\bchmod\s+g\+s\b/i, severity: 'warning', description: 'Setting SGID bit', tools: ['shell'] },
  { id: 'pe-005', category: 'privilege_escalation', pattern: /\bchown\s+root\b/i, severity: 'critical', description: 'Changing ownership to root', tools: ['shell'] },
  { id: 'pe-006', category: 'privilege_escalation', pattern: /\bsudo\b/i, severity: 'warning', description: 'Running command with sudo', tools: ['shell'] },
  { id: 'pe-007', category: 'privilege_escalation', pattern: /\bsu\s+-/i, severity: 'warning', description: 'Switching to root user', tools: ['shell'] },
  { id: 'pe-008', category: 'privilege_escalation', pattern: /\bvisudo\b/i, severity: 'critical', description: 'Editing sudoers file', tools: ['shell'] },
  { id: 'pe-009', category: 'privilege_escalation', pattern: /\/etc\/sudoers/i, severity: 'critical', description: 'Accessing sudoers file', tools: ['shell', 'file_edit'] },
  { id: 'pe-010', category: 'privilege_escalation', pattern: /\busermod\s.*-aG\s*(sudo|wheel|root)/i, severity: 'critical', description: 'Adding user to privileged group', tools: ['shell'] },
  { id: 'pe-011', category: 'privilege_escalation', pattern: /\bpasswd\s+root\b/i, severity: 'block', description: 'Changing root password', tools: ['shell'] },
  { id: 'pe-012', category: 'privilege_escalation', pattern: /\bnsenter\b/i, severity: 'critical', description: 'Entering namespace (container escape)', tools: ['shell'] },
  { id: 'pe-013', category: 'privilege_escalation', pattern: /\bcapsh\b/i, severity: 'critical', description: 'Capability shell (privilege manipulation)', tools: ['shell'] },
];

// ── Data Exfiltration ──

const DATA_EXFILTRATION: ThreatPattern[] = [
  { id: 'de-001', category: 'data_exfiltration', pattern: /\bcurl\s.*-d\s.*@/i, severity: 'critical', description: 'Uploading file via curl', tools: ['shell'] },
  { id: 'de-002', category: 'data_exfiltration', pattern: /\bcurl\s.*--data-binary\s.*@/i, severity: 'critical', description: 'Uploading binary file via curl', tools: ['shell'] },
  { id: 'de-003', category: 'data_exfiltration', pattern: /\bwget\s.*--post-(data|file)/i, severity: 'critical', description: 'Sending data via wget POST', tools: ['shell'] },
  { id: 'de-004', category: 'data_exfiltration', pattern: /\bnc\s+-[a-z]*e\b/i, severity: 'block', description: 'Netcat with execute (reverse shell)', tools: ['shell'] },
  { id: 'de-005', category: 'data_exfiltration', pattern: /\bncat\s.*-e\b/i, severity: 'block', description: 'Ncat with execute (reverse shell)', tools: ['shell'] },
  { id: 'de-006', category: 'data_exfiltration', pattern: /\bbase64\b.*\|\s*\bcurl\b/i, severity: 'critical', description: 'Base64 encoding piped to curl', tools: ['shell'] },
  { id: 'de-007', category: 'data_exfiltration', pattern: /\bscp\b.*@[^:]+:/i, severity: 'warning', description: 'Copying files to remote server', tools: ['shell'] },
  { id: 'de-008', category: 'data_exfiltration', pattern: /\brsync\b.*@[^:]+:/i, severity: 'warning', description: 'Syncing files to remote server', tools: ['shell'] },
  { id: 'de-009', category: 'data_exfiltration', pattern: /\bsftp\b/i, severity: 'warning', description: 'SFTP file transfer', tools: ['shell'] },
  { id: 'de-010', category: 'data_exfiltration', pattern: /\bftp\b\s+[^\s]/i, severity: 'warning', description: 'FTP file transfer', tools: ['shell'] },
  { id: 'de-011', category: 'data_exfiltration', pattern: /\|.*\bmail\b/i, severity: 'critical', description: 'Piping output to mail command', tools: ['shell'] },
  { id: 'de-012', category: 'data_exfiltration', pattern: /\btar\s.*\|\s*\bcurl\b/i, severity: 'critical', description: 'Archiving and uploading via curl', tools: ['shell'] },
  { id: 'de-013', category: 'data_exfiltration', pattern: /\bzip\s.*\|\s*\bcurl\b/i, severity: 'critical', description: 'Zipping and uploading via curl', tools: ['shell'] },
  { id: 'de-014', category: 'data_exfiltration', pattern: /\/dev\/tcp\//i, severity: 'block', description: 'Bash /dev/tcp network access', tools: ['shell'] },
  { id: 'de-015', category: 'data_exfiltration', pattern: /\/dev\/udp\//i, severity: 'block', description: 'Bash /dev/udp network access', tools: ['shell'] },
];

// ── Network Abuse ──

const NETWORK_ABUSE: ThreatPattern[] = [
  { id: 'na-001', category: 'network_abuse', pattern: /169\.254\.169\.254/i, severity: 'block', description: 'Cloud metadata endpoint access', tools: ['shell', 'browser'] },
  { id: 'na-002', category: 'network_abuse', pattern: /metadata\.google\.internal/i, severity: 'block', description: 'GCP metadata endpoint', tools: ['shell', 'browser'] },
  { id: 'na-003', category: 'network_abuse', pattern: /\bcurl\b.*\blocalhost\b/i, severity: 'warning', description: 'Accessing localhost', tools: ['shell'] },
  { id: 'na-004', category: 'network_abuse', pattern: /\bcurl\b.*127\.0\.0\.1/i, severity: 'warning', description: 'Accessing loopback address', tools: ['shell'] },
  { id: 'na-005', category: 'network_abuse', pattern: /\bcurl\b.*\|\s*\bbash\b/i, severity: 'block', description: 'Piping curl to bash (remote code execution)', tools: ['shell'] },
  { id: 'na-006', category: 'network_abuse', pattern: /\bwget\b.*\|\s*\bbash\b/i, severity: 'block', description: 'Piping wget to bash (remote code execution)', tools: ['shell'] },
  { id: 'na-007', category: 'network_abuse', pattern: /\bcurl\b.*\|\s*\bsh\b/i, severity: 'block', description: 'Piping curl to sh (remote code execution)', tools: ['shell'] },
  { id: 'na-008', category: 'network_abuse', pattern: /\bwget\b.*\|\s*\bsh\b/i, severity: 'block', description: 'Piping wget to sh (remote code execution)', tools: ['shell'] },
  { id: 'na-009', category: 'network_abuse', pattern: /\bssh\s+.*@/i, severity: 'warning', description: 'SSH connection to remote host', tools: ['shell'] },
  { id: 'na-010', category: 'network_abuse', pattern: /\biptables\b/i, severity: 'critical', description: 'Modifying firewall rules', tools: ['shell'] },
  { id: 'na-011', category: 'network_abuse', pattern: /\bnmap\b/i, severity: 'warning', description: 'Network scanning', tools: ['shell'] },
  { id: 'na-012', category: 'network_abuse', pattern: /\btcpdump\b/i, severity: 'warning', description: 'Network traffic capture', tools: ['shell'] },
  { id: 'na-013', category: 'network_abuse', pattern: /\bwireshark\b/i, severity: 'warning', description: 'Network protocol analysis', tools: ['shell'] },
  { id: 'na-014', category: 'network_abuse', pattern: /0\.0\.0\.0/i, severity: 'info', description: 'Binding to all interfaces', tools: ['shell'] },
  { id: 'na-015', category: 'network_abuse', pattern: /\bsocat\b/i, severity: 'warning', description: 'Socat network relay', tools: ['shell'] },
  { id: 'na-016', category: 'network_abuse', pattern: /\btunnel\b|ngrok|cloudflared/i, severity: 'warning', description: 'Network tunnel tool', tools: ['shell'] },
];

// ── Credential Access ──

const CREDENTIAL_ACCESS: ThreatPattern[] = [
  { id: 'ca-001', category: 'credential_access', pattern: /\/etc\/shadow\b/i, severity: 'block', description: 'Accessing shadow password file', tools: ['shell', 'file_edit'] },
  { id: 'ca-002', category: 'credential_access', pattern: /\/etc\/passwd\b/i, severity: 'warning', description: 'Accessing passwd file', tools: ['shell', 'file_edit'] },
  { id: 'ca-003', category: 'credential_access', pattern: /~\/\.ssh\/id_/i, severity: 'critical', description: 'Accessing SSH private keys', tools: ['shell', 'file_edit'] },
  { id: 'ca-004', category: 'credential_access', pattern: /\.ssh\/id_(rsa|ed25519|ecdsa|dsa)/i, severity: 'critical', description: 'Accessing SSH private keys', tools: ['shell', 'file_edit'] },
  { id: 'ca-005', category: 'credential_access', pattern: /\.ssh\/authorized_keys/i, severity: 'critical', description: 'Modifying SSH authorized keys', tools: ['shell', 'file_edit'] },
  { id: 'ca-006', category: 'credential_access', pattern: /\.env\b(?!\.example|\.sample|\.template)/i, severity: 'warning', description: 'Accessing .env file', tools: ['shell', 'file_edit'] },
  { id: 'ca-007', category: 'credential_access', pattern: /credentials\.json\b/i, severity: 'critical', description: 'Accessing credentials file', tools: ['shell', 'file_edit'] },
  { id: 'ca-008', category: 'credential_access', pattern: /~\/\.aws\/credentials/i, severity: 'critical', description: 'Accessing AWS credentials', tools: ['shell', 'file_edit'] },
  { id: 'ca-009', category: 'credential_access', pattern: /~\/\.aws\/config/i, severity: 'warning', description: 'Accessing AWS config', tools: ['shell', 'file_edit'] },
  { id: 'ca-010', category: 'credential_access', pattern: /\.gcloud\/application_default_credentials/i, severity: 'critical', description: 'Accessing GCP credentials', tools: ['shell', 'file_edit'] },
  { id: 'ca-011', category: 'credential_access', pattern: /\.azure\/credentials/i, severity: 'critical', description: 'Accessing Azure credentials', tools: ['shell', 'file_edit'] },
  { id: 'ca-012', category: 'credential_access', pattern: /\.docker\/config\.json/i, severity: 'critical', description: 'Accessing Docker credentials', tools: ['shell', 'file_edit'] },
  { id: 'ca-013', category: 'credential_access', pattern: /\.npmrc\b/i, severity: 'warning', description: 'Accessing npm config (may contain tokens)', tools: ['shell', 'file_edit'] },
  { id: 'ca-014', category: 'credential_access', pattern: /\.pypirc\b/i, severity: 'warning', description: 'Accessing PyPI config (may contain tokens)', tools: ['shell', 'file_edit'] },
  { id: 'ca-015', category: 'credential_access', pattern: /\.netrc\b/i, severity: 'critical', description: 'Accessing .netrc credentials', tools: ['shell', 'file_edit'] },
  { id: 'ca-016', category: 'credential_access', pattern: /\.pgpass\b/i, severity: 'critical', description: 'Accessing PostgreSQL password file', tools: ['shell', 'file_edit'] },
  { id: 'ca-017', category: 'credential_access', pattern: /\.my\.cnf\b/i, severity: 'critical', description: 'Accessing MySQL config (may contain password)', tools: ['shell', 'file_edit'] },
  { id: 'ca-018', category: 'credential_access', pattern: /\bkeychain\b.*dump/i, severity: 'block', description: 'Dumping keychain', tools: ['shell'] },
  { id: 'ca-019', category: 'credential_access', pattern: /\.kube\/config/i, severity: 'critical', description: 'Accessing Kubernetes config', tools: ['shell', 'file_edit'] },
  { id: 'ca-020', category: 'credential_access', pattern: /\bhtpasswd\b/i, severity: 'warning', description: 'Accessing HTTP password file', tools: ['shell', 'file_edit'] },
];

// ── Injection ──

const INJECTION: ThreatPattern[] = [
  { id: 'in-001', category: 'injection', pattern: /;\s*rm\s/i, severity: 'critical', description: 'Command injection: semicolon + rm', tools: ['shell'] },
  { id: 'in-002', category: 'injection', pattern: /\|\s*bash\b/i, severity: 'critical', description: 'Piping to bash', tools: ['shell'] },
  { id: 'in-003', category: 'injection', pattern: /\|\s*sh\b/i, severity: 'critical', description: 'Piping to sh', tools: ['shell'] },
  { id: 'in-004', category: 'injection', pattern: /\beval\s*\(/i, severity: 'warning', description: 'Using eval (code injection risk)', tools: ['shell'] },
  { id: 'in-005', category: 'injection', pattern: /\bexec\s*\(/i, severity: 'warning', description: 'Using exec (code injection risk)', tools: ['shell'] },
  { id: 'in-006', category: 'injection', pattern: /\bpython\s+-c\s+['"].*__(import|eval|exec)/i, severity: 'critical', description: 'Python code injection', tools: ['shell'] },
  { id: 'in-007', category: 'injection', pattern: /\bperl\s+-e\s/i, severity: 'warning', description: 'Perl one-liner execution', tools: ['shell'] },
  { id: 'in-008', category: 'injection', pattern: /\bruby\s+-e\s/i, severity: 'warning', description: 'Ruby one-liner execution', tools: ['shell'] },
  { id: 'in-009', category: 'injection', pattern: /\bnode\s+-e\s/i, severity: 'info', description: 'Node.js one-liner execution', tools: ['shell'] },
  { id: 'in-010', category: 'injection', pattern: /\$\(.*\brm\b/i, severity: 'critical', description: 'Command substitution with rm', tools: ['shell'] },
  { id: 'in-011', category: 'injection', pattern: /`.*\brm\b.*`/i, severity: 'critical', description: 'Backtick substitution with rm', tools: ['shell'] },
  { id: 'in-012', category: 'injection', pattern: /\bxargs\s.*\brm\b/i, severity: 'critical', description: 'xargs piped to rm', tools: ['shell'] },
  { id: 'in-013', category: 'injection', pattern: /\bsource\s+\/dev\/stdin/i, severity: 'block', description: 'Sourcing from stdin', tools: ['shell'] },
];

// ── Resource Abuse ──

const RESOURCE_ABUSE: ThreatPattern[] = [
  { id: 'ra-001', category: 'resource_abuse', pattern: /\bwhile\s+true\s*;?\s*do\b/i, severity: 'warning', description: 'Infinite loop', tools: ['shell'] },
  { id: 'ra-002', category: 'resource_abuse', pattern: /\bfor\s*\(\s*;\s*;\s*\)/i, severity: 'warning', description: 'Infinite for loop', tools: ['shell'] },
  { id: 'ra-003', category: 'resource_abuse', pattern: /\bstress\b/i, severity: 'critical', description: 'Stress testing tool', tools: ['shell'] },
  { id: 'ra-004', category: 'resource_abuse', pattern: /\bstress-ng\b/i, severity: 'critical', description: 'Stress-ng testing tool', tools: ['shell'] },
  { id: 'ra-005', category: 'resource_abuse', pattern: /\byes\s*\|/i, severity: 'warning', description: 'yes command (resource abuse)', tools: ['shell'] },
  { id: 'ra-006', category: 'resource_abuse', pattern: /\bcat\s+\/dev\/urandom/i, severity: 'warning', description: 'Reading from /dev/urandom', tools: ['shell'] },
  { id: 'ra-007', category: 'resource_abuse', pattern: /\bnohup\b.*&\s*$/i, severity: 'warning', description: 'Background persistent process', tools: ['shell'] },
  { id: 'ra-008', category: 'resource_abuse', pattern: /\bcryptominer\b|\bxmrig\b|\bminerd\b/i, severity: 'block', description: 'Cryptocurrency miner', tools: ['shell'] },
  { id: 'ra-009', category: 'resource_abuse', pattern: /\bulimit\s+-[a-z]\s+unlimited/i, severity: 'critical', description: 'Removing resource limits', tools: ['shell'] },
  { id: 'ra-010', category: 'resource_abuse', pattern: /\bfallocate\b.*-l\s+\d{3,}[GT]/i, severity: 'critical', description: 'Allocating large disk space (100GB+)', tools: ['shell'] },
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
  ...DESTRUCTIVE,
  ...PRIVILEGE_ESCALATION,
  ...DATA_EXFILTRATION,
  ...NETWORK_ABUSE,
  ...CREDENTIAL_ACCESS,
  ...INJECTION,
  ...RESOURCE_ABUSE,
  ...PII_EXPOSURE,
  ...PROMPT_INJECTION,
];

/** Total pattern count (for health checks / metrics) */
export const PATTERN_COUNT = THREAT_PATTERNS.length;
