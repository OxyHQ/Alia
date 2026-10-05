# Oxy One personal adapter: draft, unconfigured

Inspected Alia revision: f3608abb5ac1507b82366f757aa25d095908b5c4.
This document records a bounded draft integration, not activated Alia access.
User approved Pro-level 10,000 monthly credits and 100 GB decimal storage. Price, currency, provider, registered product mappings and live activation remain unset.

## Existing authority and implementation boundaries

`packages/api/src/lib/plan-access.ts` resolves Alia's individual subscriptions and
free fallback, with a five-minute account-keyed cache. `request-context.ts` consumes
that decision. `credits-manager.ts` reserves and settles through durable credit
operations, price books and free/paid balances. Oxy bundle grants alone do not
fund those balances or activate Alia. Preserve individual sources and the free
floor. Never copy bundle allowances into the unrestricted paid balance: expiry,
refunds and the original funding source would be lost.

## Access adapter contract

Configuration is `null` by default. An approved configuration must explicitly
name an Oxy product ID, capability mappings, quota keys/units, combination policy,
and the Alia credit funding adapter version. No name-based plan inference.

Input: `{ subjectAccountId, validatedUserSession, evaluatedAt }`. Use the existing
Oxy middleware's validated request identity; do not accept a browser-provided
subject, service token or global mutable user token. SDK transport must forward
that request's user session independently and schema-parse `ProductAccess`.
`productAccess({ schemaVersion: 1, subjectAccountId, productId })` is the existing
SDK read contract. A request-scoped server SDK forwarding method is required
before wiring the Alia shared `oxyClient`; mutating its token would cross accounts.

Output: `{ state: 'unconfigured' | 'ready' | 'unavailable', subjectAccountId,
productId, evaluatedAt, capabilities, quotas, conflicts, sourceGrantIds }`.
Account mismatch, unit/combination conflicts, unknown mappings or unavailable
Oxy authority must not grant additional bundle rights. Individual subscriptions
remain intact. Do not fabricate a single Alia `planId` from plural Oxy sources.
Do not cache bundle decisions beyond grant expiry; cache keys need account,
product, adapter version and source revision, with cancellation invalidation.

## Required consumption extension before activation

The current aggregate Oxy access response exposes grant IDs but not each grant's
period boundaries and quantitative allocation. Add a versioned, access-only
per-grant read contract with source/segment/grant IDs, benefit key/unit/included,
start/end and revoked status. This is necessary to assign spending to an actual
source rather than to a summed allowance with an unknown expiry.

Alia must add a `bundle` funding lane referencing that immutable source and
period. Reservation, execution identity, settle, retry, refund and release must
be atomic/idempotent in the existing credit-operation ledger. A reservation
cannot spend another account's grant; concurrent reservations cannot overspend;
renewal creates a fresh period; cancellation/expiry stops new reservations without
destroying existing individual paid/free credit sources. The conversion from
metered cost to Alia credits must use the existing immutable price-book snapshot.
No Oxy API credit balance is an Alia allowance.

## Acceptance tests and release gates

Test same-account free + individual + bundle coexistence, different account and
session isolation, duplicate/out-of-order activation, renewal, scheduled and
immediate cancellation, expiry, refund, concurrent reservation, failed execution
release and replayed settlement. Test missing configuration and authority outage.
Until the funding lane and tests pass, keep bundle activation disabled and show
unconfigured access, not a purchasable/usable plan.

A full local install was attempted with a temporary browser cache. It stopped at
an unauthenticated GitHub tarball dependency returning HTTP 403. No credentials,
production API calls or payment actions were attempted. The runtime changes below remain disabled without explicit adapter configuration.


## Implemented locally after the original inspection

A separate `product_credit_allocations` table holds immutable Oxy grant/segment,
subject, product, quota/unit, period and included quantity, with reserved/consumed
conservation. Existing credit operations reference that source and retain their
immutable price books. The metered-chat path reads a current request-scoped SDK
grant snapshot and uses bundle funding only after legacy free/paid funds cannot
cover admission. No credits are copied into an unrestricted balance.

Configuration `ALIA_OXY_PRODUCT_CREDIT_ADAPTER` is absent by default. Its explicit
schema contains productId, quotaKey, unit `alia_credit`, combination and an existing
Alia planId. The approved draft mapping uses `pro`; no product identity is guessed.
The mapped rolling window preserves any larger individual window. Daily refill
logic is unchanged. Authority failure gives no extra bundle rights and preserves
legacy funding. Overlapping bundle grants need an upgrade allocation policy and
currently fail closed. Only a single active bundle funding source is supported.

Settlement/refund replay is guarded by the existing operation row. Any additional
spend above reservation needs a freshly authorized matching grant; recovery after
loss of the user session cannot spend additional credits. Cancellation and expiry
stop new admission. Renewal creates a new grant/period allocation. Local tests
cover these operations, concurrency and account isolation in throwaway PostgreSQL.
The additive draft migration was run only by the repository test harness.

Still required before activation: publish/adopt the compatible Oxy SDK; complete
Alia balance/plan UI and subscription read model; audit voice/show/background
funding and recovery (this draft wires metered chat only); verify full dependency
install/CI once the documented GitHub denial is resolved; approve commercial
price/provider and live configuration. No provider calls, live grants, charges,
production migrations, push or deployment were made.
