/**
 * Alia and the agents writing first about an email (`lib/proactive/email-outreach.ts`).
 *
 * Two tables, both small and both owned by that one module:
 *
 * - `email_alert_preferences` — the person's "tell me about important emails"
 *   switch, per actor. `agent_id` NULL is Alia (the person's own Inbox); an
 *   agent id is that agent's OWN mailbox (ADR 0015), the switch belonging to the
 *   agent's owner. No row means the default, which is ON for both: the owner's
 *   decision is that a friend tells you, not that you have to ask it to.
 *   `NULLS NOT DISTINCT` makes the Alia row unique per person like any other.
 * - `email_outreach_decisions` — one row per (mailbox, message) that was
 *   considered, claimed BEFORE the classifier runs. It is the idempotency key:
 *   Oxy delivers an event at least once, and a second delivery of the same
 *   email must never notify twice. It stores the verdict and its category, never
 *   the email itself — not the subject, not the snippet. Swept after 90 days
 *   (`db/expiryTargets.ts`): a redelivery that late is not a thing Oxy does.
 */

import {
  boolean,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import { agents } from './agents';
import { checkOneOf } from './columns';

export const emailAlertPreferences = pgTable(
  'email_alert_preferences',
  {
    oxyUserId: text().notNull(),
    /** NULL is Alia, about the person's own Inbox; otherwise the agent's own mailbox. */
    agentId: text(),
    enabled: boolean().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'email_alert_preferences_agent_id_fk',
      columns: [t.agentId],
      foreignColumns: [agents.id],
    }).onDelete('cascade'),
    unique('email_alert_preferences_user_agent_key').on(t.oxyUserId, t.agentId).nullsNotDistinct(),
  ],
);

/**
 * What became of one email.
 *
 * `pending` is the claim, written before the classifier; every other value is
 * final. `skipped` is a decision not to look (switched off, budget spent);
 * `failed` is a classifier or delivery error — never retried, because a second
 * look could only produce a late notification.
 */
export const EMAIL_OUTREACH_VERDICTS = [
  'pending',
  'important',
  'not_important',
  'skipped',
  'failed',
] as const;
export type EmailOutreachVerdict = (typeof EMAIL_OUTREACH_VERDICTS)[number];

export const emailOutreachDecisions = pgTable(
  'email_outreach_decisions',
  {
    id: generatedId(),
    /** Whose mailbox the email arrived in: the person, or the agent's bot account. */
    mailboxAccountId: text().notNull(),
    /** Oxy's id of the stored email. */
    messageId: text().notNull(),
    /** Who would be told. */
    oxyUserId: text().notNull(),
    /** NULL for Alia; the agent whose own mailbox it is otherwise. */
    agentId: text(),
    verdict: text({ enum: EMAIL_OUTREACH_VERDICTS as unknown as [string, ...string[]] })
      .$type<EmailOutreachVerdict>()
      .notNull(),
    /** The classifier's category, or why it was skipped. Closed vocabulary, never email text. */
    reason: text(),
    /** The chat message that told the person, when one did. */
    postedMessageId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'email_outreach_decisions_agent_id_fk',
      columns: [t.agentId],
      foreignColumns: [agents.id],
    }).onDelete('cascade'),
    uniqueIndex('email_outreach_decisions_mailbox_message_key').on(t.mailboxAccountId, t.messageId),
    index('email_outreach_decisions_created_idx').on(t.createdAt),
    checkOneOf('email_outreach_decisions_verdict_check', t.verdict, EMAIL_OUTREACH_VERDICTS),
  ],
);
