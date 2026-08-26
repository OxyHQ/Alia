# 5. Product entitlements versus the financial ledger

**Status:** Accepted

**Date:** 2026-08-15

## Context

Alia currently owns both halves of billing: what a customer is allowed to do, and what a customer owes.

The financial half lives in `packages/api/src/db/schema/billing.ts` — `plans` (`:68`), `features` (`:138`), `plan_features` (`:175`), `credit_packages` (`:208`), `subscriptions` (`:262`), `transactions` (`:347`) and `user_credits` (`:410`) — with Stripe integration in `packages/api/src/routes/billing.ts` and `packages/api/src/lib/stripe-prices.ts`. Upstream provider cost is estimated per request in `cost_entries` (`packages/api/src/db/schema/usage.ts:45`).

Two of those responsibilities are in the wrong place, and one is not.

The wrong ones are the customer-facing financial records. Under ADR 0001, Oxy owns accounts, balances, subscriptions, the ledger and invoices. A product holding the authoritative record of what a customer paid means reconciliation between two systems that both believe they are right, and it means a product bug can rewrite a financial fact.

The one that is not in the wrong place is the entitlement decision. Deciding whether this user may start a deep-research run, on this plan, right now, is a per-request product decision on a latency budget. Making it a synchronous call to another service on every turn would be both slow and fragile.

There is also a correctness point the schema itself already records. The comment on `cost_entries` (`packages/api/src/db/schema/usage.ts:24` onward) documents that `cost_usd` is `double precision` because it is a derived estimate — tokens multiplied by a published fractional rate — and states outright that if per-user billing were ever taken from that table rather than from a payment provider's own figures, the type would have to be reconsidered. That condition must never be reached: the estimate is not a charge, and this ADR settles that it never becomes one.

## Decision

### Alia keeps entitlements as a low-latency read model

Alia may retain, and continues to own:

- plan names and plan structure as a product concept;
- included capabilities and feature entitlements;
- allowances — what a plan includes, and how much of it remains;
- the per-request checks that consume the above.

This state is a **read model**. It is derived from Oxy-owned facts, it is cached for latency, and it is not authoritative about money. When it disagrees with Oxy, Oxy is right.

### Oxy owns the financial record

Oxy owns, exclusively:

- Stripe customers;
- payments;
- invoices;
- balances;
- transactions;
- the ledger;
- exact inference usage charging.

Alia does not settle charges, does not issue invoices, and does not hold the authoritative balance. Alia plan allowances are consumed against Oxy-recorded inference usage rather than against a separate Alia count of the same events.

### Product price and margin are separate from provider upstream cost

What Alia charges a customer and what a request costs upstream are two different numbers with two different owners. Provider upstream cost is measured by Kaana (ADR 0001) and is infrastructure data. Product price is an Oxy-recorded financial fact set by product policy. Neither is derived from the other at request time, and neither is stored as if it were the other.

`cost_entries.cost_usd` is not a customer billing source, now or later. It is an internal estimate, and its own schema comment says why it cannot be one.

### Free and promotional usage is still cost-attributed internally

Usage that a customer is not charged for still consumes upstream capacity and still costs money. Free-tier turns, promotional credits, internal evaluations and testing are attributed to an internal cost centre. "Not billed to the customer" and "not attributed" are different statements, and only the first is ever true.

### A plan change can never rewrite a historical financial receipt

A receipt records what happened. Changing a plan, renaming a plan, altering an allowance or correcting an entitlement changes what happens next; it never rewrites what a customer was already charged. Corrections to a historical charge are new financial events — a refund, a credit, an adjustment — recorded forward in the Oxy ledger, never an edit in place.

This is what makes the read model safe to be a cache. A cache that can be rebuilt from authoritative facts is a performance decision; a cache that can silently alter those facts is a second source of truth.

### Migration must not double-credit or double-charge

Moving active subscriptions and balances from Alia to Oxy is a financial operation, and its correctness condition is exactness, not approximation:

- Every migrated balance is reconciled against its source before the Alia-side value stops being read.
- Financial events are idempotent across the cutover, including under rollback and retry, so a replayed event does not credit or charge twice.
- Duplicate Stripe webhooks and checkout flows are removed from Alia only after Oxy is authoritative, not before and not during.
- Alia financial tables are dropped only after reconciliation and retention review.

## Consequences

