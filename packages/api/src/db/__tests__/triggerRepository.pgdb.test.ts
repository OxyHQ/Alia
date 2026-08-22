import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  claimTriggerForRun,
  completeTriggerExecution,
  countTriggerExecutions,
  createTrigger,
  createTriggerExecution,
  deleteTriggerForUser,
  findAgentHeartbeatTrigger,
  findBriefingTrigger,
  findIntegrationEventTriggers,
  findLastSuccessfulExecution,
  findSchedulableTriggers,
  findTriggerByWebhookToken,
  findTriggerForUser,
  listTriggerExecutions,
  listTriggers,
  triggerExistsByNameAndPrompt,
  updateTrigger,
  type NewTrigger,
} from '../automation/triggerRepository';
import { triggerExecutions, triggers } from '../schema/automation';

/**
 * Triggers and their runs, against a real server.
 *
 * Users are namespaced `trr-*`: the pgdb suite shares ONE database across
 * files, so anything counting or listing is scoped to ids this file owns.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

/**
 * Fixture instants are RELATIVE to now, and that is not a style choice.
 *
 * `trigger_executions` is an expiry target with 30-day retention measured from
 * `started_at` (`db/expiryTargets.ts`), and the pgdb suite shares ONE database
 * across files. A hardcoded `2026-03-01` is therefore a row ANY sibling file's
 * full-registry sweep is entitled to delete MID-TEST — and it surfaces as an
 * ordering assertion failing in a file that changed nothing, which is the worst
 * possible place to go looking. Measured: these fixtures made
 * `pages newest first` intermittent under the parallel run.
 *
 * `workflow_executions` has no TTL, so `workflowRepository.pgdb.test.ts` is not
 * exposed the same way.
 */
const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000);

const seed = (owner: string, extra: Partial<NewTrigger> = {}) =>
  createTrigger(db, {
    oxyUserId: owner,
    name: 'a trigger',
    type: 'schedule',
    action: { prompt: 'do the thing', useTools: false },
    schedule: { type: 'cron', cron: '0 9 * * *', timezone: 'Europe/Madrid' },
    ...extra,
  });

describe('claiming a trigger for a run', () => {
  /**
   * THE case. `executeTrigger` claims with `lastStatus: { $ne: 'running' }`,
   * and a trigger that has never run has NO `lastStatus`. Mongo's `$ne` matches
   * a missing field, so the claim succeeds and the trigger runs.
   *
   * `last_status <> 'running'` evaluates NULL on that row, which is not TRUE, so
   * the update matches nothing — and EVERY first run of EVERY trigger would
   * report "already running" and silently do nothing. No error, no log, a
   * plausible-looking result. `IS DISTINCT FROM` is the correct spelling.
   */
  it('claims a trigger whose last_status has never been set', async () => {
    const trigger = await seed('trr-claim');
    expect(trigger.lastStatus).toBeUndefined();

    const claimed = await claimTriggerForRun(db, trigger._id);
    expect(claimed).toBeDefined();
    expect(claimed?.lastStatus).toBe('running');
  });

  it('refuses a trigger already running, and claims one that finished', async () => {
    const trigger = await seed('trr-claim2');

    expect(await claimTriggerForRun(db, trigger._id)).toBeDefined();
    // Second claim, still running: refused.
    expect(await claimTriggerForRun(db, trigger._id)).toBeUndefined();

    await db
      .update(triggers)
      .set({ lastStatus: 'success' })
      .where(eq(triggers.id, trigger._id));
    // Positive control: the refusal is about 'running', not about claiming twice.
    expect(await claimTriggerForRun(db, trigger._id)).toBeDefined();
  });

  it('answers undefined for a trigger that does not exist', async () => {
    expect(
      await claimTriggerForRun(db, '00000000-0000-7000-8000-000000000000'),
    ).toBeUndefined();
  });
});

