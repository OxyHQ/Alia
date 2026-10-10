/** Admission prices and turn charges, separate from Oxy's technical ledger. */
import { productCreditAllocations } from './product-credit-allocations';
import { sql } from 'drizzle-orm';
import { pgTable, text, integer, numeric, primaryKey, check, index } from 'drizzle-orm/pg-core';
import { timestamptz, generatedId } from '@oxy.so/db';
import { checkOneOf } from './columns';
import { CREDIT_FUNDING_SOURCES } from '../../domain/credit-funding';
import {
  CREDIT_OPERATION_STATUSES,
  CREDIT_PRICING_RULES,
  CREDIT_PRICE_BOOK_SOURCES,
} from '../../domain/credit-operation';

export const creditPriceBooks = pgTable(
  'credit_price_books',
  {
    id: text().primaryKey(),
    source: text({ enum: CREDIT_PRICE_BOOK_SOURCES }).notNull(),
    formulaVersion: text().notNull(),
    fallbackRule: text().notNull(),
    roundingScale: integer().notNull(),
    usdPerCredit: numeric().notNull(),
    tokensPerCredit: integer().notNull(),
    minimumCredits: integer().notNull(),
    initialReservation: integer().notNull(),
    capturedAt: timestamptz().notNull(),
  },
  (t) => [
    checkOneOf('credit_price_books_source_check', t.source, CREDIT_PRICE_BOOK_SOURCES),
    check(
      'credit_price_books_terms_check',
      sql`${t.roundingScale} > 0 AND ${t.usdPerCredit} > 0 AND ${t.tokensPerCredit} > 0 AND ${t.minimumCredits} > 0 AND ${t.initialReservation} > 0`,
    ),
  ],
);
export const creditPriceBookModels = pgTable(
  'credit_price_book_models',
  {
    bookId: text()
      .notNull()
      .references(() => creditPriceBooks.id, { onDelete: 'restrict' }),
    modelId: text().notNull(),
    inputPerMTok: numeric(),
    outputPerMTok: numeric(),
    priceVersionId: text(),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.modelId] }),
    check(
      'credit_price_book_models_prices_check',
      sql`(${t.inputPerMTok} IS NULL AND ${t.outputPerMTok} IS NULL) OR (${t.inputPerMTok} >= 0 AND ${t.outputPerMTok} >= 0 AND ${t.inputPerMTok} IS NOT NULL AND ${t.outputPerMTok} IS NOT NULL)`,
    ),
  ],
);
export const creditOperations = pgTable(
  'credit_operations',
  {
    id: generatedId(),
    userId: text().notNull(),
    productAllocationId: text().references(() => productCreditAllocations.id, {
      onDelete: 'restrict',
    }),
    bookId: text()
      .notNull()
      .references(() => creditPriceBooks.id, { onDelete: 'restrict' }),
    aliaRequestId: text().unique('credit_operations_alia_request_id_key'),
    requestedModel: text().notNull(),
    capturedAt: timestamptz().notNull(),
    status: text({ enum: CREDIT_OPERATION_STATUSES }).notNull(),
    grantKind: text({ enum: CREDIT_FUNDING_SOURCES }).notNull(),
    initialFreeCredits: integer().notNull(),
    initialPaidCredits: integer().notNull(),
    creditsReserved: integer().notNull(),
    creditsRequested: integer(),
    creditsCharged: integer(),
    servedModelId: text(),
    pricingRule: text({ enum: CREDIT_PRICING_RULES }),
    promptTokens: integer(),
    completionTokens: integer(),
    totalTokens: integer(),
    systemPromptTokens: integer(),
    reasoningTokens: integer(),
    settledAt: timestamptz(),
  },
  (t) => [
    index('credit_operations_user_idx').on(t.userId, t.capturedAt),
    check(
      'credit_operations_funding_check',
      sql`${t.grantKind} IN ('free_allowance', 'paid_balance', 'product_allowance') AND ${t.initialFreeCredits} >= 0 AND ${t.initialPaidCredits} >= 0`,
    ),
    check(
      'credit_operation_product_source',
      sql`(${t.grantKind} = 'product_allowance' AND ${t.productAllocationId} IS NOT NULL) OR (${t.grantKind} <> 'product_allowance' AND ${t.productAllocationId} IS NULL)`,
    ),
    check(
      'credit_operations_terminal_check',
      sql`(${t.status} = 'admitted' AND ${t.settledAt} IS NULL AND ${t.creditsRequested} IS NULL AND ${t.creditsCharged} IS NULL) OR (${t.status} IN ('settled', 'refunded') AND ${t.settledAt} IS NOT NULL AND ${t.creditsRequested} IS NOT NULL AND ${t.creditsCharged} IS NOT NULL)`,
    ),
    checkOneOf('credit_operations_status_check', t.status, CREDIT_OPERATION_STATUSES),
    checkOneOf('credit_operations_pricing_rule_check', t.pricingRule, CREDIT_PRICING_RULES),
    checkOneOf('credit_operations_grant_kind_check', t.grantKind, CREDIT_FUNDING_SOURCES),
    check(
      'credit_operations_charge_check',
      sql`${t.creditsReserved} > 0 AND (${t.creditsRequested} IS NULL OR ${t.creditsRequested} >= 0) AND (${t.creditsCharged} IS NULL OR ${t.creditsCharged} >= 0)`,
    ),
  ],
);
export const creditOperationRequests = pgTable(
  'credit_operation_requests',
  {
    operationId: text()
      .notNull()
      .references(() => creditOperations.id, { onDelete: 'restrict' }),
    requestId: text().primaryKey(),
    modelReference: text(),
  },
  (t) => [index('credit_operation_requests_operation_idx').on(t.operationId)],
);
