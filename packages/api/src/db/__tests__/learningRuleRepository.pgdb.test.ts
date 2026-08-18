import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  createLearningRule,
  findActiveLearningRules,
} from '../autonomy/learningRuleRepository';
import { learningRules } from '../schema/agents-support';

/**
 * The learning-rule repository against a real server.
 *
 * The read is the interesting half: it is an `or` over two intents, an active
 * filter, a two-column ordering and a limit, and every one of those four is a
 * separate way to return something PLAUSIBLE. So each is asserted with the row
 * that would be wrong beside the rows that are right.
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

async function rule(
  oxyUserId: string,
  title: string,
  overrides: Partial<Parameters<typeof createLearningRule>[1]> = {},
): Promise<void> {
  await createLearningRule(db, {
    oxyUserId,
    intent: 'research',
    ruleType: 'correction',
    priority: 50,
    title,
    ruleText: `rule text for ${title}`,
    source: 'user_feedback',
    ...overrides,
  });
}

describe('recalling rules', () => {
  const OWNER = 'lrr-owner';

  it('returns the intent\'s own rules AND the general ones, and nobody else\'s', async () => {
    await rule(OWNER, 'for-research', { intent: 'research' });
    await rule(OWNER, 'for-everything', { intent: 'general' });
    await rule(OWNER, 'for-another-intent', { intent: 'meeting_prep' });
    await rule('lrr-stranger', 'not-yours', { intent: 'research' });

    const texts = (await findActiveLearningRules(db, OWNER, 'research')).map((r) => r.ruleText);
    expect(texts).toContain('rule text for for-research');
    expect(texts).toContain('rule text for for-everything');
    // The two that must not be there. Without them the `or` could be `true` and
    // the owner filter could be missing, and every assertion above still passes.
    expect(texts).not.toContain('rule text for for-another-intent');
    expect(texts).not.toContain('rule text for not-yours');
  });

  it('collapses to ONE arm when the intent IS general, without matching everything', async () => {
    const GENERAL = 'lrr-general-owner';
    await rule(GENERAL, 'general-rule', { intent: 'general' });
    await rule(GENERAL, 'research-rule', { intent: 'research' });

    const texts = (await findActiveLearningRules(db, GENERAL, 'general')).map((r) => r.ruleText);
    expect(texts).toEqual(['rule text for general-rule']);
  });

  it('omits an INACTIVE rule', async () => {
    const OFF = 'lrr-inactive-owner';
    await rule(OFF, 'live', { intent: 'research' });
    await rule(OFF, 'retired', { intent: 'research' });
    await db
      .update(learningRules)
      .set({ active: false })
      .where(eq(learningRules.title, 'retired'));

    const texts = (await findActiveLearningRules(db, OFF, 'research')).map((r) => r.ruleText);
    expect(texts).toEqual(['rule text for live']);
  });

  it('orders by priority DESC, then by the most recently reinforced', async () => {
    const ORDER = 'lrr-order-owner';
    await rule(ORDER, 'low', { priority: 10 });
    await rule(ORDER, 'high', { priority: 100 });
    await rule(ORDER, 'tie-old', { priority: 50 });
    await rule(ORDER, 'tie-new', { priority: 50 });
    // The tiebreak only means anything if the two differ, and both rows were
    // written in the same millisecond.
    await db
      .update(learningRules)
      .set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(learningRules.title, 'tie-old'));

    const titles = (await findActiveLearningRules(db, ORDER, 'research')).map((r) =>
      r.ruleText.replace('rule text for ', ''),
    );
    expect(titles).toEqual(['high', 'tie-new', 'tie-old', 'low']);
  });

  it('injects at most eight rules, taking the highest priorities', async () => {
    const MANY = 'lrr-many-owner';
    for (let i = 0; i < 12; i += 1) {
      await rule(MANY, `p${i}`, { priority: i });
    }

    const rows = await findActiveLearningRules(db, MANY, 'research');
    expect(rows.length).toBe(8);
    // Which eight, not just how many: a limit applied before the sort would give
    // eight arbitrary rules and pass a count-only assertion.
    expect(rows.map((r) => r.priority)).toEqual([11, 10, 9, 8, 7, 6, 5, 4]);
  });

  it('returns an id the caller can quote back, not a document', async () => {
    const ID = 'lrr-id-owner';
    await rule(ID, 'has-an-id');
    const [row] = await findActiveLearningRules(db, ID, 'research');
    expect(typeof row?.id).toBe('string');
    expect(row?.id.length).toBeGreaterThan(0);
    // The recall projection is exactly the four fields `context-graph.ts` maps.
    expect(Object.keys(row ?? {}).sort()).toEqual(['id', 'priority', 'ruleText', 'ruleType']);
  });
});

describe('recording a correction', () => {
  it('writes an ACTIVE rule and does not deduplicate two identical ones', async () => {
    /**
     * The source created a row per correction. Two identical corrections are two
     * pieces of evidence that the assistant got the same thing wrong twice, so a
     * unique constraint or an upsert here would destroy the signal.
     */
    const DUP = 'lrr-dup-owner';
    await rule(DUP, 'same', { intent: 'research' });
    await rule(DUP, 'same', { intent: 'research' });

    const rows = await db.select().from(learningRules).where(eq(learningRules.oxyUserId, DUP));
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.active)).toBe(true);
    expect(rows.every((r) => r.hitCount === 0)).toBe(true);
    expect(rows.every((r) => r.lastAppliedAt === null)).toBe(true);
  });
});