describe('the nested shape the API serves', () => {
  it('rebuilds every group from its flattened columns', async () => {
    const trigger = await seed('trr-shape', {
      type: 'webhook',
      name: 'hooked',
      description: 'a description',
      action: {
        prompt: 'p',
        useTools: true,
        notify: true,
        agentId: 'agent-1',
        channelId: 'chan-1',
      },
      schedule: undefined,
      webhook: { token: 'trr-token-1', secret: 's3cret', allowedIps: ['10.0.0.1'] },
    });

    expect(trigger.action).toEqual({
      prompt: 'p',
      useTools: true,
      notify: true,
      agentId: 'agent-1',
      channelId: 'chan-1',
    });
    expect(trigger.webhook).toEqual({
      token: 'trr-token-1',
      secret: 's3cret',
      allowedIps: ['10.0.0.1'],
    });
    expect(trigger._id).toEqual(expect.any(String));
  });

  /**
   * An unset group must be ABSENT, not an object of nulls. Mongoose left an
   * unset sub-document off the document, so `'schedule' in trigger` is a test a
   * client can make and `JSON.stringify` emits nothing for it. `toEqual` cannot
   * see the difference between `undefined` and absent, so the key is asserted.
   */
  it('omits a group that has no value, rather than nulling it', async () => {
    const trigger = await seed('trr-absent', {
      type: 'webhook',
      schedule: undefined,
      webhook: { token: 'trr-token-2' },
    });

    expect('schedule' in trigger).toBe(false);
    expect('integrationEvent' in trigger).toBe(false);
    expect('description' in trigger).toBe(false);
    // Positive control: the group that DOES have a value is present.
    expect('webhook' in trigger).toBe(true);
    const { webhook } = trigger;
    if (!webhook) throw new Error('expected a webhook group');
    expect('secret' in webhook).toBe(false);
  });
});

describe('PATCH merges action and webhook but REPLACES schedule', () => {
  /**
   * The asymmetry is the source's, not the port's:
   * `trigger.set('action', {...trigger.action, ...action})` merged, while
   * `trigger.schedule = schedule` assigned. Getting either backwards is silent
   * — a merged schedule keeps a stale `cron` that the scheduler then obeys.
   */
  it('leaves unnamed action keys alone', async () => {
    const trigger = await seed('trr-merge', {
      action: { prompt: 'original', useTools: true, channelId: 'keep-me' },
    });

    const updated = await updateTrigger(db, trigger._id, { action: { notify: true } });
    expect(updated?.action.notify).toBe(true);
    expect(updated?.action.prompt).toBe('original');
    expect(updated?.action.useTools).toBe(true);
    expect(updated?.action.channelId).toBe('keep-me');
  });

  it('clears schedule keys the replacement does not name', async () => {
    const trigger = await seed('trr-replace', {
      schedule: { type: 'cron', cron: '0 9 * * *', timezone: 'Europe/Madrid' },
    });
    expect(trigger.schedule?.cron).toBe('0 9 * * *');

    const updated = await updateTrigger(db, trigger._id, {
      schedule: { type: 'daily', time: '07:30' },
    });
    const schedule = updated?.schedule;
    if (!schedule) throw new Error('expected a schedule group');
    expect(schedule.type).toBe('daily');
    expect(schedule.time).toBe('07:30');
    // The stale cron MUST be gone — the scheduler would otherwise still obey it.
    expect('cron' in schedule).toBe(false);
    expect('timezone' in schedule).toBe(false);
  });

  it('merges webhook and replaces integrationEvent, matching the source', async () => {
    const trigger = await seed('trr-mix', {
      type: 'webhook',
      schedule: undefined,
      webhook: { token: 'trr-token-3', secret: 'keep', allowedIps: ['10.0.0.1'] },
    });

    const merged = await updateTrigger(db, trigger._id, { webhook: { token: 'rotated' } });
    expect(merged?.webhook?.token).toBe('rotated');
    expect(merged?.webhook?.secret).toBe('keep');
    expect(merged?.webhook?.allowedIps).toEqual(['10.0.0.1']);

    const withEvent = await updateTrigger(db, trigger._id, {
      integrationEvent: { service: 'github', event: 'push', filters: { repo: 'a' } },
    });
    const replaced = await updateTrigger(db, trigger._id, {
      integrationEvent: { service: 'github', event: 'pull_request' },
    });
    expect(withEvent?.integrationEvent?.filters).toEqual({ repo: 'a' });
    const event = replaced?.integrationEvent;
    if (!event) throw new Error('expected an integrationEvent group');
    expect(event.event).toBe('pull_request');
    expect('filters' in event).toBe(false);
  });

  it('removes a group entirely when the patch names null', async () => {
    const trigger = await seed('trr-null');
    const cleared = await updateTrigger(db, trigger._id, { schedule: null });
    if (!cleared) throw new Error('expected the updated trigger back');
    expect('schedule' in cleared).toBe(false);
  });
});

