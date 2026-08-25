import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  createContainer,
  createContainerTemplate,
  deleteOwnedContainerTemplate,
  exposeContainerPort,
  findOwnedContainer,
  findSessionContainerId,
  idleContainer,
  listOwnedContainerTemplates,
  listOwnedContainers,
  markContainerDestroyed,
  ownedContainerIsAttachable,
  resumeContainer,
  touchContainer,
} from '../agents/containerRepository';
import { containers } from '../schema/containers';
import { agents } from '../schema/agents';

/**
 * The container repository against a real server.
 *
 * A container is an execution surface, so the assertions that matter most here
 * are the NEGATIVE ones: what a stranger's id does NOT reach. The Mongoose call
 * sites updated by `containerId` alone, so every one of these is a statement
 * about a tightening rather than a restatement of the source.
 *
 * Owners are namespaced `ctrr-*`: the pgdb suite shares one database across
 * files and `containers.pgdb.test.ts` seeds the same table.
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

const OWNER = 'ctrr-owner';
const STRANGER = 'ctrr-stranger';

/**
 * `container_templates.agent_id` carries a REAL foreign key to `agents.id`, so a
 * template cannot be recorded for an agent that does not exist as a Postgres
 * row. The fixture is here rather than inlined because that constraint is the
 * one thing about this table a caller can get wrong from a distance — see the
 * repository's note on what it means for `snapshot_create`.
 */
const TEMPLATE_AGENT = 'ctrr-agent-row';

beforeAll(async () => {
  await db.insert(agents).values({
    id: TEMPLATE_AGENT,
    oxyAccountId: `oxy-bot-ctrr-${Math.random().toString(36).slice(2, 10)}`,
    tagline: 'takes snapshots',
    description: 'a longer description',
    authorOxyUserId: OWNER,
    category: 'research',
  });
});

async function seed(
  containerId: string,
  overrides: Partial<Parameters<typeof createContainer>[1]> = {},
): Promise<string> {
  await createContainer(db, {
    containerId,
    name: 'sandbox',
    sessionId: 'ctrr-session',
    agentId: TEMPLATE_AGENT,
    oxyUserId: OWNER,
    image: 'python:3.12',
    size: 'small',
    status: 'running',
    persistent: false,
    ...overrides,
  });
  return containerId;
}

describe('owner scoping', () => {
  /**
   * The whole point of the tightening, and it is stated as four separate
   * statements because they are four separate WHERE clauses. A single "the
   * stranger cannot read it" case would leave three writes able to address
   * another account's sandbox.
   */
  it('hides another account\'s container from every read', async () => {
    const id = await seed('ctrr-scoped');

    expect(await findOwnedContainer(db, id, OWNER)).toMatchObject({ containerId: id });
    expect(await findOwnedContainer(db, id, STRANGER)).toBeUndefined();

    expect(await ownedContainerIsAttachable(db, id, OWNER)).toBe(true);
    expect(await ownedContainerIsAttachable(db, id, STRANGER)).toBe(false);

    expect(await findSessionContainerId(db, 'ctrr-session', OWNER)).not.toBeNull();
    expect(await findSessionContainerId(db, 'ctrr-session', STRANGER)).toBeNull();
  });

  it('refuses every WRITE addressed by a stranger, and the row is untouched', async () => {
    const id = await seed('ctrr-write-scoped', { status: 'running' });

    expect(await markContainerDestroyed(db, id, STRANGER)).toBe(0);
    await touchContainer(db, id, STRANGER);
    await idleContainer(db, id, STRANGER);
    await resumeContainer(db, id, STRANGER);
    await exposeContainerPort(db, id, STRANGER, 'https://stranger.invalid', 8080);

    /**
     * Asserting the ROW rather than the return values. `touchContainer`,
     * `idleContainer`, `resumeContainer` and `exposeContainerPort` all return
     * `void`, so "the statement matched nothing" and "the statement did the work"
     * look identical from the caller — which is exactly how a dropped owner
     * clause would survive review.
     */
    const [row] = await db
      .select({
        status: containers.status,
        persistent: containers.persistent,
        previewUrl: containers.previewUrl,
        ports: containers.exposedPorts,
      })
      .from(containers)
      .where(eq(containers.containerId, id));
    expect(row).toEqual({
      status: 'running',
      persistent: false,
      previewUrl: null,
      ports: [],
    });

    // The positive control: the same five calls from the OWNER do land.
    expect(await markContainerDestroyed(db, id, OWNER)).toBe(1);
  });
});

