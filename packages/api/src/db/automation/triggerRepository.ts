/**
 * Triggers and their runs, on Postgres.
 *
 * `triggers` and `trigger_executions` move together: `executeTrigger` writes
 * both in one flow, and five files address a run by the trigger it belongs to.
 *
 * ## The NESTED shape is the wire contract, so it is reconstructed here
 *
 * `routes/triggers.ts` answers `res.json({ trigger })` with the Mongoose
 * document, so `action.prompt`, `schedule.type`, `webhook.token` and
 * `integrationEvent.service` are what every shipped client reads. The table
 * flattens those into `action_prompt`, `schedule_type`, `webhook_token`,
 * `integration_event_service`, which is the right storage shape and the wrong
 * response shape. `toTriggerRecord` puts them back — the same decision
 * `userMemoryRepository` made for `memory.settings.*`.
 *
 * A group is `undefined` rather than an object of nulls when its discriminating
 * column is absent, because Mongoose left an unset sub-document off the document
 * entirely and `'schedule' in trigger` is a test a client can make.
 *
 * `_id` is served from the Postgres `id`. `PATCH /triggers/:id`,
 * `DELETE /triggers/:id` and `POST /triggers/:id/run` all address a trigger by
 * the id the API handed out, so this is a versioned contract, not a compat
 * shim: it retires when no supported client reads `_id`.
 *
 * ## `$ne` matches NULL, and `<>` does not
 *
 * `executeTrigger`'s claim is `findOneAndUpdate({_id, lastStatus: {$ne:
 * 'running'}}, …)` — a compare-and-set that refuses to start a trigger already
 * running. A fresh trigger has NO `lastStatus`, and Mongo's `$ne` MATCHES a
 * missing field, so the claim succeeds. Translated to `last_status <>
 * 'running'` it would evaluate NULL, the row would not match, and EVERY first
 * run of EVERY trigger would report "already running" and do nothing. The
 * correct spelling is `IS DISTINCT FROM`, and it is pinned by a test that
 * claims a trigger whose `last_status` is NULL.
 */

import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import type { ApiDatabase } from '../index';
import {
  triggerExecutions,
  triggers,
  type TriggerExecutionStatus,
  type TriggerLastStatus,
  type TriggerScheduleType,
  type TriggerTypeValue,
} from '../schema/automation';

type TriggerRow = typeof triggers.$inferSelect;
export type TriggerExecutionRow = typeof triggerExecutions.$inferSelect;

export interface TriggerSchedule {
  type: TriggerScheduleType;
  cron?: string;
  time?: string;
  days?: string[];
  intervalMinutes?: number;
  timezone?: string;
}

export interface TriggerWebhook {
  token: string;
  secret?: string;
  allowedIps?: string[];
}

export interface TriggerIntegrationEvent {
  integrationId?: string;
  service: string;
  event: string;
  filters?: Record<string, unknown>;
}

export interface TriggerAction {
  prompt: string;
  agentId?: string;
  roleId?: string;
  useTools: boolean;
  notify?: boolean;
  channelId?: string;
}

/** A trigger in the shape the API has always served. */
export interface TriggerRecord {
  _id: string;
  oxyUserId: string;
  name: string;
  description?: string;
  type: TriggerTypeValue;
  enabled: boolean;
  action: TriggerAction;
  schedule?: TriggerSchedule;
  webhook?: TriggerWebhook;
  integrationEvent?: TriggerIntegrationEvent;
  lastTriggeredAt?: Date;
  nextTriggerAt?: Date;
  triggerCount: number;
  lastStatus?: TriggerLastStatus;
  lastResult?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Drop keys whose value is null/undefined, so an unset field is ABSENT.
 *
 * The return type removes `null` as well as making every key optional, because
 * a column's `null` IS the absence: `JSON.stringify` emits `"agentId": null`
 * for one and omits the key for the other, and the omitted form is what
 * Mongoose's `lean()` produced.
 */
type Defined<T> = { [K in keyof T]?: Exclude<T[K], null | undefined> };
function defined<T extends Record<string, unknown>>(input: T): Defined<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out as Defined<T>;
}

