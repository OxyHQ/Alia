# Oxy One allowance display (source draft)

Alia's authenticated `/credits` response includes `subjectAccountId` and a nullable
`productAllowance`. This is a current Oxy grant-period read model, independent of
`freeCredits`, `paidCredits`, and the existing total `credits`. Consumption and
in-flight reservations come from the exact immutable allocation in Alia; before
its first reservation, a valid grant displays its entire included allowance.
The approved personal composition is 10,000 credits per subscription month plus
the existing daily free refill. The displayed quantity and dates come from the
grant, rather than hard-coded plan amounts.

The read fails closed for canceled, expired, stale, overlapping or mismatched
sources. An Oxy outage removes the bundle display while individual/free sources
remain independent. `/billing/entitlements` preserves the existing individual
entitlement contract and exposes `effectivePlanId` separately for the larger
supported credit window; unknown individual plans keep their existing unlimited
window behavior. This does not grant additional product feature flags.

Settings and the chat limits panel show Oxy One period usage alongside daily free
and individual sources. Management links to Accounts. There is no Alia bundle
checkout, price, currency or provider selected here. Existing individual offer
prices and credit purchase controls retain their existing behavior.

Credit queries include the current account and Oxy session in their cache keys,
validate the response account, poll every ten seconds, and hide retained data on
refresh failure. The UI stops displaying expired periods at the next render;
server admission and settlement remain authoritative for execution.

These display reads require the validated current user session. They do not
authorize background spending or provide offline consent: background/service
funding uses the separate trusted product-access contract and its own admission
checks. A visible allowance is never sufficient authority to execute a task.

## Focused validation

Run from `packages/api`:

```sh
bun run test src/lib/__tests__/product-credit-read-model.test.ts
bun run typecheck
```

Run from `packages/app`:

```sh
bun run test src/features/billing/runtime/__tests__/use-credits.test.ts src/features/billing/model/__tests__/credits-limits.test.ts
EXPO_NO_TELEMETRY=1 bun run typecheck
```

Results: three API model tests and eleven app model/hook tests passed; both
package typechecks passed. Full dependency installation/build remains unverified
because the existing libsignal source download returned HTTP 403. No retry,
credential workaround, production migration or live activation was performed.
