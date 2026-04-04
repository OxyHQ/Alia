/**
 * Seed Plan collection with default subscription plans.
 * Uses $setOnInsert for idempotency — re-running never overwrites admin edits.
 *
 * Features are now managed via the Feature + PlanFeature collections
 * (see seed-features.ts). This file only seeds plan metadata and modelIds.
 */

import { Plan } from '../models/plan.js';
import { connectDB } from './db.js';
import { log } from '../../../lib/logger.js';
import { isDuplicateKeyError } from '../../../lib/errors/index.js';

interface PlanSeed {
  planId: string;
  name: string;
  product: 'clarity' | 'codea';
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

const FREE_MODEL_IDS = ['clarity-fast', 'clarity-v1', 'clarity-v1'];
const GO_MODEL_IDS = [...FREE_MODEL_IDS, 'clarity-v1', 'clarity-v1', 'clarity-v1', 'clarity-v1', 'clarity-v1', 'clarity-v1'];
const PRO_MODEL_IDS = [...GO_MODEL_IDS, 'clarity-pro', 'clarity-thinking', 'clarity-pro-max', 'clarity-pro'];

// ─── Seed data ─────────────────────────────────────────────────────

const SEED_PLANS: PlanSeed[] = [
  // ─── Clarity Plans ───────────────────────────────────────────
  {
    planId: 'free',
    name: 'Free',
    product: 'clarity',
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
    product: 'clarity',
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
    product: 'clarity',
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
    product: 'clarity',
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
    product: 'clarity',
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
    modelIds: ['clarity-v1', 'clarity-pro', 'clarity-thinking'],
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
    modelIds: ['clarity-v1', 'clarity-pro', 'clarity-thinking'],
  },
];

export async function seedPlans(): Promise<{ seeded: number; skipped: number }> {
  await connectDB();

  let seeded = 0;
  let skipped = 0;

  for (const planData of SEED_PLANS) {
    try {
      const result = await Plan.updateOne(
        { planId: planData.planId },
        {
          // Always sync modelIds from seed (code-managed)
          $set: {
            modelIds: planData.modelIds,
          },
          // Only set other fields on first insert (admin-managed)
          $setOnInsert: {
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
          },
        },
        { upsert: true }
      );

      if (result.upsertedCount > 0) {
        seeded++;
        log.seed.info({ planId: planData.planId, name: planData.name }, 'Created Plan');
      } else {
        skipped++;
      }
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        skipped++;
      } else {
        log.seed.error({ err: error, planId: planData.planId }, 'Error seeding plan');
      }
    }
  }

  log.seed.info({ seeded, skipped }, 'Plan seeding complete');
  return { seeded, skipped };
}