describe('exposing a port', () => {
  /**
   * `$addToSet`, and the reason this case exists.
   *
   * `array_append` is the obvious translation and it is wrong: exposing the same
   * port twice — a retry, a reconnect, an agent repeating itself — would leave
   * `{3000,3000}` where Mongo left `{3000}`. Nothing throws on the duplicate,
   * which is precisely why it would survive. The SECOND call is the whole test;
   * a single call cannot tell the two implementations apart.
   */
  it('does not duplicate a port that is already exposed', async () => {
    const id = await seed('ctrr-ports');

    await exposeContainerPort(db, id, OWNER, 'https://a.invalid', 3000);
    await exposeContainerPort(db, id, OWNER, 'https://b.invalid', 8080);
    await exposeContainerPort(db, id, OWNER, 'https://c.invalid', 3000);

    const row = await findOwnedContainer(db, id, OWNER);
    expect(row?.exposedPorts).toEqual([3000, 8080]);
    // The preview URL is REPLACED each time; only the port list accumulates.
    expect(row?.previewUrl).toBe('https://c.invalid');
  });
});

describe('the lifecycle columns', () => {
  it('sets last_activity_at on insert, because the column has no default', async () => {
    /**
     * Mongoose declared `default: Date.now` and the column is a bare nullable
     * `timestamptz`. The repository supplies it; without that line a container
     * reads back with a NULL activity clock and nothing else in the package
     * would notice.
     */
    const id = await seed('ctrr-activity');
    const row = await findOwnedContainer(db, id, OWNER);
    expect(row?.lastActivityAt).toBeInstanceOf(Date);
  });

  it('moves the activity clock forward on a touch', async () => {
    const id = await seed('ctrr-touch');
    const before = (await findOwnedContainer(db, id, OWNER))?.lastActivityAt;

    await db
      .update(containers)
      .set({ lastActivityAt: new Date(Date.now() - 60_000) })
      .where(eq(containers.containerId, id));
    await touchContainer(db, id, OWNER);

    const after = (await findOwnedContainer(db, id, OWNER))?.lastActivityAt;
    expect(before).toBeInstanceOf(Date);
    expect(after?.getTime()).toBeGreaterThan(Date.now() - 30_000);
  });

  it('parks a container as idle AND persistent, then resumes it', async () => {
    const id = await seed('ctrr-idle', { persistent: false });

    await idleContainer(db, id, OWNER);
    const idled = await findOwnedContainer(db, id, OWNER);
    expect(idled).toMatchObject({ status: 'idle', persistent: true });
    // An idled container is still reattachable; a destroyed one is not.
    expect(await ownedContainerIsAttachable(db, id, OWNER)).toBe(true);

    await resumeContainer(db, id, OWNER);
    expect((await findOwnedContainer(db, id, OWNER))?.status).toBe('running');
  });

  it('records a destruction and reports rows changed off count, not rows', async () => {
    const id = await seed('ctrr-destroy');

    expect(await markContainerDestroyed(db, id, OWNER)).toBe(1);
    const row = await findOwnedContainer(db, id, OWNER);
    expect(row?.status).toBe('destroyed');
    expect(row?.destroyedAt).toBeInstanceOf(Date);
    // No longer attachable, which is the read `reattach()` depends on.
    expect(await ownedContainerIsAttachable(db, id, OWNER)).toBe(false);

    // A repeat still MATCHES the row — `count` behaves like `matchedCount`, not
    // `modifiedCount`. The route reads it only to decide whether it destroyed
    // anything it had already fetched, so this is the semantics it wants.
    expect(await markContainerDestroyed(db, id, OWNER)).toBe(1);
    expect(await markContainerDestroyed(db, 'ctrr-no-such-container', OWNER)).toBe(0);
  });
});

