import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { MCP_OAUTH_STATE_TTL_SECONDS, mcpServers } from '../schema/integrations';
import {
  deleteMcpServerForUser,
  findMcpServerByName,
  findMcpServerForUser,
  installMcpServer,
  listMcpServersForUser,
  listRunnableMcpServersForUser,
  serializeMcpServer,
  setMcpServerStatus,
  toMcpServerConfig,
  updateMcpServer,
  type NewMcpServer,
} from '../integrations/mcpServerRepository';
import {
  createMcpOAuthState,
  deleteMcpOAuthState,
  deleteMcpOAuthStateByToken,
  findLiveMcpOAuthState,
} from '../integrations/mcpOAuthStateRepository';

/**
 * MCP connectors and their OAuth state, against a REAL server.
 *
 * Ids and user ids are prefixed `mcp-` / `mcpu-`, and every count is scoped to
 * rows this file inserted — several `*.pgdb.test.ts` files share one database
 * per run.
 */

let db: ApiDatabase;

function newServer(overrides: Partial<NewMcpServer> = {}): NewMcpServer {
  return {
    oxyUserId: 'mcpu-1',
    name: 'github',
    displayName: 'GitHub',
    source: 'registry',
    registryId: 'github',
    transport: 'streamable-http',
    runtime: 'server',
    config: { url: 'https://mcp.github.test', requiresOAuth: true },
    ...overrides,
  };
}

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

describe('one user cannot install the same connector name twice', () => {
  /**
   * This is the constraint the schema batch did not port —
   * `McpServerSchema.index({ oxyUserId: 1, name: 1 }, { unique: true })` — and
   * the whole idempotency of `POST /mcp/install` rests on it.
   *
   * Without it the second insert simply SUCCEEDS: no error, no 409, no 200 with
   * the existing row, just a second connector under the same name. The Connect
   * flow calls /install before every OAuth start, so that is a duplicate per
   * attempt, silently.
   */
  it('answers NULL on the second install rather than storing a rival row', async () => {
    const first = await installMcpServer(db, newServer({ oxyUserId: 'mcpu-dup' }));
    expect(first).not.toBeNull();

    const second = await installMcpServer(db, newServer({ oxyUserId: 'mcpu-dup' }));
    expect(second).toBeNull();

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(mcpServers)
      .where(eq(mcpServers.oxyUserId, 'mcpu-dup'));
    expect(n).toBe(1);
  });

  it('scopes the name to the USER, so two people may install the same connector', async () => {
    const a = await installMcpServer(db, newServer({ oxyUserId: 'mcpu-a' }));
    const b = await installMcpServer(db, newServer({ oxyUserId: 'mcpu-b' }));

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.id).not.toBe(b?.id);
  });

  it('finds the existing row by name, which is what turns the NULL into a 200', async () => {
    await installMcpServer(db, newServer({ oxyUserId: 'mcpu-byname' }));

    const found = await findMcpServerByName(db, 'mcpu-byname', 'github');
    expect(found?.name).toBe('github');
    // Vacuity floor on the scope: another user's connector must not answer.
    expect(await findMcpServerByName(db, 'mcpu-nobody', 'github')).toBeNull();
  });
});

describe('`config` is flat in the database and nested on both wires', () => {
  it('round-trips through the columns and back into the nested object', async () => {
    const row = await installMcpServer(
      db,
      newServer({
        oxyUserId: 'mcpu-config',
        name: 'stdio-one',
        transport: 'stdio',
        config: {
          command: 'npx',
          args: ['-y', 'pkg'],
          headers: { Authorization: 'Bearer secret' },
          env: { TOKEN: 'x' },
        },
      }),
    );
    if (!row) throw new Error('install returned null');

    expect(row.configCommand).toBe('npx');
    expect(row.configArgs).toEqual(['-y', 'pkg']);
    expect(toMcpServerConfig(row)).toEqual({
      command: 'npx',
      args: ['-y', 'pkg'],
      headers: { Authorization: 'Bearer secret' },
      env: { TOKEN: 'x' },
    });
  });

  it('omits an unset key ENTIRELY rather than answering null', async () => {
    /**
     * `{ url: null }` and `{}` are the same to `if (config.url)` and different
     * to a strict schema on the far side — and the far side is a separately
     * deployed service. Mongoose omitted an unset sub-document field; a `null`
     * column read back verbatim would not.
     */
    const row = await installMcpServer(
      db,
      newServer({
        oxyUserId: 'mcpu-sparse',
        name: 'sparse',
        transport: 'stdio',
        config: { command: 'npx' },
      }),
    );
    if (!row) throw new Error('install returned null');

    const config = toMcpServerConfig(row);
    expect(config).toEqual({ command: 'npx' });
    expect('url' in config).toBe(false);
    expect('requiresOAuth' in config).toBe(false);
  });

  it('serves `_id` alongside `id`, because a shipped mobile build reads it', async () => {
    const row = await installMcpServer(db, newServer({ oxyUserId: 'mcpu-serialize' }));
    if (!row) throw new Error('install returned null');

    const wire = serializeMcpServer(row);
    expect(wire._id).toBe(row.id);
    expect(wire.id).toBe(row.id);
    expect(wire.config).toEqual({ url: 'https://mcp.github.test', requiresOAuth: true });
    // The scope the query already filtered on is not echoed back.
    expect(Object.keys(wire)).not.toContain('oxyUserId');
  });
});

