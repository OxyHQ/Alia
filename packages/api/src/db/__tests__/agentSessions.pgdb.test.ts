import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  constraintNameOf,
  isCheckViolation,
  isUniqueViolation,
} from '@oxy.so/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agentReviews, agentSessions } from '../schema/agent-sessions';
import { agents } from '../schema/agents';

/**
 * Batch 9c against a REAL server.
 *
 * Deleting an agent cleans up nothing in Mongo today, so every child in this
 * batch had to answer that separately — and the answers are different. Each is
 * pinned here, because a deletion rule is invisible in a schema diff and its
 * damage is the kind nobody notices: a session that vanished, a review that
 * outlived its subject. (`agent_session_resources` and `container_templates`
 * left with the agent sandbox in `0073_drop_sandbox_containers`.)
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

function agentValues(overrides: Partial<typeof agents.$inferInsert> = {}) {
  return {
    oxyAccountId: `oxy-bot-sess-${Math.random().toString(36).slice(2, 10)}`,
    tagline: 't',
    description: 'd',
    authorOxyUserId: 'oxy-user-sessions',
    category: 'research',
    ...overrides,
  };
}

function sessionValues(overrides: Partial<typeof agentSessions.$inferInsert> = {}) {
  return {
    agentId: 'ag-sess',
    oxyUserId: 'oxy-user-sessions',
    task: 'find something out',
    ...overrides,
  };
}

describe('agent_sessions', () => {
  it('accepts a session naming an agent that does not exist', async () => {
    /**
     * The deliberate absence of a foreign key, and the one most likely to be
     * "fixed" on the way past. A session is the record of work a person asked
     * for and spent credits on — CASCADE deletes their history, `SET NULL` is
     * unrepresentable on a `notNull` column, and `RESTRICT` makes an agent
     * permanently undeletable once anybody has run it. The
     * `trigger_executions.trigger_id` case.
     */
    await db
      .insert(agentSessions)
      .values(sessionValues({ id: 'as-orphan', agentId: 'no-such-agent' }));

    const [row] = await db
      .select({ agentId: agentSessions.agentId })
      .from(agentSessions)
      .where(eq(agentSessions.id, 'as-orphan'));

    expect(row).toEqual({ agentId: 'no-such-agent' });
  });

  it('refuses HALF a plan', async () => {
    // Every writer sets and clears the plan as a unit (`todoManager.toJSON()`
    // produces both fields; `runner.ts:803` clears both), so unlike the
    // permission group on `agents` this cross-field rule is one the code keeps.
    const half = db.execute(sql`
      insert into ${agentSessions} (id, agent_id, oxy_user_id, task, plan_objective)
      values ('as-halfplan', 'ag-x', 'u', 't', 'ship it')
    `);

    await expect(half).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('agent_sessions_plan_shape_check');
      return true;
    });
  });

  it('stores a whole plan, and no plan at all', async () => {
    await db.insert(agentSessions).values(
      sessionValues({
        id: 'as-plan',
        planObjective: 'ship it',
        planItems: [{ id: 0, text: 'write it', status: 'pending' }],
      }),
    );
    await db.insert(agentSessions).values(sessionValues({ id: 'as-noplan' }));

    const rows = await db
      .select({ id: agentSessions.id, objective: agentSessions.planObjective })
      .from(agentSessions)
      .where(sql`${agentSessions.id} in ('as-plan', 'as-noplan')`);

    expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'as-noplan', objective: null },
      { id: 'as-plan', objective: 'ship it' },
    ]);
  });

  it('holds a token count past 2^31, and reads back as a NUMBER only through the builder', async () => {
    /**
     * `stats_total_tokens` accumulates across every step of a session, so
     * `integer` is not enough. The second half is the trap CONVENTIONS.md
     * records and `tsc` cannot see: `mode: 'number'` is applied by drizzle's
     * RESULT MAPPER, so a raw `db.execute` — which is how most of this suite
     * reads — hands back a STRING for the same column, while typing as a number.
     */
    const beyondInt4 = 4_294_967_296;
    await db
      .insert(agentSessions)
      .values(sessionValues({ id: 'as-tokens', statsTotalTokens: beyondInt4 }));

    const [built] = await db
      .select({ tokens: agentSessions.statsTotalTokens })
      .from(agentSessions)
      .where(eq(agentSessions.id, 'as-tokens'));
    expect(built?.tokens).toBe(beyondInt4);
    expect(typeof built?.tokens).toBe('number');

    const raw = await db.execute(
      sql`select stats_total_tokens from ${agentSessions} where id = 'as-tokens'`,
    );
    expect(raw[0]?.stats_total_tokens).toBe(String(beyondInt4));
    expect(typeof raw[0]?.stats_total_tokens).toBe('string');
  });

  it('really HAS the self-referencing foreign key, in the live catalogue', async () => {
    /**
     * `parent_session_id` is a SELF-reference, and drizzle-kit is known to drop
     * a circular foreign key SILENTLY — the declaration typechecks, no
     * `ADD CONSTRAINT` is emitted, nothing reaches the snapshot, and the column
     * enforces nothing while reading as correct. Measured in Mercaria on
     * `awin_advertisers.activating_sample_id`.
     *
     * It did NOT happen here, because the constraint is declared through the
     * table-level `foreignKey()` helper rather than a column-level
     * `references((): AnyPgColumn => …)`, and because it is a self-reference
     * within one table rather than a cycle between two. Both facts are easy to
     * lose in a later refactor, so this asserts the constraint against
     * `pg_constraint` — the only artefact that cannot be wrong about it.
     *
     * The behavioural case below would also go red (verified by deleting the
     * `ADD CONSTRAINT` statement outright), but it would fail as a puzzling
     * difference in deletion behaviour. This one fails naming the constraint.
     */
    const rows = await db.execute(sql`
      select conname, confdeltype
      from pg_constraint
      where conname = 'agent_sessions_parent_session_id_fk' and contype = 'f'
    `);

    expect(rows.length).toBe(1);
    // 'n' is SET NULL. 'c' would be CASCADE, 'a' NO ACTION.
    expect(rows[0]?.confdeltype).toBe('n');
  });

  it('detaches a child session when its PARENT is deleted, rather than deleting it', async () => {
    await db.insert(agentSessions).values(sessionValues({ id: 'as-parent' }));
    await db
      .insert(agentSessions)
      .values(sessionValues({ id: 'as-child', parentSessionId: 'as-parent', depth: 1 }));

    await db.delete(agentSessions).where(eq(agentSessions.id, 'as-parent'));

    const [child] = await db
      .select({ id: agentSessions.id, parent: agentSessions.parentSessionId })
      .from(agentSessions)
      .where(eq(agentSessions.id, 'as-child'));
    // The delegated run survives; it just stops claiming a parent that is gone.
    expect(child).toEqual({ id: 'as-child', parent: null });
  });
});

