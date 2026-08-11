import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { oxyServiceEventLogs, oxyServices } from '../schema/oxy-services';
import {
  findActiveOxyService,
  listActiveOxyServiceDefs,
  upsertOxyService,
  type OxyServiceManifest,
} from '../integrations/oxyServiceRepository';
import {
  claimOxyServiceEvent,
  markOxyServiceEventDuplicate,
  markOxyServiceEventFailed,
  markOxyServiceEventProcessed,
} from '../integrations/oxyServiceEventLogRepository';

/**
 * The Oxy service connector's repositories, against a REAL server.
 *
 * Every id here is prefixed `osr-`, and every aggregate is scoped to rows this
 * file inserted. Four `*.pgdb.test.ts` files share one database per run, so an
 * unscoped `count()` would read a sibling's fixtures and fail for a reason that
 * names nothing.
 */

let db: ApiDatabase;

const MANIFEST: OxyServiceManifest = {
  serviceId: 'osr-inbox',
  displayName: 'Inbox',
  description: 'Email',
  version: '1.0.0',
  baseUrl: 'https://api.oxy.so',
  isFirstParty: true,
  webhookSecret: 'osr-secret',
  contextEndpoint: '/email/ai-context',
  tools: [
    {
      name: 'searchEmails',
      description: 'Search emails',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      endpoint: { method: 'GET', path: '/email/search' },
      confirmBeforeExecute: false,
    },
  ],
  events: [{ name: 'new_email', description: 'A new email', action: 'notify' }],
};

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

describe('a manifest is registered by service id, and a re-seed REPLACES it', () => {
  it('inserts on first upsert and returns the stored row', async () => {
    const row = await upsertOxyService(db, MANIFEST);

    expect(row.serviceId).toBe('osr-inbox');
    expect(row.tools).toHaveLength(1);
    expect(row.events).toHaveLength(1);
    // `jsonb` round-trips as the declared element type, not as `unknown`.
    expect(row.tools[0]?.endpoint.method).toBe('GET');
    expect(row.events[0]?.action).toBe('notify');
  });

  it('updates in place on the second upsert rather than inserting a rival row', async () => {
    const first = await upsertOxyService(db, MANIFEST);
    const second = await upsertOxyService(db, { ...MANIFEST, version: '2.0.0' });

    // Same row: the unique on `service_id` is what the conflict target names, so
    // a second manifest cannot create a second manifest for one service.
    expect(second.id).toBe(first.id);
    expect(second.version).toBe('2.0.0');

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(oxyServices)
      .where(eq(oxyServices.serviceId, 'osr-inbox'));
    expect(n).toBe(1);
  });

  it('REPLACES a field the new manifest leaves out, rather than merging', async () => {
    /**
     * The behaviour change worth pinning. The source passed `$set: svc` with a
     * `Partial<IOxyService>`, so an omitted key kept whatever the previous
     * version had written. `OxyServiceManifest` requires the field and the
     * upsert names the column, so a re-seed cannot leave half of an old version
     * behind — which is what "the manifest is the truth" has to mean for a
     * `contextEndpoint` that was deliberately removed.
     */
    await upsertOxyService(db, MANIFEST);
    const cleared = await upsertOxyService(db, { ...MANIFEST, contextEndpoint: undefined });

    expect(cleared.contextEndpoint).toBeNull();
  });

  it('moves `updated_at` on a re-seed, from the column helper alone', async () => {
    /**
     * The repository does NOT name `updated_at` in its conflict `set`, and this
     * is what makes that safe rather than an omission. `updatedAt()` from
     * `@oxyhq/db` carries `$onUpdate(() => new Date())`, and drizzle applies it
     * to a conflict clause as well as to a plain `update`: the built statement
     * ends `do update set … "updated_at" = $N` with no such key in the source.
     *
     * Written the other way round first, with the column named explicitly and a
     * comment claiming the helper did not reach here. Removing that line left
     * this test green, which is what showed the claim was wrong — so what
     * survives is the helper, and this assertion is the thing that would notice
     * if a future `@oxyhq/db` stopped doing it.
     */
    const first = await upsertOxyService(db, { ...MANIFEST, serviceId: 'osr-updated-at' });
    // The default has millisecond precision, so two upserts in the same
    // millisecond would be indistinguishable from a column that never moved.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await upsertOxyService(db, {
      ...MANIFEST,
      serviceId: 'osr-updated-at',
      version: '3.0.0',
    });

    expect(again.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
  });

  it('does not rewrite when the service first registered', async () => {
    const first = await upsertOxyService(db, { ...MANIFEST, serviceId: 'osr-created-at' });
    const again = await upsertOxyService(db, {
      ...MANIFEST,
      serviceId: 'osr-created-at',
      version: '9.9.9',
    });

    expect(again.createdAt.getTime()).toBe(first.createdAt.getTime());
  });
});

