/**
 * Default subscription plans, for a database that has none.
 *
 * Idempotent by INSERT: re-running never overwrites a row that exists, and that
 * now includes `modelIds`. The header of this file used to say "uses
 * $setOnInsert for idempotency — re-running never overwrites admin edits",
 * which stopped being true at the Postgres port — `seedPlan` became an
 * `ON CONFLICT DO UPDATE` on `modelIds` — and nobody noticed, because nothing
 * calls this function. `db/billing/planRepository.ts` `seedPlan` is where the
 * correction lives and why it matters: `setPlanModelIds` is the authority for
 * which models a plan grants (#139 workstream 14), and a boot writer that
 * re-asserted the list would revert it on the next deploy.
 *
 * Features are managed through the Feature and PlanFeature tables
 * (see `internal/providers/lib/seed-features.ts`). This file seeds plan
 * metadata and the initial `modelIds` only.
 *
 * ## Why it lives in `lib/` and not under `internal/providers/`
 *
 * It never belonged there. It imports `@oxyhq/db`, `db/index.ts`,
 * `db/billing/planRepository.ts` and this package's logger — nothing from the
 * provider tree at all — so it was a billing seeder filed inside the subtree
 * ADR 0001 is emptying. Moving it is what lets `src/index.ts` call it at boot
 * without a product-module exemption on gate 1's allowlist, a list whose only
 * permitted direction is down. It now sits beside `seed-skills.ts`,
 * `seed-suggestions.ts` and `seed-bots.ts`, which is where the boot seeders are.
 */

import { isUniqueViolation } from '@oxyhq/db';
import { getDb } from '../db/index.js';
import { seedPlan } from '../db/billing/planRepository.js';
import type { ConfigAuditActor } from './security/config-audit.js';
import { log } from './logger.js';

/**
 * Named rather than defaulted, because `seedPlan` requires an actor and an
 * audit record that says `system` for every change is an audit record nobody
 * can act on. A plan created here was created by this module, at boot.
 */
const SEED_ACTOR: ConfigAuditActor = { kind: 'seed', id: 'lib/seed-plans.ts' };

interface PlanSeed {
  planId: string;
  name: string;
  product: 'alia' | 'codea';
  creditsPerMonth: number;
  dailyFreeCredits: number;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  subtitle: string;
  creditsLabel: string;
  isFeatured: boolean;
  sortOrder: number;
  isFree: boolean;
  modelIds: string[];
}

// ─── modelIds (cumulative) ─────────────────────────────────────────

const FREE_MODEL_IDS = ['alia-lite', 'alia-v1', 'alia-v1-audio'];
const GO_MODEL_IDS = [...FREE_MODEL_IDS, 'alia-v1-codea', 'alia-v1-vision', 'alia-v1-browser', 'alia-v1-cowork', 'alia-v1-multimodal', 'alia-v1-voice'];
const PRO_MODEL_IDS = [...GO_MODEL_IDS, 'alia-v1-pro', 'alia-v1-thinking', 'alia-v1-pro-max', 'alia-v1-voice-pro'];

// ─── Seed data ─────────────────────────────────────────────────────

/**
 * The model list each plan is SEEDED with, by plan id.
 *
 * Exported because `scripts/plan-models.ts` re-asserts it against a database
 * whose row was created before the list grew. Derived from `SEED_PLANS` below
 * rather than retyped: a second copy would be a second answer to "which models
 * does Ultra include", and the one in the database is already the stale answer
 * this exists to correct.
 */
export function seededModelIdsFor(planId: string): readonly string[] | null {
  return SEED_PLANS.find((plan) => plan.planId === planId)?.modelIds ?? null;
}

/** Every plan id this file seeds, for an operator listing what can be corrected. */
export function seededPlanIds(): readonly string[] {
  return SEED_PLANS.map((plan) => plan.planId);
}

