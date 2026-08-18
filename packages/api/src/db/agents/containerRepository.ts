/**
 * The Docker sandboxes an agent runs in, and the snapshots taken of them.
 *
 * Two tables, `containers` and `container_templates`, written by four files:
 * `lib/agent/terminal-session.ts` and `lib/agent/tools.ts` create and drive
 * them, `routes/containers.ts` is the owner-facing view, and
 * `routes/agents/files.ts` resolves a session's container to browse its
 * workspace.
 *
 * ## Every mutation is scoped to the OWNER, and that is a tightening
 *
 * A container is an execution surface: whoever names one can run a shell in it.
 * The Mongoose call sites updated by `containerId` alone and relied on an
 * earlier check — `session.resources` in `tools.ts`, ownership of the terminal
 * in `terminal-session.ts` — so an id that escaped one of those would have
 * matched any row in the collection.
 *
 * Every writer already holds the owner id (`session.userId`, `this.userId`) and
 * writes the SAME value into the row it creates, so carrying it into the WHERE
 * costs a caller nothing and cannot narrow a legitimate write. It is the
 * "port a permission gate as a BOOLEAN" rule applied to an UPDATE: a statement
 * that cannot address another account's row does not need a caller to remember
 * to check.
 *
 * ## `expires_at` is NOT here, and it was never stored
 *
 * `lib/agent/terminal-session.ts` set `expiresAt` alongside `status: 'idle'`.
 * `ContainerSchema` declared no such path, so Mongoose's `strict` dropped it on
 * every write and no document has ever carried one — the `Skill.coverImage`
 * measurement, one domain over. Nothing reads it either: `db/expiryTargets.ts`
 * has no entry for this table and no sweeper queries it. The field is gone from
 * the call site rather than given a column, because a column would turn a value
 * that was silently discarded for the life of the feature into a retention
 * deadline nothing implements.
 *
 * ## `last_activity_at` has no column DEFAULT, and `createContainer` supplies it
 *
 * Mongoose declared `default: Date.now` and the column is a plain nullable
 * `timestamptz`, so a row inserted without the field would read back NULL where
 * every existing document carries a timestamp. Set explicitly on insert rather
 * than migrated into a `defaultNow()`, because this repository is the only
 * writer of the table and a default that only ONE statement could ever exercise
 * is a constraint nothing tests. `containerRepository.pgdb.test.ts` asserts the
 * inserted row is non-null, which is the assertion a `defaultNow()` would have
 * earned anyway.
 */

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ContainerSize, ContainerStatus } from '../../domain/container.js';
import type { ApiDatabase } from '../index';
import { containers } from '../schema/containers';
import { containerTemplates } from '../schema/agent-sessions';

/** A container row, as this repository reads it. */
export interface ContainerRow {
  readonly id: string;
  readonly containerId: string;
  readonly name: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly oxyUserId: string;
  readonly image: string;
  readonly size: string;
  readonly status: string;
  readonly persistent: boolean;
  readonly previewUrl: string | null;
  readonly exposedPorts: number[];
  readonly lastActivityAt: Date | null;
  readonly destroyedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * What `routes/containers.ts` puts on the wire.
 *
 * `_id` is served from the Postgres `id` rather than dropped. These are
 * admin/debug endpoints with no client in this monorepo — but `GET
 * /containers/templates/list` and `DELETE /containers/templates/:id` are a PAIR:
 * the id in the delete path is the one the list handed out. Renaming the field
 * in the list would break the delete against any caller that already exists,
 * and a debug endpoint is exactly where such a caller is a script nobody
 * grepped for.
 */
export interface ContainerResponse extends Omit<ContainerRow, 'id'> {
  readonly _id: string;
}

function toContainerResponse(row: ContainerRow): ContainerResponse {
  const { id, ...rest } = row;
  return { _id: id, ...rest };
}

/**
 * This owner's containers that have not been destroyed, newest first.
 *
 * `ne(status, 'destroyed')` rather than a list of the four live statuses: the
 * source's `{ $ne: 'destroyed' }` admits any status the enum grows later, and
 * an allow-list here would silently start hiding rows the day one is added.
 */
export async function listOwnedContainers(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<ContainerResponse[]> {
  const rows = await db
    .select()
    .from(containers)
    .where(and(eq(containers.oxyUserId, oxyUserId), ne(containers.status, 'destroyed')))
    .orderBy(desc(containers.createdAt));
  return rows.map(toContainerResponse);
}

/**
 * One container by its Docker id, scoped to its owner.
 *
 * The owner is part of the WHERE rather than checked afterwards, so another
 * account's container is indistinguishable from a missing one and the route
 * answers 404 to both.
 *
 * `container_id` carries no unique constraint — Mongoose declared only
 * `index: true` and two creation paths write it — so this deliberately reads
 * the NEWEST match rather than asserting there is one. The source's `findOne`
 * returned an arbitrary row of a duplicate pair; taking the newest is the same
 * answer whenever there is no duplicate and a defensible one when there is.
 */
export async function findOwnedContainer(
  db: ApiDatabase,
  containerId: string,
  oxyUserId: string,
): Promise<ContainerResponse | undefined> {
  const [row] = await db
    .select()
    .from(containers)
    .where(and(eq(containers.containerId, containerId), eq(containers.oxyUserId, oxyUserId)))
    .orderBy(desc(containers.createdAt))
    .limit(1);
  return row === undefined ? undefined : toContainerResponse(row);
}

/**
 * The newest running or idle container of one session, for that session's owner.
 *
 * Both ids are in the WHERE. `routes/agents/files.ts` has already established
 * that the caller owns the session; this makes reading the container's
 * workspace impossible for anyone else even if that check ever moves.
 */
export async function findSessionContainerId(
  db: ApiDatabase,
  sessionId: string,
  oxyUserId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ containerId: containers.containerId })
    .from(containers)
    .where(
      and(
        eq(containers.sessionId, sessionId),
        eq(containers.oxyUserId, oxyUserId),
        inArray(containers.status, ['running', 'idle']),
      ),
    )
    .orderBy(desc(containers.createdAt))
    .limit(1);
  return row?.containerId ?? null;
}

