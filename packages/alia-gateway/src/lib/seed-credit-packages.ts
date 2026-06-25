/**
 * Seed CreditPackage collection with default credit purchase packages.
 * Uses $setOnInsert for idempotency — re-running never overwrites admin edits.
 */

import { CreditPackage } from '../models/credit-package.js';
import { errorCode } from './error-handler';
import { connectDB } from './db';
import { log } from './logger';

interface CreditPackageSeed {
  packageId: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
  sortOrder: number;
}

const SEED_PACKAGES: CreditPackageSeed[] = [
  { packageId: 'credits_1000', name: '1,000 Credits', credits: 1000, price: 500, currency: 'usd', sortOrder: 0 },
  { packageId: 'credits_5000', name: '5,000 Credits', credits: 5000, price: 2000, currency: 'usd', sortOrder: 1 },
  { packageId: 'credits_10000', name: '10,000 Credits', credits: 10000, price: 3500, currency: 'usd', sortOrder: 2 },
  { packageId: 'credits_50000', name: '50,000 Credits', credits: 50000, price: 15000, currency: 'usd', sortOrder: 3 },
];

export async function seedCreditPackages(): Promise<{ seeded: number; skipped: number }> {
  await connectDB();

  let seeded = 0;
  let skipped = 0;

  for (const pkgData of SEED_PACKAGES) {
    try {
      const result = await CreditPackage.updateOne(
        { packageId: pkgData.packageId },
        {
          $setOnInsert: {
            name: pkgData.name,
            credits: pkgData.credits,
            price: pkgData.price,
            currency: pkgData.currency,
            sortOrder: pkgData.sortOrder,
            isActive: true,
          },
        },
        { upsert: true }
      );

      if (result.upsertedCount > 0) {
        seeded++;
        log.seed.info({ packageId: pkgData.packageId }, 'Created CreditPackage');
      } else {
        skipped++;
      }
    } catch (error: unknown) {
      if (errorCode(error) === 11000) {
        skipped++;
      } else {
        log.seed.error({ err: error, packageId: pkgData.packageId }, 'Error seeding credit package');
      }
    }
  }

  log.seed.info({ seeded, skipped }, 'CreditPackage seeding complete');
  return { seeded, skipped };
}
