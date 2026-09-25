/**
 * Default subscription plans, for a database that has none.
 *
 * Idempotent by INSERT: re-running never overwrites a row that exists.
 *
 * Plans carry no model list: every plan sees every model in the catalogue and
 * plans differ only by credits (ADR 0012). Features are managed through the
 * Feature and PlanFeature tables (see `internal/providers/lib/seed-features.ts`).
 * This file seeds plan metadata only.
 *
 * ## Why it lives in `lib/` and not under `internal/providers/`
 *
 * It never belonged there. It imports `@oxy.so/db`, `db/index.ts`,
 * `db/billing/planRepository.ts` and this package's logger — nothing from the
 * provider tree at all — so it was a billing seeder filed inside the subtree
 * ADR 0001 is emptying. Moving it is what lets `src/index.ts` call it at boot
 * without a product-module exemption on gate 1's allowlist, a list whose only
 * permitted direction is down. It now sits beside `skills/seed.ts` and
 * `seed-suggestions.ts`, which is where the other seeders are.
 */

import { isUniqueViolation } from '@oxy.so/db';
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
  product: 'alia';
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
}

// ─── Seed data ─────────────────────────────────────────────────────

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
  },
  // No Codea plans: every plan includes programming (drizzle/0075 retired them).
];

export async function seedPlans(): Promise<{ seeded: number; skipped: number }> {
  const db = getDb();

  let seeded = 0;
  let skipped = 0;

  for (const planData of SEED_PLANS) {
    try {
      // Every field is set only when the row is created.
      // A plan that exists is left exactly as it is.
      const result = await seedPlan(db, {
        planId: planData.planId,
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