describe('finding triggers', () => {
  it('scopes by owner and orders newest first', async () => {
    await seed('trr-list', { name: 'first' });
    await seed('trr-list', { name: 'second', type: 'webhook', schedule: undefined, webhook: { token: 'trr-token-4' } });
    await seed('trr-list-other', { name: 'not mine' });

    const all = await listTriggers(db, 'trr-list');
    expect(all).toHaveLength(2);
    const [newest, older] = all;
    if (!newest || !older) throw new Error('expected two triggers');
    expect(newest.createdAt.getTime()).toBeGreaterThanOrEqual(older.createdAt.getTime());

    // Narrowed by kind, and the negative half.
    expect(await listTriggers(db, 'trr-list', { type: 'webhook' })).toHaveLength(1);
    expect(await listTriggers(db, 'trr-list', { type: 'integration_event' })).toHaveLength(0);
  });

  it('treats another account trigger as missing', async () => {
    const trigger = await seed('trr-own');
    expect(await findTriggerForUser(db, trigger._id, 'trr-own')).toBeDefined();
    expect(await findTriggerForUser(db, trigger._id, 'trr-intruder')).toBeUndefined();
    expect(await deleteTriggerForUser(db, trigger._id, 'trr-intruder')).toBeUndefined();
    expect((await deleteTriggerForUser(db, trigger._id, 'trr-own'))?.name).toBe('a trigger');
  });

  it('finds an enabled webhook trigger by token, and only an enabled one', async () => {
    const trigger = await seed('trr-hook', {
      type: 'webhook',
      schedule: undefined,
      webhook: { token: 'trr-token-live' },
    });
    expect(await findTriggerByWebhookToken(db, 'trr-token-live')).toBeDefined();
    expect(await findTriggerByWebhookToken(db, 'trr-token-nope')).toBeUndefined();

    await updateTrigger(db, trigger._id, { enabled: false });
    // Disabling must take the webhook offline, not merely stop scheduling it.
    expect(await findTriggerByWebhookToken(db, 'trr-token-live')).toBeUndefined();
  });

  it('collects both schedulable kinds and nothing else', async () => {
    await seed('trr-sched', { name: 'cron one' });
    await seed('trr-sched', { name: 'heartbeat one', type: 'agent_heartbeat', action: { prompt: 'hb', useTools: false, agentId: 'trr-agent-1' } });
    await seed('trr-sched', { name: 'disabled', enabled: false });
    await seed('trr-sched', { name: 'a hook', type: 'webhook', schedule: undefined, webhook: { token: 'trr-token-5' } });

    const mine = (await findSchedulableTriggers(db)).filter((t) => t.oxyUserId === 'trr-sched');
    expect(mine.map((t) => t.name).sort()).toEqual(['cron one', 'heartbeat one']);
  });

  it('matches an integration event on service and event together', async () => {
    await seed('trr-int', {
      type: 'integration_event',
      schedule: undefined,
      integrationEvent: { service: 'github', event: 'push' },
    });
    expect(await findIntegrationEventTriggers(db, 'trr-int', 'github', 'push')).toHaveLength(1);
    // Each half of the predicate has to matter.
    expect(await findIntegrationEventTriggers(db, 'trr-int', 'github', 'issue')).toHaveLength(0);
    expect(await findIntegrationEventTriggers(db, 'trr-int', 'linear', 'push')).toHaveLength(0);
    expect(await findIntegrationEventTriggers(db, 'trr-other', 'github', 'push')).toHaveLength(0);
  });

  it('finds an agent heartbeat trigger by the agent it is bound to', async () => {
    await seed('trr-hb', {
      type: 'agent_heartbeat',
      action: { prompt: 'hb', useTools: false, agentId: 'trr-agent-9' },
    });
    expect(await findAgentHeartbeatTrigger(db, 'trr-agent-9')).toBeDefined();
    expect(await findAgentHeartbeatTrigger(db, 'trr-agent-absent')).toBeUndefined();
  });

  it('finds a briefing trigger by either phrase, case-insensitively', async () => {
    await seed('trr-brief', { name: 'My Daily Briefing' });
    await seed('trr-brief2', { name: 'the MORNING briefing digest' });
    await seed('trr-brief3', { name: 'something else entirely' });

    expect(await findBriefingTrigger(db, 'trr-brief')).toBeDefined();
    expect(await findBriefingTrigger(db, 'trr-brief2')).toBeDefined();
    // The negative half: the match is on the phrase, not on having any trigger.
    expect(await findBriefingTrigger(db, 'trr-brief3')).toBeUndefined();
  });

  it('detects an existing trigger by name and prompt together', async () => {
    await seed('trr-dupe', { name: 'legacy one', action: { prompt: 'the prompt', useTools: true } });
    expect(await triggerExistsByNameAndPrompt(db, 'trr-dupe', 'legacy one', 'the prompt')).toBe(true);
    expect(await triggerExistsByNameAndPrompt(db, 'trr-dupe', 'legacy one', 'other')).toBe(false);
    expect(await triggerExistsByNameAndPrompt(db, 'trr-dupe', 'other', 'the prompt')).toBe(false);
  });
});

