/** Period-scoped Oxy product allowance, never merged into purchased credits. */
import { sql } from 'drizzle-orm';
import { pgTable, text, integer, boolean, check } from 'drizzle-orm/pg-core';
import { timestamptz } from '@oxy.so/db';
export const productCreditAllocations = pgTable(
  'product_credit_allocations',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    productId: text().notNull(),
    segmentId: text().notNull(),
    offerId: text().notNull(),
    offerVersion: integer().notNull(),
    quotaKey: text().notNull(),
    unit: text().notNull(),
    periodStart: timestamptz().notNull(),
    periodEnd: timestamptz().notNull(),
    included: integer().notNull(),
    consumed: integer().notNull().default(0),
    reserved: integer().notNull().default(0),
    active: boolean().notNull().default(true),
  },
  (t) => [
    check(
      'product_credit_allocation_conservation',
      sql`${t.included} >= 0 AND ${t.consumed} >= 0 AND ${t.reserved} >= 0 AND ${t.consumed} + ${t.reserved} <= ${t.included}`,
    ),
    check('product_credit_allocation_period', sql`${t.periodEnd} > ${t.periodStart}`),
  ],
);