describe('listing', () => {
  const LIST_OWNER = 'ctrr-list-owner';

  it('excludes destroyed containers and keeps every other status', async () => {
    /**
     * `ne(status, 'destroyed')` rather than a list of live statuses. The
     * `stopped` row is what tells the two apart: an allow-list of
     * `creating|running|idle` would silently drop it, and the source's
     * `{ $ne: 'destroyed' }` did not.
     */
    for (const [containerId, status] of [
      ['ctrr-l-creating', 'creating'],
      ['ctrr-l-running', 'running'],
      ['ctrr-l-idle', 'idle'],
      ['ctrr-l-stopped', 'stopped'],
      ['ctrr-l-destroyed', 'destroyed'],
    ] as const) {
      await seed(containerId, { oxyUserId: LIST_OWNER, status });
    }

    const rows = await listOwnedContainers(db, LIST_OWNER);
    expect(rows.map((r) => r.status).sort()).toEqual(['creating', 'idle', 'running', 'stopped']);
    // The wire keeps `_id`, because `GET` and `DELETE` are a pair.
    expect(rows.every((r) => typeof r._id === 'string' && r._id.length > 0)).toBe(true);
  });

  it('returns another account nothing, and that is not an empty table', async () => {
    // The vacuity floor: an owner filter that matched nothing and a broken query
    // are the same observable without the positive half above.
    expect(await listOwnedContainers(db, 'ctrr-nobody')).toEqual([]);
    expect((await listOwnedContainers(db, LIST_OWNER)).length).toBeGreaterThan(0);
  });

  it('resolves a session to its NEWEST live container, never a destroyed one', async () => {
    const SESSION = 'ctrr-session-newest';
    await seed('ctrr-old', { sessionId: SESSION, status: 'idle' });
    await db
      .update(containers)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(containers.containerId, 'ctrr-old'));
    await seed('ctrr-new', { sessionId: SESSION, status: 'running' });
    await seed('ctrr-dead', { sessionId: SESSION, status: 'destroyed' });

    expect(await findSessionContainerId(db, SESSION, OWNER)).toBe('ctrr-new');

    // With the newest one gone the older LIVE one is what remains — a destroyed
    // row must never win, and only removing the newest can show that.
    await markContainerDestroyed(db, 'ctrr-new', OWNER);
    expect(await findSessionContainerId(db, SESSION, OWNER)).toBe('ctrr-old');
  });
});