describe('a patch MERGES config per key, as the sub-document assignment did', () => {
  it('leaves a key the caller did not send alone', async () => {
    const row = await installMcpServer(
      db,
      newServer({
        oxyUserId: 'mcpu-patch',
        name: 'patch-me',
        config: { url: 'https://one.test', requiresOAuth: true },
      }),
    );
    if (!row) throw new Error('install returned null');

    const patched = await updateMcpServer(db, row.id, 'mcpu-patch', {
      config: { url: 'https://two.test' },
    });

    expect(patched?.configUrl).toBe('https://two.test');
    // `requiresOAuth` was not in the patch, so it survives. A replace would
    // have cleared it and quietly un-marked the connector as OAuth-authenticated,
    // which makes the next `/start` connect unauthenticated.
    expect(patched?.configRequiresOauth).toBe(true);
  });

  it('CLEARS a key the caller sent as null', async () => {
    const row = await installMcpServer(
      db,
      newServer({ oxyUserId: 'mcpu-patch-null', name: 'clear-me' }),
    );
    if (!row) throw new Error('install returned null');

    const patched = await updateMcpServer(db, row.id, 'mcpu-patch-null', {
      config: { url: undefined } as { url?: string },
    });

    // `'url' in config` is true even when the value is undefined, which is the
    // only way a JSON body can say "clear this" — `patch.config.url === undefined`
    // could not tell it from an absent key.
    expect(patched?.configUrl).toBeNull();
  });

  it('answers the current row for an EMPTY patch rather than raising', async () => {
    // `db.update()` with no columns is a syntax error, and all three of the
    // source's `!== undefined` guards missing is a legitimate request.
    const row = await installMcpServer(
      db,
      newServer({ oxyUserId: 'mcpu-empty', name: 'empty-patch' }),
    );
    if (!row) throw new Error('install returned null');

    const patched = await updateMcpServer(db, row.id, 'mcpu-empty', {});
    expect(patched?.id).toBe(row.id);
  });

  it('refuses to patch another user\'s connector', async () => {
    const row = await installMcpServer(
      db,
      newServer({ oxyUserId: 'mcpu-owner', name: 'mine' }),
    );
    if (!row) throw new Error('install returned null');

    expect(await updateMcpServer(db, row.id, 'mcpu-intruder', { enabled: false })).toBeNull();
    // And the row is untouched, not merely unreported.
    expect((await findMcpServerForUser(db, row.id, 'mcpu-owner'))?.enabled).toBe(true);
  });
});

describe('a status write does not blank what the reply omitted', () => {
  it('keeps the last known tools when integrations answers without them', async () => {
    const row = await installMcpServer(
      db,
      newServer({ oxyUserId: 'mcpu-status', name: 'status-one' }),
    );
    if (!row) throw new Error('install returned null');

    await setMcpServerStatus(db, row.id, 'mcpu-status', {
      status: 'running',
      tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
    });
    const stopped = await setMcpServerStatus(db, row.id, 'mcpu-status', { status: 'stopped' });

    expect(stopped?.status).toBe('stopped');
    expect(stopped?.tools).toHaveLength(1);
    expect(stopped?.tools[0]?.name).toBe('search');
  });

  it('records the durable OAuth mark that a later start reads', async () => {
    const row = await installMcpServer(
      db,
      newServer({
        oxyUserId: 'mcpu-oauthmark',
        name: 'oauth-one',
        config: { url: 'https://x.test' },
      }),
    );
    if (!row) throw new Error('install returned null');
    expect(row.configRequiresOauth).toBeNull();

    const connected = await setMcpServerStatus(db, row.id, 'mcpu-oauthmark', {
      status: 'running',
      requiresOAuth: true,
    });
    expect(connected?.configRequiresOauth).toBe(true);
  });
});