describe('runs', () => {
  it('records input, tokens and tool calls across the flattened columns', async () => {
    const trigger = await seed('trr-run');
    const execution = await createTriggerExecution(db, {
      triggerId: trigger._id,
      oxyUserId: 'trr-run',
      triggerType: 'manual',
      input: { event: 'e', payload: { a: 1 }, source: 'manual' },
      startedAt: minutesAgo(30),
    });
    expect(execution.status).toBe('running');
    expect(execution.inputEvent).toBe('e');
    expect(execution.inputPayload).toEqual({ a: 1 });
    expect(execution.inputSource).toBe('manual');

    await completeTriggerExecution(db, execution.id, {
      status: 'success',
      result: 'the answer',
      toolCalls: [{ tool: 'search', args: { q: 'x' } }],
      tokens: { prompt: 10, completion: 20, total: 30 },
      durationMs: 1234,
      completedAt: minutesAgo(29),
    });

    const [row] = await listTriggerExecutions(db, trigger._id, { limit: 10, offset: 0 });
    expect(row?.status).toBe('success');
    expect(row?.tokensPrompt).toBe(10);
    expect(row?.tokensCompletion).toBe(20);
    expect(row?.tokensTotal).toBe(30);
    expect(row?.durationMs).toBe(1234);
    expect(row?.toolCalls).toEqual([{ tool: 'search', args: { q: 'x' } }]);
  });

  it('pages newest first and counts independently of the page', async () => {
    const trigger = await seed('trr-page');
    // Deliberately inserted out of order, so the ordering is the query's doing.
    // A run has no caller-supplied id, so the rows are identified by the ids the
    // inserts handed back rather than by a fixture value.
    const [oldest, newest, middle] = await Promise.all(
      [30, 10, 20].map((ago) =>
        createTriggerExecution(db, {
          triggerId: trigger._id,
          oxyUserId: 'trr-page',
          triggerType: 'schedule',
          startedAt: minutesAgo(ago),
        }),
      ),
    );

    const firstPage = await listTriggerExecutions(db, trigger._id, { limit: 2, offset: 0 });
    expect(firstPage.map((r) => r.id)).toEqual([newest?.id, middle?.id]);
    const secondPage = await listTriggerExecutions(db, trigger._id, { limit: 2, offset: 2 });
    expect(secondPage.map((r) => r.id)).toEqual([oldest?.id]);
    // The count is the total, not the page.
    expect(await countTriggerExecutions(db, trigger._id)).toBe(3);
  });

  /**
   * `NULLS LAST` is not decoration. A successful run that never recorded a
   * `completed_at` sorts FIRST under Postgres's default `DESC` — so the report
   * comparison would quote a row with no result over the genuine latest one.
   */
  it('reads the latest successful run, ignoring one with no completion', async () => {
    const trigger = await seed('trr-prev');
    const real = await createTriggerExecution(db, {
      triggerId: trigger._id,
      oxyUserId: 'trr-prev',
      triggerType: 'schedule',
      startedAt: minutesAgo(30),
    });
    await completeTriggerExecution(db, real.id, {
      status: 'success',
      result: 'the real report',
      durationMs: 1,
      completedAt: minutesAgo(29),
    });
    // A success that never completed — the row `NULLS LAST` has to keep at the back.
    await db.insert(triggerExecutions).values({
      triggerId: trigger._id,
      oxyUserId: 'trr-prev',
      status: 'success',
      triggerType: 'schedule',
      startedAt: minutesAgo(20),
    });

    const previous = await findLastSuccessfulExecution(db, trigger._id);
    expect(previous?.result).toBe('the real report');
  });

  it('has no successful run to read when every run failed', async () => {
    const trigger = await seed('trr-none');
    const execution = await createTriggerExecution(db, {
      triggerId: trigger._id,
      oxyUserId: 'trr-none',
      triggerType: 'schedule',
      startedAt: minutesAgo(30),
    });
    await completeTriggerExecution(db, execution.id, {
      status: 'failed',
      result: 'boom',
      durationMs: 1,
      completedAt: minutesAgo(29),
    });
    expect(await findLastSuccessfulExecution(db, trigger._id)).toBeUndefined();
  });
});