const SEED_PLANS: PlanSeed[] = [
  // ─── Alia Plans ───────────────────────────────────────────
  {
    planId: 'free',
    name: 'Free',
    product: 'alia',
    creditsPerMonth: 0,
    dailyFreeCredits: 300,
    monthlyPrice: 0,
    annualPrice: 0,
    currency: 'usd',
    subtitle: 'subscribe.freeUsage',
    creditsLabel: '300 credits / day',
    isFeatured: false,
    sortOrder: 0,
    isFree: true,
    modelIds: FREE_MODEL_IDS,
  },
  {
    planId: 'go',
    name: 'Go',
    product: 'alia',
    creditsPerMonth: 4000,
    dailyFreeCredits: 300,
    monthlyPrice: 399,
    annualPrice: 3830,
    currency: 'usd',
    subtitle: 'subscribe.goUsage',
    creditsLabel: '4,000 credits / mo',
    isFeatured: false,
    sortOrder: 1,
    isFree: false,
    modelIds: GO_MODEL_IDS,
  },
  {
    planId: 'pro',
    name: 'Pro',
    product: 'alia',
    creditsPerMonth: 10000,
    dailyFreeCredits: 300,
    monthlyPrice: 999,
    annualPrice: 9590,
    currency: 'usd',
    subtitle: 'subscribe.proUsage',
    creditsLabel: '10,000 credits / mo',
    isFeatured: true,
    sortOrder: 2,
    isFree: false,
    modelIds: PRO_MODEL_IDS,
  },
  {
    planId: 'max',
    name: 'Max',
    product: 'alia',
    creditsPerMonth: 50000,
    dailyFreeCredits: 300,
    monthlyPrice: 4999,
    annualPrice: 47990,
    currency: 'usd',
    subtitle: 'subscribe.maxUsage',
    creditsLabel: '50,000 credits / mo',
    isFeatured: false,
    sortOrder: 3,
    isFree: false,
    modelIds: PRO_MODEL_IDS,
  },
  {
    planId: 'ultra',
    name: 'Ultra',
    product: 'alia',
    creditsPerMonth: 100000,
    dailyFreeCredits: 300,
    monthlyPrice: 9999,
    annualPrice: 95990,
    currency: 'usd',
    subtitle: 'subscribe.ultraUsage',
    creditsLabel: '100,000 credits / mo',
    isFeatured: false,
    sortOrder: 4,
    isFree: false,
    modelIds: PRO_MODEL_IDS,
  },

  // ─── Codea Plans ──────────────────────────────────────────
  {
    planId: 'codea-pro',
    name: 'Codea Pro',
    product: 'codea',
    creditsPerMonth: 10000,
    dailyFreeCredits: 300,
    monthlyPrice: 999,
    annualPrice: 9590,
    currency: 'usd',
    subtitle: 'subscribe.codeaProUsage',
    creditsLabel: '10,000 credits / mo',
    isFeatured: false,
    sortOrder: 0,
    isFree: false,
    modelIds: ['alia-v1-codea', 'alia-v1-pro', 'alia-v1-thinking'],
  },
  {
    planId: 'codea-max',
    name: 'Codea Max',
    product: 'codea',
    creditsPerMonth: 50000,
    dailyFreeCredits: 300,
    monthlyPrice: 4999,
    annualPrice: 47990,
    currency: 'usd',
    subtitle: 'subscribe.codeaMaxUsage',
    creditsLabel: '50,000 credits / mo',
    isFeatured: true,
    sortOrder: 1,
    isFree: false,
    modelIds: ['alia-v1-codea', 'alia-v1-pro', 'alia-v1-thinking'],
  },
];

export async function seedPlans(): Promise<{ seeded: number; skipped: number }> {
  const db = getDb();

  let seeded = 0;
  let skipped = 0;

  for (const planData of SEED_PLANS) {
    try {
      // Every field, including `modelIds`, is set only when the row is created.
      // A plan that exists is left exactly as it is.
      const result = await seedPlan(db, {
        planId: planData.planId,
        modelIds: planData.modelIds,
        name: planData.name,
        product: planData.product,
        creditsPerMonth: planData.creditsPerMonth,
        dailyFreeCredits: planData.dailyFreeCredits,
        monthlyPrice: planData.monthlyPrice,
        annualPrice: planData.annualPrice,
        currency: planData.currency,
        subtitle: planData.subtitle,
        creditsLabel: planData.creditsLabel,
        isFeatured: planData.isFeatured,
        sortOrder: planData.sortOrder,
        isFree: planData.isFree,
        isActive: true,
      }, SEED_ACTOR);

      if (result.inserted) {
        seeded++;
        log.seed.info({ planId: planData.planId, name: planData.name }, 'Created Plan');
      } else {
        skipped++;
      }
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        skipped++;
      } else {
        log.seed.error({ err: error, planId: planData.planId }, 'Error seeding plan');
      }
    }
  }

  log.seed.info({ seeded, skipped }, 'Plan seeding complete');
  return { seeded, skipped };
}
