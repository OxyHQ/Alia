import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation } from '@oxyhq/db';
import { sweepAllExpiredRows } from '@oxyhq/db/expiry';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { EXPIRY_TARGETS } from '../expiryTargets';
import { learningRules, rollbackRecords, skills } from '../schema/agents-support';

/**
 * Batch 9a against a REAL server.
 *
 * Most of what is here defends a decision NOT to constrain something, which is
 * the only kind of decision a later reader is likely to undo on the way past:
 * an unbounded `priority`, a dangling `session_id`, and a deadline column with
 * no sweep behind it all look like oversights and are not. Each has a fixture
 * that goes red if somebody "fixes" it.
 *
 * A mocked insert cannot make any of these assertions — a CHECK, a unique index
 * and a column default have no mocked counterpart, and the expiry sweep needs a
 * real DELETE to prove it did nothing.
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

function skillValues(overrides: Partial<typeof skills.$inferInsert> = {}) {
  return {
    skillId: 'skill-a',
    title: 'A skill',
    tagline: 'does a thing',
    description: 'a longer description',
    systemPrompt: 'you are a thing-doer',
    author: 'Alia',
    icon: 'sparkles',
    color: '#123456',
    category: 'featured' as const,
    ...overrides,
  };
}

describe('skills', () => {
  it('closes the category set, naming the constraint', async () => {
    const insert = db.execute(sql`
      insert into ${skills} (id, skill_id, title, tagline, description, system_prompt, author, icon, color, category)
      values ('sk-badcat', 'skill-badcat', 'T', 'L', 'D', 'P', 'Alia', 'i', '#000', 'trending')
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('skills_category_check');
      return true;
    });
  });

  it('refuses a duplicate skill_id, which is the seed upsert key', async () => {
    await db.insert(skills).values(skillValues({ id: 'sk-1', skillId: 'skill-dup' }));

    const second = db.insert(skills).values(skillValues({ id: 'sk-2', skillId: 'skill-dup' }));

    await expect(second).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('skills_skill_id_key');
      return true;
    });
  });

  it('gives every string array an empty default rather than NULL', async () => {
    /**
     * Mongoose returns `[]` for an absent array field on every read, so every
     * caller does `.map()`/`.length` on these without a guard. A nullable column
     * would hand those callers a null the day a row was written without the key
     * — a crash in the read path, not a storage problem.
     */
    await db.insert(skills).values(skillValues({ id: 'sk-arrays', skillId: 'skill-arrays' }));

    const [row] = await db
      .select({
        triggers: skills.triggers,
        includes: skills.includes,
        goodAt: skills.goodAt,
        notGoodAt: skills.notGoodAt,
        useCase: skills.useCase,
      })
      .from(skills)
      .where(eq(skills.id, 'sk-arrays'));

    expect(row).toEqual({
      triggers: [],
      includes: [],
      goodAt: [],
      notGoodAt: [],
      // Nullable on purpose: "never filled in" must stay tellable apart from
      // "deliberately blank", so no empty-string default.
      useCase: null,
    });
  });

  it('stores an author with no account behind it', async () => {
    /**
     * `skills.author` is a DISPLAY STRING — `lib/seed-skills.ts` writes `'Alia'`
     * and `'Community'` — while `agents.author` one table over is an Oxy account
     * id. This fixture is the built-in case that makes the two impossible to
     * conflate: a required author, and no account at all.
     */
    await db
      .insert(skills)
      .values(skillValues({ id: 'sk-builtin', skillId: 'skill-builtin', author: 'Alia' }));

    const [row] = await db
      .select({ author: skills.author, oxyUserId: skills.oxyUserId, isBuiltIn: skills.isBuiltIn })
      .from(skills)
      .where(eq(skills.id, 'sk-builtin'));

    expect(row).toEqual({ author: 'Alia', oxyUserId: null, isBuiltIn: true });
  });
});

