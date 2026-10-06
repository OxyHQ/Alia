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
  // Forgetting is the person's own request ("olvida esto"); the same tier as
  // the edit it is, and as the delete button on the memory screen.
  'forgetUserMemory',
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
function classifyPrimitive(
  toolName: string,
  args: Record<string, unknown> = {},
  attended = false,
): ActionRisk | null {
  switch (toolName) {
    case 'plan':
      return R0('Planning is internal to the session');
    case 'browser':
      return R0('Search and page reading is autonomous');
    case 'delegate':
      return R1('Delegation runs another Alia agent under this session budget', false);
    case 'memory': {
      const action = typeof args.action === 'string' ? args.action : '';
      if (action === 'read' || action === 'list') return R0('Reading the agent\'s own memory is autonomous');
      // Forgetting purges the file and its journal on the person's request,
      // so it is R1 without a rollback: there is deliberately nothing to restore.
      if (action === 'forget') return R1('Forgetting part of the agent\'s own memory, as the person asked', false);
      return R1('Writing the agent\'s own memory, journaled and reversible', true);
    }
    case 'continueInBackground':
      return R1('Starts a held, admitted background run of the same agent for this person', false);
    case 'sendMessageToUser':
      return R1('Writes into the agent\'s own conversation with the person, under the outreach budget', false);
    case 'scheduleFollowUp':
      return R1('Schedules the agent\'s own one-off follow-up, under the pending limit', false);
    // The agent's own computer: a gVisor container with no network, so what a
    // call does stays inside the agent's sandbox. Reading is autonomous; a
    // change is R1 but offers no rollback (nothing snapshots the old content,
    // and a record promising an inverse would lie). A BACKGROUND command is R2:
    // it keeps running after the call returns, where nobody sees what it does.
    case 'computer_status':
    case 'list_computer_files':
    case 'read_computer_file':
      return R0('Reading the agent\'s own sandboxed computer is autonomous');
    case 'computer_start':
    case 'computer_stop':
      return R1('Starts or stops the agent\'s own sandboxed computer', false);
    case 'write_computer_file':
      return R1('Writes a file inside the agent\'s own networkless sandbox', false);
    case 'run_computer_command':
      return args.background === true
        ? {
            riskLevel: 'R2',
            reason: 'A background process keeps running in the sandbox after the call, unobserved',
            reversible: false,
            externalImpact: false,
          }
        : R1('Runs a bounded command inside the agent\'s own networkless sandbox', false);
    // The agent's own browser (`lib/computer/browser-tools.ts`). Looking is
    // autonomous. Opening, clicking, scrolling and closing act on the open web
    // under the agent's own profile but submit nothing on their own. Typing and
    // Enter are how a form is filled and SENT: with the person in the chat they
    // are R1 (they see the turn, and can take the browser over); in a
    // background run nobody is watching, so they need an approval.
    case 'browser_read':
    case 'browser_screenshot':
    case 'browser_scroll':
      return R0('Looking at the agent\'s own browser is autonomous');
    case 'browser_open':
    case 'browser_click':
    case 'browser_close':
      return R1('Navigates the agent\'s own browser; nothing is typed or submitted', false);
    case 'browser_type':
      return attended
        ? R1('Types into a page in the agent\'s own browser while the person is in the conversation', false)
        : {
            riskLevel: 'R2',
            reason: 'Typing into a web form in the background, where nobody sees what is sent',
            reversible: false,
            externalImpact: true,
          };
    case 'browser_key':
      return args.key === 'Enter' && !attended
        ? {
            riskLevel: 'R2',
            reason: 'Enter submits a web form in the background, where nobody sees what is sent',
            reversible: false,
            externalImpact: true,
          }
        : R1('Presses a key in the agent\'s own browser', false);
    default:
      return null;
  }
}

export function classifyActionRisk(
  toolName: string,
  args: Record<string, unknown>,
  options: {
    declaredReadOnly?: boolean;
    /**
     * A person is in the conversation as this runs (a chat turn), rather than
     * a background run nobody is watching. Only the browser's typing tools
     * read it.
     */
    attended?: boolean;
  } = {},
): ActionRisk {
  const primitive = classifyPrimitive(toolName, args, options.attended === true);
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
