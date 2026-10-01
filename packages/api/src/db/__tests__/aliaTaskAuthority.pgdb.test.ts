import { uuidv7 } from '@oxy.so/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listActiveAliaTaskAuthorizations,
  listActiveTaskAuthorityIds,
  listAliaTaskAuthorizationsForRun,
  markTaskAuthorityRevoked,
  replaceAliaTaskAuthorizations,
} from '../automation/aliaTaskAuthorityRepository';
import {
  claimAutomationRunPlan,
  createAutomationDefinition,
  failAbandonedAliaRun,
  findAutomationDefinitionById,
  findAutomationRunById,
  listAbandonedAliaRuns,
  listAutomationRunSteps,
  markAliaAutomationRun,
  updateAutomationDefinition,
  upsertAutomationActionAuthorizations,
} from '../automation/automationDefinitionRepository';
import {
  findAutomationWatchState,
  pauseFailingAutomationWatch,
  recordAutomationWatchFailure,
  recordAutomationWatchObservation,
} from '../automation/automationWatchRepository';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => closePostgres());

const OWNER = 'alia-auth-owner';
const root = { appId: 'inbox', effectiveAccountId: OWNER, resourceType: 'email_account', resourceId: OWNER };
const mailbox = { appId: 'inbox', effectiveAccountId: OWNER, resourceType: 'mailbox', resourceId: 'box-1' };
const HOLD = { userId: OWNER, creditsReserved: 12, initialFreeCredits: 40, initialPaidCredits: 3, grantKind: 'free_allowance' as const };

async function aliaTask(input: { actions?: boolean; inputs?: Record<string, unknown> } = {}) {
  const id = uuidv7();
  const actionId = uuidv7();
  const automation = await createAutomationDefinition(db, {
    id,
    ownerAccountId: OWNER,
    objective: 'Summarise my email and reply to the urgent one',
    triggerKind: 'schedule',
    scheduleCron: '0 8 * * *',
    scheduleTimezone: 'Europe/Madrid',
    actorMode: 'alia',
    eligibleAgentIds: [],
    executionMode: 'execute',
    actions: input.actions
      ? [{ id: actionId, resource: mailbox, tool: 'replyToEmail', input: {}, limits: [] }]
      : [],
    inputs: input.inputs ?? {},
    resources: input.actions ? [mailbox] : [],
    dataFlow: { sources: [], destinations: [] },
    maximumAutonomy: 'autonomous',
    limits: [],
    enabled: true,
  });
  return { automation, actionId };
}

const later = () => new Date(Date.now() + 60 * 60_000);

