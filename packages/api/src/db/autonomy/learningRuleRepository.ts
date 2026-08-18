/**
 * The rules the assistant has learned about one account.
 *
 * One table, one consumer: `lib/autonomy/context-graph.ts` reads them into a
 * recall result and writes one when a user corrects the assistant. It sits
 * beside `contextGraphRepository.ts` because that file's header already named
 * this table as the last thing keeping `mongoose` in `context-graph.ts`.
 */

import { and, desc, eq, or } from 'drizzle-orm';
import type { LearningRuleSource, LearningRuleType } from '../../domain/learning-rule.js';
import type { ApiDatabase } from '../index';
import { learningRules } from '../schema/agents-support';

/** How many rules one recall injects. The source's `.limit(8)`. */
const RECALL_LIMIT = 8;

export interface RecalledLearningRule {
  readonly id: string;
  readonly priority: number;
  readonly ruleText: string;
  readonly ruleType: string;
}

/**
 * This account's active rules for one intent, best first.
 *
 * The `or` is the source's `$or: [{intent}, {intent: 'general'}]` — an intent's
 * own rules PLUS the ones that apply everywhere. Written as two equalities
 * rather than `inArray([intent, 'general'])` because the two collapse to one
 * value when the intent IS `'general'`: `in ('general', 'general')` is harmless
 * today, and it is the shape that starts mattering the moment somebody builds
 * the list from a variable and it comes back empty — `in ()` is a syntax error
 * and `inArray` with an empty array silently matches nothing.
 *
 * `priority DESC, updated_at DESC` is `learning_rules_lookup_idx`'s leading
 * order for the first key. The tiebreak is the source's and means "the most
 * recently reinforced rule of equal priority wins".
 */
export async function findActiveLearningRules(
  db: ApiDatabase,
  oxyUserId: string,
  intent: string,
): Promise<RecalledLearningRule[]> {
  return db
    .select({
      id: learningRules.id,
      priority: learningRules.priority,
      ruleText: learningRules.ruleText,
      ruleType: learningRules.ruleType,
    })
    .from(learningRules)
    .where(
      and(
        eq(learningRules.oxyUserId, oxyUserId),
        eq(learningRules.active, true),
        or(eq(learningRules.intent, intent), eq(learningRules.intent, 'general')),
      ),
    )
    .orderBy(desc(learningRules.priority), desc(learningRules.updatedAt))
    .limit(RECALL_LIMIT);
}

export interface NewLearningRule {
  readonly oxyUserId: string;
  readonly intent: string;
  readonly ruleType: LearningRuleType;
  readonly priority: number;
  readonly title: string;
  readonly ruleText: string;
  readonly source: LearningRuleSource;
}

/**
 * Record a rule.
 *
 * `active: true` is written rather than left to the column default, because the
 * caller's own `LearningRule.create({ active: true })` said so and a default is
 * a different fact from an instruction. There is no dedup: the source created a
 * row per correction and two identical corrections are two pieces of evidence.
 */
export async function createLearningRule(
  db: ApiDatabase,
  input: NewLearningRule,
): Promise<void> {
  await db.insert(learningRules).values({ ...input, active: true });
}