describe('learning_rules', () => {
  function ruleValues(overrides: Partial<typeof learningRules.$inferInsert> = {}) {
    return {
      oxyUserId: 'oxy-user-lr',
      ruleType: 'correction' as const,
      title: 'A rule',
      ruleText: 'always do the thing',
      ...overrides,
    };
  }

  it('closes rule_type and source', async () => {
    const badType = db.execute(sql`
      insert into ${learningRules} (id, oxy_user_id, rule_type, title, rule_text)
      values ('lr-badtype', 'oxy-user-lr', 'vibes', 'T', 'R')
    `);
    await expect(badType).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('learning_rules_rule_type_check');
      return true;
    });

    const badSource = db.execute(sql`
      insert into ${learningRules} (id, oxy_user_id, rule_type, title, rule_text, source)
      values ('lr-badsrc', 'oxy-user-lr', 'correction', 'T', 'R', 'telepathy')
    `);
    await expect(badSource).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('learning_rules_source_check');
      return true;
    });
  });

  it('leaves priority and hit_count UNBOUNDED, on purpose', async () => {
    /**
     * The self-defending fixture. `priority` reads like a 0..100 and `hit_count`
     * like a non-negative, so both invite an obvious CHECK on the way past —
     * and Mongoose declares no `min`/`max` on either, so production may already
     * hold anything. CONVENTIONS.md's third class: where the source constrained
     * nothing, neither does this schema. Adding either constraint turns this
     * red instead of failing on somebody's row.
     */
    await db
      .insert(learningRules)
      .values(ruleValues({ id: 'lr-extreme', priority: 9999, hitCount: -3 }));

    const [row] = await db
      .select({ priority: learningRules.priority, hitCount: learningRules.hitCount })
      .from(learningRules)
      .where(eq(learningRules.id, 'lr-extreme'));

    expect(row).toEqual({ priority: 9999, hitCount: -3 });
  });
});

describe('rollback_records', () => {
  function rollbackValues(overrides: Partial<typeof rollbackRecords.$inferInsert> = {}) {
    return {
      oxyUserId: 'oxy-user-rb',
      sessionId: '507f1f77bcf86cd799439011',
      toolName: 'shell',
      args: { command: 'rm -rf ./build' },
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      executedAt: new Date(),
      ...overrides,
    };
  }

  it('closes risk_level and status', async () => {
    const badRisk = db.execute(sql`
      insert into ${rollbackRecords} (id, oxy_user_id, session_id, tool_name, risk_level, args, expires_at, executed_at)
      values ('rb-badrisk', 'oxy-user-rb', 'sess-1', 'shell', 'R2', '{}'::jsonb, now(), now())
    `);
    await expect(badRisk).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('rollback_records_risk_level_check');
      return true;
    });

    const badStatus = db.execute(sql`
      insert into ${rollbackRecords} (id, oxy_user_id, session_id, tool_name, args, status, expires_at, executed_at)
      values ('rb-badstatus', 'oxy-user-rb', 'sess-1', 'shell', '{}'::jsonb, 'undone', now(), now())
    `);
    await expect(badStatus).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('rollback_records_status_check');
      return true;
    });
  });

  it('accepts a session_id no session row will ever match', async () => {
    /**
     * The deliberate absence of a foreign key. `session_id` really does name an
     * `agent_sessions` row (`lib/agent/actions.ts:399` writes
     * `session._id.toString()`), and this is a safety audit of what an agent
     * DID: the `api_usage.key_id` reasoning applies unchanged, so the id is
     * allowed to dangle. Adding the FK in batch 9c or 9d turns this red rather
     * than failing a write in the governance path.
     */
    await db
      .insert(rollbackRecords)
      .values(rollbackValues({ id: 'rb-orphan', sessionId: 'no-such-session-ever' }));

    const [row] = await db
      .select({ sessionId: rollbackRecords.sessionId })
      .from(rollbackRecords)
      .where(eq(rollbackRecords.id, 'rb-orphan'));

    expect(row).toEqual({ sessionId: 'no-such-session-ever' });
  });

  it('is NOT swept, however long ago expires_at passed', async () => {
    /**
     * The one that would cost real data. Mongoose declares `expiresAt` as
     * `required, index: true` and NOT `expireAfterSeconds` — it bounds the
     * rollback WINDOW, not the row's life — so `db/expiryTargets.ts` gets no
     * entry for this table and these records accumulate exactly as they do in
     * Mongo. A registry entry added on the strength of the column's name would
     * delete a destructive-action audit trail silently.
     *
     * In a transaction because vitest runs FILES in parallel against ONE
     * database and four of them call the sweep with the FULL registry: an
     * uncommitted row is invisible to every other connection, while this
     * transaction's own sweep still sees it. What is asserted is survival, so
     * the count assertion the other files need does not apply — the row either
     * is there afterwards or it is not.
     */
    await db.transaction(async (tx) => {
      await tx.insert(rollbackRecords).values(
        rollbackValues({
          id: 'rb-ancient',
          expiresAt: new Date('2020-01-01T00:00:00.000Z'),
          executedAt: new Date('2020-01-01T00:00:00.000Z'),
        }),
      );

      await sweepAllExpiredRows(tx, EXPIRY_TARGETS);

      const [row] = await tx
        .select({ id: rollbackRecords.id })
        .from(rollbackRecords)
        .where(eq(rollbackRecords.id, 'rb-ancient'));

      expect(row).toEqual({ id: 'rb-ancient' });
    });
  });
});