describe('container templates', () => {
  it('creates a snapshot, lists it for its owner and nobody else', async () => {
    const id = await createContainerTemplate(db, {
      name: 'my snapshot',
      description: 'configured environment',
      baseImage: 'python:3.12',
      snapshotTag: `ctrr-tag-${Date.now()}`,
      oxyUserId: OWNER,
      agentId: TEMPLATE_AGENT,
    });

    const mine = await listOwnedContainerTemplates(db, OWNER);
    expect(mine.map((t) => t._id)).toContain(id);
    expect(await listOwnedContainerTemplates(db, STRANGER)).toEqual([]);
  });

  it('omits an absent description rather than writing an empty string', async () => {
    const id = await createContainerTemplate(db, {
      name: 'no description',
      baseImage: 'node:22',
      snapshotTag: `ctrr-tag-nodesc-${Date.now()}`,
      oxyUserId: OWNER,
      agentId: TEMPLATE_AGENT,
    });
    const row = (await listOwnedContainerTemplates(db, OWNER)).find((t) => t._id === id);
    expect(row?.description).toBeNull();
  });

  it('deletes only its owner\'s template, reporting rows removed off count', async () => {
    const id = await createContainerTemplate(db, {
      name: 'doomed',
      baseImage: 'node:22',
      snapshotTag: `ctrr-tag-doomed-${Date.now()}`,
      oxyUserId: OWNER,
      agentId: TEMPLATE_AGENT,
    });

    expect(await deleteOwnedContainerTemplate(db, id, STRANGER)).toBe(0);
    // Still there — a DELETE's row set is empty either way, so the count is the
    // only thing that distinguishes "refused" from "done".
    expect((await listOwnedContainerTemplates(db, OWNER)).map((t) => t._id)).toContain(id);

    expect(await deleteOwnedContainerTemplate(db, id, OWNER)).toBe(1);
    expect((await listOwnedContainerTemplates(db, OWNER)).map((t) => t._id)).not.toContain(id);
    expect(await deleteOwnedContainerTemplate(db, id, OWNER)).toBe(0);
  });

  it('refuses two templates with one snapshot tag, across DIFFERENT owners', async () => {
    /**
     * `snapshot_tag` is globally unique, not per-owner, and the tag is derived
     * from a user-supplied name (`tools.ts` slugifies it). So one account can
     * take a name another wanted — which is the source's behaviour and worth
     * pinning, because a per-owner unique looks more reasonable and would be a
     * silent widening.
     */
    const tag = `ctrr-tag-shared-${Date.now()}`;
    await createContainerTemplate(db, {
      name: 'first',
      baseImage: 'node:22',
      snapshotTag: tag,
      oxyUserId: OWNER,
      agentId: TEMPLATE_AGENT,
    });

    await expect(
      createContainerTemplate(db, {
        name: 'second',
        baseImage: 'node:22',
        snapshotTag: tag,
        oxyUserId: STRANGER,
        agentId: TEMPLATE_AGENT,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('container_templates_snapshot_tag_key');
      return true;
    });
  });
});

describe('exposed_ports admits an EMPTY array, and no CHECK says otherwise', () => {
  /**
   * The same ratchet `skillRepository.pgdb.test.ts` carries, for the one array
   * column on this table. Mongoose declared `exposedPorts: [{ type: Number }]`
   * with no validator, and a container that has exposed nothing is the NORMAL
   * case — `port_expose` is an optional tool — so an empty list is not an
   * anomaly to constrain away.
   *
   * `array_length(exposed_ports, 1) >= 1` would ADMIT `{}` anyway: it returns
   * NULL on an empty array and a CHECK rejects only FALSE. Measured on this
   * suite's own server — such a constraint accepted `'{}'`, and the
   * `cardinality` spelling rejected it.
   */
  it('defaults to an empty array and stores it as a zero-length array, not NULL', async () => {
    const id = await seed('ctrr-empty-ports');

    expect((await findOwnedContainer(db, id, OWNER))?.exposedPorts).toEqual([]);

    // Raw, because an empty Postgres array and a NULL are different values that
    // both read falsy in JavaScript, and the column is NOT NULL.
    const raw = await db.execute(sql`
      select cardinality(exposed_ports) as n, exposed_ports is null as is_null
      from containers where container_id = ${id}
    `);
    expect(raw[0]).toMatchObject({ n: 0, is_null: false });
  });

  it('carries no CHECK constraint over exposed_ports', async () => {
    const rows = await db.execute(sql`
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'containers'::regclass and contype = 'c'
    `);

    // Vacuity floor: this table DOES have CHECKs, so an empty result would mean
    // a broken query rather than an unconstrained table.
    expect(rows.map((r) => String(r.conname))).toContain('containers_status_check');
    expect(rows.filter((r) => String(r.def).includes('exposed_ports'))).toEqual([]);
  });
});

describe('the schema carries no expires_at, because nothing ever stored one', () => {
  /**
   * `terminal-session.ts` used to write `expiresAt` beside `status: 'idle'`.
   * `ContainerSchema` declared no such path, so Mongoose's `strict` dropped it
   * on every write; the column does not exist and the parameter is gone.
   *
   * Asserted against `information_schema` rather than by grepping the table
   * object: a `$type` or a comment can claim anything, and the question here is
   * what the MIGRATION created.
   */
  it('has no expires_at column', async () => {
    const rows = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'containers'
    `);
    const names = rows.map((r) => r.column_name);
    // Positive control: the census can see a column that IS there.
    expect(names).toContain('last_activity_at');
    expect(names).not.toContain('expires_at');
  });
});