- Alia gains a dependency on an Oxy entitlement contract, and that contract's shape — how allowances are published, how usage is reported back, how quickly the read model converges — becomes a product-visible concern.
- Entitlement decisions remain local and fast. The read model is allowed to be briefly stale; where staleness would let a customer exceed an allowance, the acceptable direction of error is a product policy decision, made explicitly rather than falling out of cache timing.
- Alia's own billing tables become migration inputs. They stop being written when Oxy is authoritative, and they are dropped under the gates above.
- Reconciliation becomes possible for the first time: exactly one system holds the authoritative number, so a disagreement is a bug rather than an accounting question.
- Product analytics keep tracking usage, but as product analytics. Where they currently carry provider and model identity, they carry requested model or profile plus a safe resolved revision reference instead, per ADR 0003.
- Retiring the Alia-side financial path is bounded by legal and retention requirements, not only by engineering readiness.

## Alternatives considered

**Move entitlements to Oxy as well and check them synchronously per request.** Rejected. It puts a network call on the hot path of every turn, and it makes an Oxy outage a total Alia outage rather than a degraded one. Entitlements are a product decision; the money behind them is not.

**Keep the financial ledger in Alia and report usage to Oxy.** Rejected. It leaves the authoritative record inside a product database, which is what ADR 0001 removes, and it means every product incident is potentially a financial incident.

**Derive customer charges from `cost_entries.cost_usd`.** Rejected on the schema's own terms: the column is a floating-point estimate, sums of it accumulate error, and equality on it is meaningless. Charging from an estimate is a correctness bug regardless of where the table lives.

**Run both systems in parallel during migration, writing to each.** Rejected as a steady state, and constrained even as a transitional one. Dual-write with two authorities is exactly how double-crediting happens. Where a transitional overlap is unavoidable, one side is authoritative and the other is a derived read model from the moment the overlap begins.

## Enforcement

- **Reconciliation before cutover.** Every migrated balance and subscription is reconciled against its source, with the result recorded, before the Alia-side value stops being read. This is a migration review gate under workstream 12 of #139; no automated check enforces it.
- **No duplicate charge on retry.** An end-to-end test asserting that a retried request produces one charge is *not yet enforced — tracked by #139 workstream 19*.
- **The entitlement API has a shape somebody else owns.** `lib/plan-access.ts` publishes `@oxyhq/contracts`' `ProductEntitlement`, parsed through `productEntitlementSchema` before it is returned, so a value the read model produces is by construction one Oxy can serve. `lib/__tests__/entitlements.test.ts` asserts the fields and gives the schema its own positive control; `payAsYouGo` and `costCenter` are asserted `null`, which is the contract's word for "Alia holds no billing profile" rather than a stub.
- **The read model cannot reach the financial write half.** `packages/api/src/__tests__/billingSeparation.test.ts` walks the read model's whole transitive module closure and fails if a financial module is in it — the same statement as "delete those files at cutover and this one still compiles". The dependency in the permitted direction (the Stripe webhook invalidating the cache) is asserted too, so removing it cannot look like progress.
- **Cost-centre attribution per surface** is *not yet enforced — tracked by #139 workstream 19*. What is enforced is narrower and is stated as a measurement: a credit reservation carries which balance funded it (`domain/credit-funding.ts`), the voice settlement writes it to `voice_call_usage`, and `cost_entries` carries the column with `recordCost` accepting it. `recordCost` has **no production caller**, so the token-metered paths are not yet attributed at all; that zero is asserted, and wiring the ledger up turns the gate red.
- **`cost_entries.cost_usd` is never a billing source.** Enforced by the schema comment at `packages/api/src/db/schema/usage.ts:24` and, structurally, by `billingSeparation.test.ts`: the set of modules reading an upstream cost figure and the set writing a customer charge are each frozen exactly and asserted DISJOINT. A charging path acquiring access to the estimate — by naming the column or by importing its repository — turns it red.
- **Historical receipts are immutable, at the database.** Migration `0023_append_only_receipts.sql` puts a `BEFORE UPDATE OR DELETE` trigger on `transactions`, which raises rather than silently affecting zero rows as a row-level-security policy would, and binds the table owner as a `REVOKE` would not. `db/__tests__/receiptImmutability.pgdb.test.ts` issues both writes directly — nothing in the package updates or deletes a transaction, so a behavioural suite over the existing code is green with the trigger and without it — and it runs in the `API (Postgres)` CI job only. Alia's wider obligation is unchanged: the authoritative ledger is Oxy's.
- **Financial tables are dropped only after reconciliation and retention review.** A migration review gate under workstream 12 of #139; no automated check enforces it.
