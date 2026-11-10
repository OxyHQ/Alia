import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { ApiDatabase } from '../index.js';
import { externalAgentLinks, externalAgentPairings } from '../schema/external-agents.js';
import type { ExternalAgentCli } from '../../domain/external-agent.js';

export async function createPairing(
  db: ApiDatabase,
  input: { id: string; codeHash: string; ownerOxyUserId: string; expiresAt: Date },
): Promise<void> {
  await db.insert(externalAgentPairings).values(input);
}

/**
 * Consumes a code in ONE conditional UPDATE, so two daemons racing for the same code cannot both
 * win. The owner is part of the condition: a code redeemed by another account is simply "not
 * found" and stays redeemable by its owner.
 */
export async function redeemPairing(
  db: ApiDatabase,
  input: { codeHash: string; ownerOxyUserId: string; now: Date },
): Promise<{ id: string } | null> {
  const [row] = await db
    .update(externalAgentPairings)
    .set({ redeemedAt: input.now })
    .where(
      and(
        eq(externalAgentPairings.codeHash, input.codeHash),
        eq(externalAgentPairings.ownerOxyUserId, input.ownerOxyUserId),
        isNull(externalAgentPairings.redeemedAt),
        gt(externalAgentPairings.expiresAt, input.now),
      ),
    )
    .returning({ id: externalAgentPairings.id });
  return row ?? null;
}

export async function createExternalLink(
  db: ApiDatabase,
  input: { agentId: string; ownerOxyUserId: string; cli: ExternalAgentCli; hostName: string },
) {
  const [row] = await db.insert(externalAgentLinks).values(input).returning();
  return row;
}

/** The live link of an agent, or `undefined` when it is an ordinary agent or was revoked. */
export async function findExternalLink(db: ApiDatabase, agentId: string) {
  const [row] = await db
    .select()
    .from(externalAgentLinks)
    .where(and(eq(externalAgentLinks.agentId, agentId), isNull(externalAgentLinks.revokedAt)))
    .limit(1);
  return row;
}

export async function listExternalLinks(db: ApiDatabase, ownerOxyUserId: string) {
  return db
    .select()
    .from(externalAgentLinks)
    .where(
      and(
        eq(externalAgentLinks.ownerOxyUserId, ownerOxyUserId),
        isNull(externalAgentLinks.revokedAt),
      ),
    )
    .orderBy(desc(externalAgentLinks.createdAt));
}

export async function markExternalLinkConnected(db: ApiDatabase, agentId: string): Promise<void> {
  await db
    .update(externalAgentLinks)
    .set({ lastConnectedAt: new Date() })
    .where(eq(externalAgentLinks.agentId, agentId));
}

/** Returns true when a live link of this owner was revoked. */
export async function revokeExternalLink(
  db: ApiDatabase,
  ownerOxyUserId: string,
  agentId: string,
): Promise<boolean> {
  const rows = await db
    .update(externalAgentLinks)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(externalAgentLinks.agentId, agentId),
        eq(externalAgentLinks.ownerOxyUserId, ownerOxyUserId),
        isNull(externalAgentLinks.revokedAt),
      ),
    )
    .returning({ agentId: externalAgentLinks.agentId });
  return rows.length > 0;
}