describe('migration 0081', () => {
  it('creates the Alia authority and watch tables and the run columns', async () => {
    const tables = await db.execute(sql`
      select table_name from information_schema.tables
      where table_name in ('alia_task_authorizations', 'automation_watch_states') order by table_name`);
    expect((tables as unknown as Array<{ table_name: string }>).map((row) => row.table_name))
      .toEqual(['alia_task_authorizations', 'automation_watch_states']);
    const columns = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'automation_runs' and column_name in ('credit_reservation', 'lease_expires_at')
      order by column_name`);
    expect((columns as unknown as Array<{ column_name: string }>).map((row) => row.column_name))
      .toEqual(['credit_reservation', 'lease_expires_at']);
  });
});

describe('Alia standing authority', () => {
  it('replaces the set, lists it with the agent path\'s ids and marks both revoked', async () => {
    const { automation, actionId } = await aliaTask({ actions: true });
    await replaceAliaTaskAuthorizations(db, automation.id, [
      { automationActionId: null, resource: root, tool: 'listEmails', oxyAuthorizationId: `read-${automation.id}`, expiresAt: later() },
      { automationActionId: actionId, resource: mailbox, tool: 'replyToEmail', oxyAuthorizationId: `act-${automation.id}`, expiresAt: later() },
      // Already expired: never listed.
      { automationActionId: null, resource: root, tool: 'getEmail', oxyAuthorizationId: `old-${automation.id}`, expiresAt: new Date(Date.now() - 1_000) },
    ]);
    // A legacy agent row on the same task is revoked through the same path.
    await upsertAutomationActionAuthorizations(db, [{
      automationActionId: actionId,
      agentId: 'agent-legacy',
      actorAccountId: 'bot-legacy',
      oxyAuthorizationId: `agent-${automation.id}`,
      expiresAt: later(),
    }]);

    expect((await listActiveAliaTaskAuthorizations(db, automation.id)).map((row) => row.tool).sort())
      .toEqual(['listEmails', 'replyToEmail']);
    expect((await listActiveTaskAuthorityIds(db, automation.id)).sort())
      .toEqual([`act-${automation.id}`, `agent-${automation.id}`, `read-${automation.id}`].sort());

    await markTaskAuthorityRevoked(db, [`read-${automation.id}`, `agent-${automation.id}`]);
    expect(await listActiveTaskAuthorityIds(db, automation.id)).toEqual([`act-${automation.id}`]);

    // A fresh set reinstates a revoked exact tool with its new id.
    await replaceAliaTaskAuthorizations(db, automation.id, [
      { automationActionId: null, resource: root, tool: 'listEmails', oxyAuthorizationId: `read2-${automation.id}`, expiresAt: later() },
    ]);
    expect(await listActiveTaskAuthorityIds(db, automation.id)).toEqual([`read2-${automation.id}`]);
  });

  it('gives a run every standing read and only the declared actions it has a step for', async () => {
    const { automation, actionId } = await aliaTask({ actions: true });
    await replaceAliaTaskAuthorizations(db, automation.id, [
      { automationActionId: null, resource: root, tool: 'listEmails', oxyAuthorizationId: `r-${automation.id}`, expiresAt: later() },
      { automationActionId: actionId, resource: mailbox, tool: 'replyToEmail', oxyAuthorizationId: `a-${automation.id}`, expiresAt: later() },
    ]);
    const runId = uuidv7();
    await claimAutomationRunPlan({
      db,
      runId,
      automationId: automation.id,
      requesterAccountId: OWNER,
      triggerEventId: `schedule:${automation.id}:1`,
      actorType: 'alia',
      stages: [{
        stage: 0,
        selectedAgentId: null,
        selectedActorAccountId: OWNER,
        resource: mailbox,
        taskInput: {},
        actions: automation.actions,
      }],
    });
    const steps = await listAutomationRunSteps(db, runId);
    const actionStep = steps.find((step) => step.tool === 'replyToEmail');
    expect(actionStep?.actorType).toBe('alia');

    const forRun = await listAliaTaskAuthorizationsForRun(db, automation.id, runId);
    expect(forRun).toEqual(expect.arrayContaining([
      { resource: root, tool: 'listEmails', oxyAuthorizationId: `r-${automation.id}`, repeatable: true },
      { resource: mailbox, tool: 'replyToEmail', oxyAuthorizationId: `a-${automation.id}`, stepId: actionStep?.id, repeatable: false },
    ]));
    expect(await listAliaTaskAuthorizationsForRun(db, automation.id, uuidv7()))
      .toEqual([expect.objectContaining({ tool: 'listEmails' })]);
  });

  it('is replaced with the definition on edit, and cascades with the task', async () => {
    const { automation } = await aliaTask();
    await replaceAliaTaskAuthorizations(db, automation.id, [
      { automationActionId: null, resource: root, tool: 'listEmails', oxyAuthorizationId: `e1-${automation.id}`, expiresAt: later() },
    ]);
    const updated = await updateAutomationDefinition(db, {
      id: automation.id,
      ownerAccountId: OWNER,
      expectedUpdatedAt: automation.updatedAt,
      objective: automation.objective,
      triggerKind: 'schedule',
      scheduleCron: '0 9 * * *',
      scheduleTimezone: 'Europe/Madrid',
      actorMode: 'alia',
      eligibleAgentIds: [],
      inputs: {},
      resources: [],
      dataFlow: { sources: [], destinations: [] },
      maximumAutonomy: 'autonomous',
      limits: [],
      enabled: true,
      authorizations: [],
      aliaAuthorizations: [
        { automationActionId: null, resource: root, tool: 'getEmail', oxyAuthorizationId: `e2-${automation.id}`, expiresAt: later() },
      ],
    });
    expect(updated).not.toBeNull();
    expect(await listActiveTaskAuthorityIds(db, automation.id)).toEqual([`e2-${automation.id}`]);

    await db.execute(sql`delete from automation_definitions where id = ${automation.id}`);
    const left = await db.execute(sql`select count(*)::int as n from alia_task_authorizations where automation_id = ${automation.id}`);
    expect((left as unknown as Array<{ n: number }>)[0]?.n).toBe(0);
  });
});

describe('Alia run lease, hold and reaper', () => {
  async function claim(automationId: string) {
    const runId = uuidv7();
    await claimAutomationRunPlan({
      db,
      runId,
      automationId,
      requesterAccountId: OWNER,
      triggerEventId: `schedule:${automationId}:${runId}`,
      actorType: 'alia',
      creditReservation: HOLD,
      stages: [{
        stage: 0, selectedAgentId: null, selectedActorAccountId: OWNER, resource: root, taskInput: {}, actions: [],
      }],
    });
    return runId;
  }

  it('keeps the hold durable and transitions only an open run', async () => {
    const { automation } = await aliaTask();
    const runId = await claim(automation.id);
    expect((await findAutomationRunById(db, runId))?.creditReservation).toEqual(HOLD);

    expect(await markAliaAutomationRun(db, runId, 'running', { leaseMs: 60_000 })).toBe(true);
    const running = await findAutomationRunById(db, runId);
    expect(running?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(await markAliaAutomationRun(db, runId, 'succeeded')).toBe(true);
    expect((await findAutomationRunById(db, runId))?.leaseExpiresAt).toBeNull();
    // Settled: neither a retry nor the reaper reopens or re-closes it.
    expect(await markAliaAutomationRun(db, runId, 'failed')).toBe(false);
    expect(await markAliaAutomationRun(db, runId, 'running', { leaseMs: 60_000 })).toBe(false);
  });

  it('reaps a lapsed or never-picked-up run exactly once, and spares a live one', async () => {
    const { automation } = await aliaTask();
    const lapsed = await claim(automation.id);
    const live = await claim(automation.id);
    const neverPicked = await claim(automation.id);
    await markAliaAutomationRun(db, lapsed, 'running', { leaseMs: 60_000 });
    await markAliaAutomationRun(db, live, 'running', { leaseMs: 60 * 60_000 });

    const now = new Date(Date.now() + 5 * 60_000);
    const plannedBefore = new Date(Date.now() + 60_000);
    const abandoned = await listAbandonedAliaRuns(db, now, plannedBefore, 1_000);
    expect(abandoned).toEqual(expect.arrayContaining([lapsed, neverPicked]));
    expect(abandoned).not.toContain(live);

    const reaped = await failAbandonedAliaRun(db, lapsed, now, plannedBefore);
    expect(reaped).toEqual({ id: lapsed, automationId: automation.id, requesterAccountId: OWNER, creditReservation: HOLD });
    expect(await failAbandonedAliaRun(db, lapsed, now, plannedBefore)).toBeNull();
    expect(await failAbandonedAliaRun(db, live, now, plannedBefore)).toBeNull();
    expect((await findAutomationRunById(db, lapsed))?.status).toBe('failed');
    expect((await listAutomationRunSteps(db, lapsed)).every((step) => step.status === 'failed')).toBe(true);
    // The worker that finishes late cannot settle what the reaper refunded.
    expect(await markAliaAutomationRun(db, lapsed, 'succeeded')).toBe(false);
  });
});

describe('watch state', () => {
  it('records observations, backs off failures and pauses once per streak', async () => {
    const { automation } = await aliaTask({ inputs: { watch: { query: 'Meta announces' } } });
    expect(await findAutomationWatchState(db, automation.id)).toBeNull();
    const now = new Date();

    await recordAutomationWatchObservation(db, {
      automationId: automation.id, hash: 'h1', items: ['a', 'b'], matched: false, changed: false, now,
    });
    expect(await findAutomationWatchState(db, automation.id)).toMatchObject({
      lastHash: 'h1', lastItems: ['a', 'b'], consecutiveFailures: 0, lastChangedAt: null,
    });

    for (let streak = 1; streak <= 5; streak++) {
      expect(await recordAutomationWatchFailure(db, automation.id, now)).toBe(streak);
    }
    const failing = await findAutomationWatchState(db, automation.id);
    expect(failing?.nextCheckAt?.getTime()).toBe(now.getTime() + 32 * 60_000);
    expect(failing?.lastHash).toBe('h1');

    expect(await pauseFailingAutomationWatch(db, automation.id, 5, now)).toBe(true);
    expect(await pauseFailingAutomationWatch(db, automation.id, 5, now)).toBe(false);
    expect((await findAutomationDefinitionById(db, automation.id))?.enabled).toBe(false);
    expect(await findAutomationWatchState(db, automation.id)).toMatchObject({ consecutiveFailures: 0, nextCheckAt: null });

    await recordAutomationWatchObservation(db, {
      automationId: automation.id, hash: 'h2', items: ['a', 'c'], matched: false, changed: true, now,
    });
    expect(await findAutomationWatchState(db, automation.id)).toMatchObject({
      lastHash: 'h2', pausedAt: null, lastChangedAt: now,
    });
  });

  it('rejects a negative streak', async () => {
    const { automation } = await aliaTask();
    await expect(db.execute(sql`
      insert into automation_watch_states (automation_id, consecutive_failures) values (${automation.id}, -1)`))
      .rejects.toThrow();
  });
});