/** True when this owner has a running or idle container with this Docker id. */
export async function ownedContainerIsAttachable(
  db: ApiDatabase,
  containerId: string,
  oxyUserId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(containers)
    .where(
      and(
        eq(containers.containerId, containerId),
        eq(containers.oxyUserId, oxyUserId),
        inArray(containers.status, ['running', 'idle']),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export interface NewContainer {
  readonly containerId: string;
  readonly name: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly oxyUserId: string;
  readonly image: string;
  readonly size: ContainerSize;
  readonly status: ContainerStatus;
  readonly persistent: boolean;
}

/** Record a container that has just been started. */
export async function createContainer(db: ApiDatabase, input: NewContainer): Promise<void> {
  await db.insert(containers).values({
    containerId: input.containerId,
    name: input.name,
    sessionId: input.sessionId,
    agentId: input.agentId,
    oxyUserId: input.oxyUserId,
    image: input.image,
    size: input.size,
    status: input.status,
    persistent: input.persistent,
    lastActivityAt: new Date(),
  });
}

/**
 * Bump `last_activity_at` after a command ran in this owner's container.
 *
 * Reports nothing. The source called this without awaiting on the hot path
 * (`terminal-session.ts` attached a `.catch()`), and a shell command must not
 * fail because a bookkeeping column did not move.
 */
export async function touchContainer(
  db: ApiDatabase,
  containerId: string,
  oxyUserId: string,
): Promise<void> {
  await db
    .update(containers)
    .set({ lastActivityAt: new Date() })
    .where(and(eq(containers.containerId, containerId), eq(containers.oxyUserId, oxyUserId)));
}

/**
 * Publish a preview URL and record the port, without duplicating it.
 *
 * This is `$addToSet`, and `array_append` alone is NOT it: exposing the same
 * port twice — a retry, a reconnect, an agent repeating itself — would leave
 * `{3000,3000}` where Mongo left `{3000}`. Nothing crashes on the duplicate,
 * which is precisely why it would survive; the CASE is what keeps the column
 * meaning "the set of exposed ports".
 *
 * One statement rather than read-modify-write, so two concurrent exposures
 * cannot each append to the array they read before the other's write.
 */
export async function exposeContainerPort(
  db: ApiDatabase,
  containerId: string,
  oxyUserId: string,
  previewUrl: string,
  port: number,
): Promise<void> {
  await db
    .update(containers)
    .set({
      previewUrl,
      exposedPorts: sql`case
        when ${port}::integer = any(${containers.exposedPorts}) then ${containers.exposedPorts}
        else array_append(${containers.exposedPorts}, ${port}::integer)
      end`,
      lastActivityAt: new Date(),
    })
    .where(and(eq(containers.containerId, containerId), eq(containers.oxyUserId, oxyUserId)));
}

/**
 * Park a container instead of destroying it, so its owner can come back to it.
 *
 * `persistent` is set alongside `status` because the source set both: an idled
 * container outlives the session that made it.
 */
export async function idleContainer(
  db: ApiDatabase,
  containerId: string,
  oxyUserId: string,
): Promise<void> {
  await db
    .update(containers)
    .set({ status: 'idle', persistent: true })
    .where(and(eq(containers.containerId, containerId), eq(containers.oxyUserId, oxyUserId)));
}

/** Reattach: the row goes back to `running` and the clock restarts. */
export async function resumeContainer(
  db: ApiDatabase,
  containerId: string,
  oxyUserId: string,
): Promise<void> {
  await db
    .update(containers)
    .set({ status: 'running', lastActivityAt: new Date() })
    .where(and(eq(containers.containerId, containerId), eq(containers.oxyUserId, oxyUserId)));
}

/**
 * Record that a container is gone, returning rows changed.
 *
 * `count`, never `rows.length` — for an UPDATE without `returning()` the row set
 * is empty either way, so the wrong reading is an always-zero answer that looks
 * like a permission failure. `routes/containers.ts` reads it to decide whether
 * it destroyed anything.
 */
export async function markContainerDestroyed(
  db: ApiDatabase,
  containerId: string,
  oxyUserId: string,
): Promise<number> {
  const result = await db
    .update(containers)
    .set({ status: 'destroyed', destroyedAt: new Date() })
    .where(and(eq(containers.containerId, containerId), eq(containers.oxyUserId, oxyUserId)));
  return result.count;
}

/* ------------------------------ templates ------------------------------ */

export interface ContainerTemplateRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly baseImage: string;
  readonly snapshotTag: string;
  readonly oxyUserId: string;
  readonly agentId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ContainerTemplateResponse extends Omit<ContainerTemplateRow, 'id'> {
  readonly _id: string;
}

/** This owner's snapshots, newest first. */
export async function listOwnedContainerTemplates(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<ContainerTemplateResponse[]> {
  const rows = await db
    .select()
    .from(containerTemplates)
    .where(eq(containerTemplates.oxyUserId, oxyUserId))
    .orderBy(desc(containerTemplates.createdAt));
  return rows.map(({ id, ...rest }) => ({ _id: id, ...rest }));
}

/**
 * `agent_id` carries a FOREIGN KEY to `agents.id`, and that is a live coupling
 * rather than a formality.
 *
 * `lib/agent/tools.ts`'s `snapshot_create` writes `session.agentId`, so a
 * snapshot cannot be recorded until that agent exists as a Postgres row — which
 * it does not while `models/agent.ts` is still Mongoose. The whole agent-session
 * flow is unreachable in that state, so nothing regresses today; it is stated
 * because a foreign key failing on a WRITE nobody can currently reach is exactly
 * the fault that presents as normal operation the day somebody can.
 *
 * `agentId` is required here even though the column is nullable, because the one
 * caller always has one. The nullability exists for `ON DELETE SET NULL`: the
 * association is a convenience and the snapshot tag stands on its own.
 */
export interface NewContainerTemplate {
  readonly name: string;
  readonly description?: string;
  readonly baseImage: string;
  readonly snapshotTag: string;
  readonly oxyUserId: string;
  readonly agentId: string;
}

/**
 * Save a snapshot, returning the new row's id.
 *
 * `description` is spread in only when defined. `$set: { x: undefined }` is a
 * no-op in Mongo and the same key in an INSERT writes NULL — here both end at
 * NULL because the column is nullable and the row is new, but the shape is the
 * one every write in this package uses so that a later change to a NOT NULL
 * column does not have to rediscover it.
 */
export async function createContainerTemplate(
  db: ApiDatabase,
  input: NewContainerTemplate,
): Promise<string> {
  const [row] = await db
    .insert(containerTemplates)
    .values({
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      baseImage: input.baseImage,
      snapshotTag: input.snapshotTag,
      oxyUserId: input.oxyUserId,
      agentId: input.agentId,
    })
    .returning({ id: containerTemplates.id });
  if (!row) throw new Error('container template insert returned no row');
  return row.id;
}

/** Remove one snapshot, scoped to its owner. Reports rows removed off `count`. */
export async function deleteOwnedContainerTemplate(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
): Promise<number> {
  const result = await db
    .delete(containerTemplates)
    .where(and(eq(containerTemplates.id, id), eq(containerTemplates.oxyUserId, oxyUserId)));
  return result.count;
}