describe('the webhook route reads the signature key, and the tool builder does NOT', () => {
  it('gives the webhook route the secret it cannot verify without', async () => {
    await upsertOxyService(db, MANIFEST);

    const row = await findActiveOxyService(db, 'osr-inbox');
    expect(row?.webhookSecret).toBe('osr-secret');
    expect(row?.events[0]?.name).toBe('new_email');
  });

  it('does not project the secret into the tool-builder rows', async () => {
    await upsertOxyService(db, MANIFEST);

    const defs = await listActiveOxyServiceDefs(db);
    const mine = defs.find((d) => d.serviceId === 'osr-inbox');
    expect(mine).toBeDefined();
    // A structural assertion, not a value one: `select()` with no column list
    // would have returned the column, and `toBeUndefined()` on a value that was
    // never selected is indistinguishable from a null secret.
    expect(Object.keys(mine ?? {})).not.toContain('webhookSecret');
    expect(Object.keys(mine ?? {}).sort()).toEqual([
      'contextEndpoint',
      'description',
      'displayName',
      'serviceId',
      'tools',
    ]);
  });

  it('hides a DISABLED service from both readers', async () => {
    await upsertOxyService(db, {
      ...MANIFEST,
      serviceId: 'osr-disabled',
      status: 'disabled',
    });

    expect(await findActiveOxyService(db, 'osr-disabled')).toBeNull();
    const defs = await listActiveOxyServiceDefs(db);
    expect(defs.map((d) => d.serviceId)).not.toContain('osr-disabled');
    // Vacuity floor: the reader CAN see something, so the absence above is a
    // filter rather than an empty table.
    expect(defs.map((d) => d.serviceId)).toContain('osr-inbox');
  });
});

