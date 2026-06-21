import type { AutonomyIntent } from '../../models/retrieval-strategy.js';

export interface IntentClassification {
  intent: AutonomyIntent;
  confidence: number;
  reason: string;
}

const INTENT_RULES: Array<{ intent: AutonomyIntent; patterns: RegExp[]; reason: string }> = [
  {
    intent: 'meeting_prep',
    patterns: [/meeting/i, /reuni[oó]n/i, /agenda/i, /prep/i, /prepare/i, /calendar/i],
    reason: 'Detected meeting preparation signals',
  },
  {
    intent: 'inbox_digest',
    patterns: [/inbox/i, /email/i, /gmail/i, /unread/i, /digest/i, /correo/i],
    reason: 'Detected inbox or email summary request',
  },
  {
    intent: 'project_status',
    patterns: [/project status/i, /estado del proyecto/i, /project/i, /roadmap/i, /milestone/i],
    reason: 'Detected project state tracking request',
  },
  {
    intent: 'task_followup',
    patterns: [/follow[- ]?up/i, /seguimiento/i, /pending/i, /todo/i, /next steps/i],
    reason: 'Detected follow-up workflow request',
  },
  {
    intent: 'monitoring',
    patterns: [/monitor/i, /alert/i, /incident/i, /health check/i, /uptime/i],
    reason: 'Detected monitoring or alerting request',
  },
  {
    intent: 'research',
    patterns: [/research/i, /investiga/i, /investigate/i, /analyze/i, /trend/i, /benchmark/i],
    reason: 'Detected research request',
  },
];

function normalizeText(input: string): string {
  return input
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function classifyIntent(messages: Array<{ role: string; content?: unknown }>): IntentClassification {
  const latestUserMessage = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && typeof m.content === 'string');

  const text = normalizeText((latestUserMessage?.content as string) || '');
  if (!text) {
    return {
      intent: 'general',
      confidence: 0.25,
      reason: 'No user text found for intent classification',
    };
  }

  for (const rule of INTENT_RULES) {
    const matches = rule.patterns.filter((p) => p.test(text)).length;
    if (matches > 0) {
      const confidence = Math.min(0.95, 0.5 + matches * 0.15);
      return {
        intent: rule.intent,
        confidence,
        reason: rule.reason,
      };
    }
  }

  return {
    intent: 'general',
    confidence: 0.4,
    reason: 'No intent-specific signals matched',
  };
}