describe('the chat tool builder sees only what it can dispatch to', () => {
  it('filters on all four predicates, not merely on enabled', async () => {
    const user = 'mcpu-runnable';
    const good = await installMcpServer(db, newServer({ oxyUserId: user, name: 'good' }));
    const local = await installMcpServer(
      db,
      newServer({ oxyUserId: user, name: 'local-one', runtime: 'local' }),
    );
    const off = await installMcpServer(db, newServer({ oxyUserId: user, name: 'disabled-one' }));
    const stopped = await installMcpServer(db, newServer({ oxyUserId: user, name: 'stopped-one' }));
    if (!good || !local || !off || !stopped) throw new Error('install returned null');

    await setMcpServerStatus(db, good.id, user, { status: 'running' });
    await setMcpServerStatus(db, local.id, user, { status: 'running' });
    await setMcpServerStatus(db, off.id, user, { status: 'running' });
    await updateMcpServer(db, off.id, user, { enabled: false });
    // `stopped-one` stays at its `installed` default.

    const runnable = await listRunnableMcpServersForUser(db, user);
    expect(runnable.map((s) => s.name)).toEqual(['good']);

    // A per-turn connector selection is an additional allow-list, never a way
    // around the ownership/runtime predicates above.
    expect((await listRunnableMcpServersForUser(db, user, good.id)).map((s) => s.id)).toEqual([good.id]);
    expect(await listRunnableMcpServersForUser(db, user, stopped.id)).toEqual([]);
    expect(await listRunnableMcpServersForUser(db, 'mcpu-someone-else', good.id)).toEqual([]);

    // Vacuity floor: the user really does own four connectors, so the single
    // result above is filtering rather than an empty table.
    const all = await listMcpServersForUser(db, user);
    expect(all).toHaveLength(4);
    // And newest first, as `sort({ createdAt: -1 })` was.
    expect(all[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(
      all[all.length - 1]?.createdAt.getTime() ?? 0,
    );
  });
});

describe('an id of any shape simply fails to match', () => {
  it('returns null rather than raising, which is a 404 instead of a 500', async () => {
    expect(await findMcpServerForUser(db, 'not-an-object-id', 'mcpu-1')).toBeNull();
    expect(await deleteMcpServerForUser(db, 'not-an-object-id', 'mcpu-1')).toBeNull();
  });

  it('deletes only the caller\'s own connector', async () => {
    const row = await installMcpServer(
      db,
      newServer({ oxyUserId: 'mcpu-del', name: 'delete-me' }),
    );
    if (!row) throw new Error('install returned null');

    expect(await deleteMcpServerForUser(db, row.id, 'mcpu-someone-else')).toBeNull();
    expect(await findMcpServerForUser(db, row.id, 'mcpu-del')).not.toBeNull();

    const deleted = await deleteMcpServerForUser(db, row.id, 'mcpu-del');
    expect(deleted?.id).toBe(row.id);
    expect(await findMcpServerForUser(db, row.id, 'mcpu-del')).toBeNull();
  });
});

describe('an OAuth state is a plaintext lookup key with a deadline', () => {
  it('is found by the token it was minted as', async () => {
    await createMcpOAuthState(db, {
      state: 'mcp-state-live',
      oxyUserId: 'mcpu-state',
      serverId: 'srv-x',
    });

    const row = await findLiveMcpOAuthState(db, 'mcp-state-live');
    expect(row?.oxyUserId).toBe('mcpu-state');
    expect(row?.serverId).toBe('srv-x');
  });

  it('is NOT returned once it is older than the TTL', async () => {
    /**
     * Expiry is the repository's decision, so both readers in `routes/mcp.ts`
     * get the same answer. `now` is a parameter rather than a sleep, which is
     * what lets this assert the boundary in both directions.
     */
    await createMcpOAuthState(db, {
      state: 'mcp-state-old',
      oxyUserId: 'mcpu-state',
      serverId: 'srv-x',
    });

    const justInside = new Date(Date.now() + (MCP_OAUTH_STATE_TTL_SECONDS - 5) * 1000);
    expect(await findLiveMcpOAuthState(db, 'mcp-state-old', justInside)).not.toBeNull();

    const pastIt = new Date(Date.now() + (MCP_OAUTH_STATE_TTL_SECONDS + 5) * 1000);
    expect(await findLiveMcpOAuthState(db, 'mcp-state-old', pastIt)).toBeNull();
  });

  it('is consumed by row id, and by token when the authorize never started', async () => {
    await createMcpOAuthState(db, {
      state: 'mcp-state-consume',
      oxyUserId: 'mcpu-state',
      serverId: 'srv-x',
    });
    const row = await findLiveMcpOAuthState(db, 'mcp-state-consume');
    if (!row) throw new Error('state not found');

    await deleteMcpOAuthState(db, row.id);
    expect(await findLiveMcpOAuthState(db, 'mcp-state-consume')).toBeNull();

    await createMcpOAuthState(db, {
      state: 'mcp-state-abandon',
      oxyUserId: 'mcpu-state',
      serverId: 'srv-x',
    });
    await deleteMcpOAuthStateByToken(db, 'mcp-state-abandon');
    expect(await findLiveMcpOAuthState(db, 'mcp-state-abandon')).toBeNull();
  });
});