describe('an inbound event is claimed at most once', () => {
  const key = { serviceId: 'osr-inbox', oxyUserId: 'osr-user-1', eventId: 'osr-evt-1' };

  it('returns an id for the first delivery and NULL for a redelivery', async () => {
    const first = await claimOxyServiceEvent(db, {
      ...key,
      eventName: 'new_email',
      action: 'notify',
      payloadHash: 'hash-1',
    });
    expect(first).not.toBeNull();

    const second = await claimOxyServiceEvent(db, {
      ...key,
      eventName: 'new_email',
      action: 'notify',
      payloadHash: 'hash-1',
    });
    // The whole point: NOT a thrown duplicate-key error. A thrown one would
    // abort a surrounding transaction and take the duplicate-marking update
    // with it.
    expect(second).toBeNull();

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(oxyServiceEventLogs)
      .where(eq(oxyServiceEventLogs.eventId, 'osr-evt-1'));
    expect(n).toBe(1);
  });

  it('scopes the key to the USER, so two people can receive the same event id', async () => {
    const a = await claimOxyServiceEvent(db, {
      serviceId: 'osr-inbox',
      oxyUserId: 'osr-user-a',
      eventId: 'osr-shared',
      eventName: 'new_email',
      action: 'notify',
      payloadHash: 'h',
    });
    const b = await claimOxyServiceEvent(db, {
      serviceId: 'osr-inbox',
      oxyUserId: 'osr-user-b',
      eventId: 'osr-shared',
      eventName: 'new_email',
      action: 'notify',
      payloadHash: 'h',
    });

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('leaves a genuine failure to propagate — DO NOTHING narrows only the unique', async () => {
    /**
     * The negative control on the claim. `onConflictDoNothing` must not be a
     * blanket "swallow errors": a CHECK violation is still an error, and a claim
     * that answered `null` to one would report "already seen" for a row that was
     * never stored.
     */
    await expect(
      claimOxyServiceEvent(db, {
        serviceId: 'osr-inbox',
        oxyUserId: 'osr-user-c',
        eventId: 'osr-bad-action',
        eventName: 'new_email',
        // Outside `OXY_SERVICE_EVENT_ACTIONS`, so the CHECK refuses it.
        action: 'not-an-action' as 'notify',
        payloadHash: 'h',
      }),
    ).rejects.toThrow();
  });
});

describe('a processed event records WHEN, because the database refuses otherwise', () => {
  it('sets the timestamp alongside the status', async () => {
    const id = await claimOxyServiceEvent(db, {
      serviceId: 'osr-inbox',
      oxyUserId: 'osr-user-2',
      eventId: 'osr-evt-2',
      eventName: 'new_email',
      action: 'notify',
      payloadHash: 'h',
    });
    if (!id) throw new Error('claim returned null');

    await markOxyServiceEventProcessed(db, id);

    const [row] = await db
      .select()
      .from(oxyServiceEventLogs)
      .where(eq(oxyServiceEventLogs.id, id));
    expect(row?.status).toBe('processed');
    expect(row?.processedAt).toBeInstanceOf(Date);
  });

  it('records the session an autonomous event ran in', async () => {
    const id = await claimOxyServiceEvent(db, {
      serviceId: 'osr-inbox',
      oxyUserId: 'osr-user-3',
      eventId: 'osr-evt-3',
      eventName: 'new_email',
      action: 'autonomous',
      payloadHash: 'h',
    });
    if (!id) throw new Error('claim returned null');

    await markOxyServiceEventProcessed(db, id, 'osr-session-1');

    const [row] = await db
      .select()
      .from(oxyServiceEventLogs)
      .where(eq(oxyServiceEventLogs.id, id));
    expect(row?.agentSessionId).toBe('osr-session-1');
  });

  it('does NOT erase a recorded session when a later failure omits it', async () => {
    /**
     * The `$set`-with-an-absent-key trap, pinned. Mongo left an unmentioned
     * field alone; `.set({ agentSessionId: null })` would erase it and
     * `.set({ agentSessionId: undefined })` is a silent no-op in drizzle. Only
     * the spread keeps the source's meaning, and only a two-step sequence can
     * tell the three apart.
     */
    const id = await claimOxyServiceEvent(db, {
      serviceId: 'osr-inbox',
      oxyUserId: 'osr-user-4',
      eventId: 'osr-evt-4',
      eventName: 'new_email',
      action: 'autonomous',
      payloadHash: 'h',
    });
    if (!id) throw new Error('claim returned null');

    await markOxyServiceEventProcessed(db, id, 'osr-session-2');
    await markOxyServiceEventFailed(db, id, 'later_failure');

    const [row] = await db
      .select()
      .from(oxyServiceEventLogs)
      .where(eq(oxyServiceEventLogs.id, id));
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toBe('later_failure');
    expect(row?.agentSessionId).toBe('osr-session-2');
  });

  it('marks the row a redelivery collided with', async () => {
    const key = {
      serviceId: 'osr-inbox',
      oxyUserId: 'osr-user-5',
      eventId: 'osr-evt-5',
    };
    const id = await claimOxyServiceEvent(db, {
      ...key,
      eventName: 'new_email',
      action: 'notify',
      payloadHash: 'h',
    });
    if (!id) throw new Error('claim returned null');

    await markOxyServiceEventDuplicate(db, key);

    const [row] = await db
      .select()
      .from(oxyServiceEventLogs)
      .where(eq(oxyServiceEventLogs.id, id));
    expect(row?.status).toBe('duplicate');
    expect(row?.processedAt).toBeInstanceOf(Date);
  });
});
