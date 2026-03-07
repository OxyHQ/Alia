import { RollbackRecord } from '../../models/rollback-record.js';
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
  'browse',
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
  'createTrigger',
  'updateTrigger',
  'saveUserMemory',
  'updateUserPreferences',
  'updateUserContext',
]);

const EXTERNAL_IMPACT_TOOLS = new Set([
  'sendTelegram',
  'sendTelegramMessage',
  'sendWhatsAppMessage',
  'sendEmail',
  'createCalendarEvent',
]);

const DESTRUCTIVE_TOKENS = [
  /\brm\s+-rf\b/i,
  /\bdel\s+\/f\b/i,
  /\bdrop\s+database\b/i,
  /\btruncate\b/i,
  /\bdelete\s+from\b/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
];

function hasDestructivePayload(args: Record<string, unknown>): boolean {
  const values = Object.values(args)
    .filter((value): value is string => typeof value === 'string')
    .join('\n');

  return DESTRUCTIVE_TOKENS.some((pattern) => pattern.test(values));
}

export function classifyActionRisk(toolName: string, args: Record<string, unknown>): ActionRisk {
  if (hasDestructivePayload(args) || toolName === 'delete_file') {
    return {
      riskLevel: 'R3',
      reason: 'Destructive or irreversible operation blocked by policy',
      reversible: false,
      externalImpact: false,
    };
  }

  if (EXTERNAL_IMPACT_TOOLS.has(toolName)) {
    return {
      riskLevel: 'R2',
      reason: 'External impact action requires approval',
      reversible: false,
      externalImpact: true,
    };
  }

  if (REVERSIBLE_WRITE_TOOLS.has(toolName)) {
    return {
      riskLevel: 'R1',
      reason: 'Reversible write action allowed with rollback window',
      reversible: true,
      externalImpact: false,
    };
  }

  if (READ_ONLY_TOOLS.has(toolName)) {
    return {
      riskLevel: 'R0',
      reason: 'Read-only action is autonomous',
      reversible: false,
      externalImpact: false,
    };
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

  await RollbackRecord.create({
    oxyUserId: params.userId,
    sessionId: params.sessionId,
    toolName: params.toolName,
    riskLevel: 'R1',
    args: params.args,
    beforeState: params.beforeState,
    afterState: params.afterState,
    diff: params.diff,
    rollbackAction: params.rollbackAction,
    status: 'open',
    expiresAt,
    executedAt: new Date(),
  });
}
