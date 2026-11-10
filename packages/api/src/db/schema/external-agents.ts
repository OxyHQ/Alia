/**
 * External agents (ADR 0028): agents whose turns run on a person's own machine, in a coding-agent CLI
 * they are already logged in to, reached through a daemon (`codea connect`) that dials Alia.
 *
 * Two small tables and nothing on `agents`: an external agent is an ordinary agent row plus a link
 * row, so the hot `agents` table gains no column, no CHECK and no migration lock.
 */
import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz } from '@oxy.so/db';
import { checkOneOf } from './columns';
import { EXTERNAL_AGENT_CLIS } from '../../domain/external-agent';

/**
 * A single-use pairing code, minted in the app and redeemed by the daemon.
 *
 * Only the SHA-256 of the code is stored: the code is the credential until it is redeemed, so a
 * database read must not yield one. `expires_at` is the sweep clock (`db/expiryTargets.ts`); a
 * redeemed row is kept until then so a replay answers "already used" rather than "unknown".
 */
export const externalAgentPairings = pgTable(
  'external_agent_pairings',
  {
    id: text().primaryKey(),
    codeHash: text().notNull(),
    ownerOxyUserId: text().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamptz().notNull(),
    redeemedAt: timestamptz(),
  },
  (t) => [
    uniqueIndex('external_agent_pairings_code_hash_key').on(t.codeHash),
    index('external_agent_pairings_expiry_idx').on(t.expiresAt),
    index('external_agent_pairings_owner_idx').on(t.ownerOxyUserId),
  ],
);

/**
 * The link between an agent and the machine that serves it.
 *
 * `agent_id` is the `agents._id` of the ordinary agent row; it is the key, so one agent has at most
 * one link. No foreign key: agent rows are created and deleted by flows that must not be blocked by
 * a daemon (`CONVENTIONS.md`, "foreign keys are declared per reference"), and a link whose agent is
 * gone is inert — `findExternalLink` is only reached from an agent that exists.
 */
export const externalAgentLinks = pgTable(
  'external_agent_links',
  {
    agentId: text().primaryKey(),
    ownerOxyUserId: text().notNull(),
    cli: text({ enum: EXTERNAL_AGENT_CLIS as unknown as [string, ...string[]] }).notNull(),
    hostName: text().notNull(),
    createdAt: createdAt(),
    lastConnectedAt: timestamptz(),
    revokedAt: timestamptz(),
  },
  (t) => [
    index('external_agent_links_owner_idx').on(t.ownerOxyUserId),
    checkOneOf('external_agent_links_cli_check', t.cli, EXTERNAL_AGENT_CLIS),
  ],
);