describe('agent_reviews', () => {
  it('bounds the rating 1..5 — NOT 0..5, unlike the agent average', async () => {
    /**
     * `AgentReview.rating` is `min: 1` and `Agent.rating` is `min: 0`. That is
     * not an inconsistency to unify: a review is somebody's 1-to-5 score, while
     * the agent's is an AVERAGE that is legitimately 0 when nobody has reviewed
     * it. Collapsing them either admits a 0-star review or refuses every agent
     * that has none.
     */
    await db.insert(agents).values(agentValues({ id: 'ag-rev' }));

    const zero = db.execute(sql`
      insert into ${agentReviews} (id, agent_id, oxy_user_id, rating)
      values ('ar-zero', 'ag-rev', 'oxy-user-a', 0)
    `);
    await expect(zero).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('agent_reviews_rating_range_check');
      return true;
    });

    // The agent's own average may be 0, and is by default.
    const [agent] = await db
      .select({ rating: agents.rating })
      .from(agents)
      .where(eq(agents.id, 'ag-rev'));
    expect(agent).toEqual({ rating: 0 });
  });

  it('allows one review per account per agent, and a SECOND account on the same agent', async () => {
    await db.insert(agents).values(agentValues({ id: 'ag-onereview' }));
    await db
      .insert(agentReviews)
      .values({ id: 'ar-1', agentId: 'ag-onereview', oxyUserId: 'oxy-a', rating: 5 });

    const sameUser = db
      .insert(agentReviews)
      .values({ id: 'ar-1b', agentId: 'ag-onereview', oxyUserId: 'oxy-a', rating: 4 });
    await expect(sameUser).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('agent_reviews_agent_user_key');
      return true;
    });

    // The grain's other half: a different account reviewing the same agent is
    // the ordinary case, and a unique on `agent_id` alone would refuse it.
    await db
      .insert(agentReviews)
      .values({ id: 'ar-2', agentId: 'ag-onereview', oxyUserId: 'oxy-b', rating: 3 });
    const rows = await db
      .select({ oxyUserId: agentReviews.oxyUserId })
      .from(agentReviews)
      .where(eq(agentReviews.agentId, 'ag-onereview'));
    expect(rows.map((r) => r.oxyUserId).sort()).toEqual(['oxy-a', 'oxy-b']);
  });

  it('goes with the agent, because its whole content is an opinion of one', async () => {
    await db.insert(agents).values(agentValues({ id: 'ag-revdoomed' }));
    await db
      .insert(agentReviews)
      .values({ id: 'ar-doomed', agentId: 'ag-revdoomed', oxyUserId: 'oxy-c', rating: 2 });

    await db.delete(agents).where(eq(agents.id, 'ag-revdoomed'));

    const rows = await db
      .select({ id: agentReviews.id })
      .from(agentReviews)
      .where(eq(agentReviews.id, 'ar-doomed'));
    expect(rows).toEqual([]);
  });
});