/** A stored row in the nested shape every client reads. */
export function toTriggerRecord(row: TriggerRow): TriggerRecord {
  return {
    _id: row.id,
    ...defined({
      description: row.description,
      lastTriggeredAt: row.lastTriggeredAt,
      nextTriggerAt: row.nextTriggerAt,
      lastStatus: row.lastStatus as TriggerLastStatus | null,
      lastResult: row.lastResult,
    }),
    oxyUserId: row.oxyUserId,
    name: row.name,
    type: row.type as TriggerTypeValue,
    enabled: row.enabled,
    action: {
      prompt: row.actionPrompt,
      useTools: row.actionUseTools,
      notify: row.actionNotify,
      ...defined({
        agentId: row.actionAgentId,
        roleId: row.actionRoleId,
        channelId: row.actionChannelId,
      }),
    },
    // A group is absent, not an object of nulls: Mongoose left an unset
    // sub-document off the document, and `'schedule' in trigger` is a real test.
    ...(row.scheduleType === null
      ? {}
      : {
          schedule: {
            type: row.scheduleType as TriggerScheduleType,
            ...defined({
              cron: row.scheduleCron,
              time: row.scheduleTime,
              days: row.scheduleDays,
              intervalMinutes: row.scheduleIntervalMinutes,
              timezone: row.scheduleTimezone,
            }),
          },
        }),
    ...(row.webhookToken === null
      ? {}
      : {
          webhook: {
            token: row.webhookToken,
            ...defined({ secret: row.webhookSecret, allowedIps: row.webhookAllowedIps }),
          },
        }),
    ...(row.integrationEventService === null || row.integrationEventEvent === null
      ? {}
      : {
          integrationEvent: {
            service: row.integrationEventService,
            event: row.integrationEventEvent,
            ...defined({
              integrationId: row.integrationEventIntegrationId,
              filters: row.integrationEventFilters as Record<string, unknown> | null,
            }),
          },
        }),
    triggerCount: row.triggerCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface NewTrigger {
  oxyUserId: string;
  name: string;
  description?: string;
  type: TriggerTypeValue;
  enabled?: boolean;
  action: TriggerAction;
  schedule?: TriggerSchedule;
  webhook?: TriggerWebhook;
  integrationEvent?: TriggerIntegrationEvent;
  lastTriggeredAt?: Date;
  triggerCount?: number;
}

/** Flatten the nested groups into their columns, for an INSERT. */
function toColumns(input: NewTrigger) {
  return {
    oxyUserId: input.oxyUserId,
    name: input.name,
    description: input.description,
    type: input.type,
    enabled: input.enabled ?? true,
    actionPrompt: input.action.prompt,
    actionAgentId: input.action.agentId,
    actionRoleId: input.action.roleId,
    actionUseTools: input.action.useTools ?? false,
    actionNotify: input.action.notify ?? false,
    actionChannelId: input.action.channelId,
    scheduleType: input.schedule?.type,
    scheduleCron: input.schedule?.cron,
    scheduleTime: input.schedule?.time,
    scheduleDays: input.schedule?.days,
    scheduleIntervalMinutes: input.schedule?.intervalMinutes,
    scheduleTimezone: input.schedule?.timezone,
    webhookToken: input.webhook?.token,
    webhookSecret: input.webhook?.secret,
    webhookAllowedIps: input.webhook?.allowedIps,
    integrationEventIntegrationId: input.integrationEvent?.integrationId,
    integrationEventService: input.integrationEvent?.service,
    integrationEventEvent: input.integrationEvent?.event,
    integrationEventFilters: input.integrationEvent?.filters,
    lastTriggeredAt: input.lastTriggeredAt,
    triggerCount: input.triggerCount,
  };
}

export async function createTrigger(db: ApiDatabase, input: NewTrigger): Promise<TriggerRecord> {
  const rows = await db.insert(triggers).values(toColumns(input)).returning();
  const row = rows[0];
  if (!row) throw new Error('trigger insert returned no row');
  return toTriggerRecord(row);
}

/**
 * A user's triggers, newest first.
 *
 * `enabledOnly` and `limit` exist because the AI tool in
 * `lib/tools/trigger-management.ts` lists differently from the route: it hides
 * disabled triggers unless asked and caps at 20, while `GET /triggers` returns
 * every one. Two call sites, one query, each predicate optional and OFF by
 * default so neither silently inherits the other's narrowing.
 */
export async function listTriggers(
  db: ApiDatabase,
  oxyUserId: string,
  options: { type?: TriggerTypeValue; enabledOnly?: boolean; limit?: number } = {},
): Promise<TriggerRecord[]> {
  const predicates = [eq(triggers.oxyUserId, oxyUserId)];
  if (options.type !== undefined) predicates.push(eq(triggers.type, options.type));
  if (options.enabledOnly) predicates.push(eq(triggers.enabled, true));

  const query = db
    .select()
    .from(triggers)
    .where(and(...predicates))
    .orderBy(desc(triggers.createdAt));

  const rows = options.limit === undefined ? await query : await query.limit(options.limit);
  return rows.map(toTriggerRecord);
}

/** One trigger by id. */
export async function findTriggerById(
  db: ApiDatabase,
  id: string,
): Promise<TriggerRecord | undefined> {
  const rows = await db.select().from(triggers).where(eq(triggers.id, id)).limit(1);
  return rows[0] && toTriggerRecord(rows[0]);
}

/** One trigger by id, scoped by owner — another account's is a 404, not a read. */
export async function findTriggerForUser(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
): Promise<TriggerRecord | undefined> {
  const rows = await db
    .select()
    .from(triggers)
    .where(and(eq(triggers.id, id), eq(triggers.oxyUserId, oxyUserId)))
    .limit(1);
  return rows[0] && toTriggerRecord(rows[0]);
}

/**
 * What `PATCH /triggers/:id` may change.
 *
 * The source's asymmetry is preserved exactly and is NOT an accident of the
 * port: `action` and `webhook` were merged into the existing sub-document
 * (`trigger.set('action', {...trigger.action, ...action})`), while `schedule`
 * and `integrationEvent` were ASSIGNED, replacing whatever was there. So a
 * patch naming `schedule: {type:'daily'}` must CLEAR `schedule.cron`, and a
 * patch naming `action: {notify:true}` must NOT clear `action.prompt`.
 */
export interface TriggerPatch {
  name?: string;
  description?: string;
  enabled?: boolean;
  action?: Partial<TriggerAction>;
  schedule?: TriggerSchedule | null;
  webhook?: Partial<TriggerWebhook>;
  integrationEvent?: TriggerIntegrationEvent | null;
}

export async function updateTrigger(
  db: ApiDatabase,
  id: string,
  patch: TriggerPatch,
): Promise<TriggerRecord | undefined> {
  const set: Record<string, unknown> = {
    name: patch.name,
    description: patch.description,
    enabled: patch.enabled,
  };

  // MERGE: only the keys the caller named are written.
  if (patch.action) {
    if (patch.action.prompt !== undefined) set.actionPrompt = patch.action.prompt;
    if (patch.action.agentId !== undefined) set.actionAgentId = patch.action.agentId;
    if (patch.action.roleId !== undefined) set.actionRoleId = patch.action.roleId;
    if (patch.action.useTools !== undefined) set.actionUseTools = patch.action.useTools;
    if (patch.action.notify !== undefined) set.actionNotify = patch.action.notify;
    if (patch.action.channelId !== undefined) set.actionChannelId = patch.action.channelId;
  }
  if (patch.webhook) {
    if (patch.webhook.token !== undefined) set.webhookToken = patch.webhook.token;
    if (patch.webhook.secret !== undefined) set.webhookSecret = patch.webhook.secret;
    if (patch.webhook.allowedIps !== undefined) set.webhookAllowedIps = patch.webhook.allowedIps;
  }

  // REPLACE: every column in the group is written, so an omitted key is CLEARED.
  // `null` on the group itself removes it, which is what assigning `undefined`
  // to the sub-document did.
  if (patch.schedule !== undefined) {
    set.scheduleType = patch.schedule?.type ?? null;
    set.scheduleCron = patch.schedule?.cron ?? null;
    set.scheduleTime = patch.schedule?.time ?? null;
    set.scheduleDays = patch.schedule?.days ?? null;
    set.scheduleIntervalMinutes = patch.schedule?.intervalMinutes ?? null;
    set.scheduleTimezone = patch.schedule?.timezone ?? null;
  }
  if (patch.integrationEvent !== undefined) {
    set.integrationEventIntegrationId = patch.integrationEvent?.integrationId ?? null;
    set.integrationEventService = patch.integrationEvent?.service ?? null;
    set.integrationEventEvent = patch.integrationEvent?.event ?? null;
    set.integrationEventFilters = patch.integrationEvent?.filters ?? null;
  }

  const rows = await db.update(triggers).set(set).where(eq(triggers.id, id)).returning();
  return rows[0] && toTriggerRecord(rows[0]);
}

/** Replace a trigger's whole schedule group. Used by the heartbeat sync. */
export async function setTriggerSchedule(
  db: ApiDatabase,
  id: string,
  schedule: TriggerSchedule,
): Promise<void> {
  await updateTrigger(db, id, { schedule });
}

/** Change only the prompt. Used by the daily-briefing refresh. */
export async function setTriggerActionPrompt(
  db: ApiDatabase,
  id: string,
  prompt: string,
): Promise<void> {
  await db.update(triggers).set({ actionPrompt: prompt }).where(eq(triggers.id, id));
}

/**
 * Remove a trigger the caller owns, answering the row that went.
 *
 * The two callers wanted different things — the route used `deleteOne` and read
 * `deletedCount`, the AI tool used `findOneAndDelete` and names the trigger in
 * its confirmation message. Returning the record serves both, and `undefined`
 * is the 404 either way.
 */
export async function deleteTriggerForUser(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
): Promise<TriggerRecord | undefined> {
  const rows = await db
    .delete(triggers)
    .where(and(eq(triggers.id, id), eq(triggers.oxyUserId, oxyUserId)))
    .returning();
  return rows[0] && toTriggerRecord(rows[0]);
}

/**
 * Claim a trigger for a run, refusing one already running.
 *
 * ONE conditional statement, exactly as the source's `findOneAndUpdate` was one
 * round trip — a read-then-write here would reopen the race the guard exists to
 * close. `IS DISTINCT FROM` and not `<>`: see the file comment.
 *
 * Returns `undefined` when the claim was refused.
 */
export async function claimTriggerForRun(
  db: ApiDatabase,
  id: string,
): Promise<TriggerRecord | undefined> {
  const rows = await db
    .update(triggers)
    .set({ lastStatus: 'running' })
    .where(
      and(eq(triggers.id, id), sql`${triggers.lastStatus} is distinct from ${'running'}`),
    )
    .returning();
  return rows[0] && toTriggerRecord(rows[0]);
}

/** Record a completed run against the trigger, and count it. */
export async function recordTriggerSuccess(
  db: ApiDatabase,
  id: string,
  outcome: { lastTriggeredAt: Date; lastResult: string },
): Promise<void> {
  const triggerCount = sql.raw(`"${'triggers'}"."${sqlColumnName(triggers.triggerCount)}"`);
  await db
    .update(triggers)
    .set({
      lastTriggeredAt: outcome.lastTriggeredAt,
      lastStatus: 'success',
      lastResult: outcome.lastResult,
      triggerCount: sql`${triggerCount} + 1`,
    })
    .where(eq(triggers.id, id));
}

/**
 * Record a failed run.
 *
 * Deliberately does NOT increment `trigger_count`: the source's failure path
 * carries no `$inc`, so the counter means "runs that succeeded", not "runs".
 */
export async function recordTriggerFailure(
  db: ApiDatabase,
  id: string,
  outcome: { lastTriggeredAt: Date; lastResult: string },
): Promise<void> {
  await db
    .update(triggers)
    .set({
      lastStatus: 'failed',
      lastResult: outcome.lastResult,
      lastTriggeredAt: outcome.lastTriggeredAt,
    })
    .where(eq(triggers.id, id));
}

const SCHEDULABLE = ['schedule', 'agent_heartbeat'] as const;

/** Every enabled trigger the scheduler owns. */
export async function findSchedulableTriggers(db: ApiDatabase): Promise<TriggerRecord[]> {
  const rows = await db
    .select()
    .from(triggers)
    .where(and(inArray(triggers.type, [...SCHEDULABLE]), eq(triggers.enabled, true)));
  return rows.map(toTriggerRecord);
}

/** Just `(id, updatedAt)` for the reconcile loop's change detection. */
export async function listSchedulableTriggerVersions(
  db: ApiDatabase,
): Promise<{ id: string; updatedAt: Date }[]> {
  return db
    .select({ id: triggers.id, updatedAt: triggers.updatedAt })
    .from(triggers)
    .where(and(inArray(triggers.type, [...SCHEDULABLE]), eq(triggers.enabled, true)));
}

/**
 * The enabled webhook trigger a token addresses.
 *
 * The token is a LOOKUP KEY held in the clear — an encrypted column cannot be
 * matched by equality — so this is an exact-match oracle and the row it returns
 * carries a credential. Never log either.
 */
export async function findTriggerByWebhookToken(
  db: ApiDatabase,
  token: string,
): Promise<TriggerRecord | undefined> {
  const rows = await db
    .select()
    .from(triggers)
    .where(
      and(
        eq(triggers.webhookToken, token),
        eq(triggers.type, 'webhook'),
        eq(triggers.enabled, true),
      ),
    )
    .limit(1);
  return rows[0] && toTriggerRecord(rows[0]);
}

/** A user's enabled triggers listening for one integration event. */
export async function findIntegrationEventTriggers(
  db: ApiDatabase,
  oxyUserId: string,
  service: string,
  event: string,
): Promise<TriggerRecord[]> {
  const rows = await db
    .select()
    .from(triggers)
    .where(
      and(
        eq(triggers.oxyUserId, oxyUserId),
        eq(triggers.type, 'integration_event'),
        eq(triggers.enabled, true),
        eq(triggers.integrationEventService, service),
        eq(triggers.integrationEventEvent, event),
      ),
    );
  return rows.map(toTriggerRecord);
}

/** The enabled heartbeat trigger bound to an agent, if one exists. */
export async function findAgentHeartbeatTrigger(
  db: ApiDatabase,
  agentId: string,
): Promise<TriggerRecord | undefined> {
  const rows = await db
    .select()
    .from(triggers)
    .where(
      and(
        eq(triggers.type, 'agent_heartbeat'),
        eq(triggers.actionAgentId, agentId),
        eq(triggers.enabled, true),
      ),
    )
    .limit(1);
  return rows[0] && toTriggerRecord(rows[0]);
}

/**
 * A user's trigger of one kind bound to an agent, whatever its enabled state.
 *
 * Three callers, two kinds: the archetype sync looks for the `schedule` one and
 * the `webhook` one, and the reports endpoint looks for the `schedule` one.
 * `enabled` is deliberately NOT part of the predicate — the source did not
 * filter on it, and a disabled trigger still has to be FOUND so it is not
 * duplicated by the sync that runs next.
 */
export async function findAgentTriggerByType(
  db: ApiDatabase,
  oxyUserId: string,
  agentId: string,
  type: TriggerTypeValue,
): Promise<TriggerRecord | undefined> {
  const rows = await db
    .select()
    .from(triggers)
    .where(
      and(
        eq(triggers.oxyUserId, oxyUserId),
        eq(triggers.type, type),
        eq(triggers.actionAgentId, agentId),
      ),
    )
    .limit(1);
  return rows[0] && toTriggerRecord(rows[0]);
}

/**
 * A user's daily-briefing trigger.
 *
 * The source matched `name: { $regex: /daily briefing|morning briefing/i }`.
 * Ported as a case-insensitive `LIKE` on either phrase rather than a regex
 * operator: it is the same predicate for these two literals, uses no
 * Postgres-specific regex syntax, and cannot be handed a pattern by a caller.
 */
export async function findBriefingTrigger(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<TriggerRecord | undefined> {
  const rows = await db
    .select()
    .from(triggers)
    .where(
      and(
        eq(triggers.oxyUserId, oxyUserId),
        eq(triggers.type, 'schedule'),
        or(
          sql`${triggers.name} ilike ${'%daily briefing%'}`,
          sql`${triggers.name} ilike ${'%morning briefing%'}`,
        ),
      ),
    )
    .limit(1);
  return rows[0] && toTriggerRecord(rows[0]);
}

/** Whether a user already has this exact schedule trigger. Legacy-migration shape. */
export async function triggerExistsByNameAndPrompt(
  db: ApiDatabase,
  oxyUserId: string,
  name: string,
  prompt: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: triggers.id })
    .from(triggers)
    .where(
      and(
        eq(triggers.oxyUserId, oxyUserId),
        eq(triggers.name, name),
        eq(triggers.type, 'schedule'),
        eq(triggers.actionPrompt, prompt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ── Runs ───────────────────────────────────────────────────────────

export interface NewTriggerExecution {
  triggerId: string;
  oxyUserId: string;
  triggerType: string;
  input?: { event?: string; payload?: Record<string, unknown>; source?: string };
  startedAt: Date;
}

/** Open a run. `status` takes its column default of 'running'. */
export async function createTriggerExecution(
  db: ApiDatabase,
  input: NewTriggerExecution,
): Promise<TriggerExecutionRow> {
  const rows = await db
    .insert(triggerExecutions)
    .values({
      triggerId: input.triggerId,
      oxyUserId: input.oxyUserId,
      status: 'running',
      triggerType: input.triggerType,
      inputEvent: input.input?.event,
      inputPayload: input.input?.payload,
      inputSource: input.input?.source,
      startedAt: input.startedAt,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('trigger execution insert returned no row');
  return row;
}

/** Close a run. The three `save()` sites in `executeTrigger` all land here. */
export async function completeTriggerExecution(
  db: ApiDatabase,
  id: string,
  outcome: {
    status: TriggerExecutionStatus;
    result?: string;
    toolCalls?: unknown;
    tokens?: { prompt: number; completion: number; total: number };
    durationMs: number;
    completedAt: Date;
  },
): Promise<void> {
  await db
    .update(triggerExecutions)
    .set({
      status: outcome.status,
      result: outcome.result,
      toolCalls: outcome.toolCalls,
      tokensPrompt: outcome.tokens?.prompt,
      tokensCompletion: outcome.tokens?.completion,
      tokensTotal: outcome.tokens?.total,
      durationMs: outcome.durationMs,
      completedAt: outcome.completedAt,
    })
    .where(eq(triggerExecutions.id, id));
}

/**
 * The most recent SUCCESSFUL run of a trigger, for report comparison.
 *
 * Ordered by `completed_at` descending as the source was, with `NULLS LAST` so
 * a successful row that somehow never recorded a completion cannot sort to the
 * head and be read as the latest report.
 */
export async function findLastSuccessfulExecution(
  db: ApiDatabase,
  triggerId: string,
): Promise<{ result: string | null; completedAt: Date | null } | undefined> {
  const rows = await db
    .select({
      result: triggerExecutions.result,
      completedAt: triggerExecutions.completedAt,
    })
    .from(triggerExecutions)
    .where(and(eq(triggerExecutions.triggerId, triggerId), eq(triggerExecutions.status, 'success')))
    .orderBy(sql`${triggerExecutions.completedAt} desc nulls last`)
    .limit(1);
  return rows[0];
}

/** A trigger's run history, newest first. */
export async function listTriggerExecutions(
  db: ApiDatabase,
  triggerId: string,
  page: { limit: number; offset: number },
): Promise<TriggerExecutionRow[]> {
  return db
    .select()
    .from(triggerExecutions)
    .where(eq(triggerExecutions.triggerId, triggerId))
    .orderBy(desc(triggerExecutions.startedAt))
    .limit(page.limit)
    .offset(page.offset);
}

/** How many runs a trigger has recorded. */
export async function countTriggerExecutions(
  db: ApiDatabase,
  triggerId: string,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(triggerExecutions)
    .where(eq(triggerExecutions.triggerId, triggerId));
  return rows[0]?.total ?? 0;
}
