import { getDb } from '../../db/index.js';
import { insertRollbackRecord } from '../../db/agents/rollbackRecordRepository.js';
import { autonomyFlags } from '../autonomy/flags.js';

export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3';

export interface ActionRisk {
  riskLevel: RiskLevel;
  reason: string;
  reversible: boolean;
  externalImpact: boolean;
}

const READ_ONLY_TOOLS = new Set([
  'getCurrentDate',
  'webSearch',
  'webScraper',
  'read_file',
  'list_files',
  'search_files',
  'getWhatsAppChats',
  'getWhatsAppMessages',
]);

const REVERSIBLE_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'createAutomation',
  'saveUserMemory',
  'updateUserMemory',
  'updateUserPreferences',
  'updateUserContext',
]);

const EXTERNAL_IMPACT_TOOLS = new Set([
  // ONE name. `sendTelegram` was the second spelling of this same factory on
  // the chat path; listing both was what kept the R2 gate honest while they
  // coexisted, and it is why the collapse did not silently ungate the tool.
  'sendTelegramMessage',
  'sendWhatsAppMessage',
  'sendEmail',
  'createCalendarEvent',
]);

/**
 * Irreversible operations, matched only in the arguments that carry a command
 * or a query — what an MCP server or connector would run on the agent's behalf.
 *
 * Scanning every string argument blocked a file whose content said "format"
 * and a web search for "truncate".
 */
const DESTRUCTIVE_TOKENS = [
  /\brm\s+-rf\b/i,
  /\bdel\s+\/f\b/i,
  /\bmkfs\b/i,
  /\b(?:shutdown|reboot)\b/i,
  /\bdrop\s+(?:database|schema|table)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
];

const COMMAND_ARGUMENTS = ['command', 'cmd', 'script', 'sql', 'query', 'statement'];

function hasDestructivePayload(args: Record<string, unknown>): boolean {
  const values = COMMAND_ARGUMENTS
    .map((key) => args[key])
    .filter((value): value is string => typeof value === 'string')
    .join('\n');

  return DESTRUCTIVE_TOKENS.some((pattern) => pattern.test(values));
}

const R0 = (reason: string): ActionRisk => ({ riskLevel: 'R0', reason, reversible: false, externalImpact: false });
const R1 = (reason: string, reversible: boolean): ActionRisk => ({ riskLevel: 'R1', reason, reversible, externalImpact: false });

/**
 * The runtime primitives, classified by what the CALL does rather than by name.
 *
 * `browser` only searches and reads through Clarity, `plan` is internal to the
 * session and `delegate` runs another Alia agent under this session's budget,
 * so none of them needs a person watching. They used to fall through to the
 * unknown-tool default: R2, a 60s wait for an approval nobody could give in a
 * background run, then a denial.
 */
function classifyPrimitive(toolName: string, args: Record<string, unknown> = {}): ActionRisk | null {
  switch (toolName) {
    case 'plan':
      return R0('Planning is internal to the session');
    case 'browser':
      return R0('Search and page reading is autonomous');
    case 'delegate':
      return R1('Delegation runs another Alia agent under this session budget', false);
    case 'memory': {
      const action = typeof args.action === 'string' ? args.action : '';
      return action === 'read' || action === 'list'
        ? R0('Reading the agent\'s own memory is autonomous')
        : R1('Writing the agent\'s own memory, journaled and reversible', true);
    }
    case 'continueInBackground':
      return R1('Starts a held, admitted background run of the same agent for this person', false);
    case 'sendMessageToUser':
      return R1('Writes into the agent\'s own conversation with the person, under the outreach budget', false);
    case 'scheduleFollowUp':
      return R1('Schedules the agent\'s own one-off follow-up, under the pending limit', false);
    default:
      return null;
  }
}

export function classifyActionRisk(
  toolName: string,
  args: Record<string, unknown>,
  options: { declaredReadOnly?: boolean } = {},
): ActionRisk {
  const primitive = classifyPrimitive(toolName, args);
  // A search or a plan cannot run what its text names: "how to reboot a
  // router" is a query, not a command.
  if (primitive?.riskLevel === 'R0') return primitive;

  if (hasDestructivePayload(args) || toolName === 'delete_file') {
    return {
      riskLevel: 'R3',
      reason: 'Destructive or irreversible operation blocked by policy',
      reversible: false,
      externalImpact: false,
    };
  }

  if (primitive) return primitive;

  if (EXTERNAL_IMPACT_TOOLS.has(toolName)) {
    return {
      riskLevel: 'R2',
      reason: 'External impact action requires approval',
      reversible: false,
      externalImpact: true,
    };
  }

  if (REVERSIBLE_WRITE_TOOLS.has(toolName)) {
    return R1('Reversible write action allowed with rollback window', true);
  }

  if (READ_ONLY_TOOLS.has(toolName) || options.declaredReadOnly) {
    return R0('Read-only action is autonomous');
  }

  // Unknown tools default to approval-required.
  return {
    riskLevel: 'R2',
    reason: 'Unknown tool defaults to approval-required policy',
    reversible: false,
    externalImpact: true,
  };
}

export async function createRollbackRecord(params: {
  userId: string;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  diff?: string;
  rollbackAction?: Record<string, unknown>;
}): Promise<void> {
  if (!autonomyFlags.rollbackEnabled) return;

  const expiryMinutes = Math.max(5, Number(process.env.AUTONOMY_ROLLBACK_WINDOW_MINUTES || 30));
  const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

  await insertRollbackRecord(getDb(), {
    oxyUserId: params.userId,
    sessionId: params.sessionId,
    toolName: params.toolName,
    riskLevel: 'R1',
    args: params.args,
    ...(params.beforeState === undefined ? {} : { beforeState: params.beforeState }),
    ...(params.afterState === undefined ? {} : { afterState: params.afterState }),
    ...(params.diff === undefined ? {} : { diff: params.diff }),
    ...(params.rollbackAction === undefined ? {} : { rollbackAction: params.rollbackAction }),
    status: 'open',
    expiresAt,
    executedAt: new Date(),
  });
}
