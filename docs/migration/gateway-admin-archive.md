# Archive: what an operator did in Gateway Admin, and where it goes now

> **Historical record only.** The screen inventory and the later “operator”
> table record the state at the time this archive was written. They are not
> current procedures. Provider credentials, routing and provider operations now
> belong to Kaana/Oxy; Alia must never administer them or read/write its dormant
> compatibility tables for hosted inference.

`packages/alia-gateway-admin` was deleted by [#141](https://github.com/OxyHQ/Alia/pull/141).
It was an eleven-screen Vite SPA that administered the provider stack, the plan catalogue and
customer billing. This is the operator-facing record of it: per screen, the actions it offered
and where each one lives today.

Closes the epic #139 workstream 9 checkbox
*"Archive migration screenshots/runbooks for operators."*

## Sourcing, and why there are no screenshots

**There are no screenshots and there cannot be.** The package was deleted before this task
existed, so nothing renders. Recovering them would mean checking out a deleted Vite app,
installing its dependencies and pointing it at `/internal/gateway/v1/*` routes that were
themselves deleted — it would render an error state, not the screen an operator used.

So this is reconstructed from two sources, both named so a reader can re-read them:

- **The pre-deletion tree at `f01e6151`** (`6a6ad971^`, the parent of the commit that deleted
  the package), read with `git show 6a6ad971^:packages/alia-gateway-admin/…`. 76 files.
- **[`inventories/frontend-admin.json`](./inventories/frontend-admin.json)**, the screen-by-screen
  inventory taken at `b909147d`, while the package still existed.

The two were cross-checked rather than trusted: the route table, the sidebar and the `src/pages/`
listing all give the same ten authenticated screens plus a login fallback, and `Keys.tsx`'s six
React Query mutations (`createMutation`, `updateMutation`, `deleteMutation`, `rotateMutation`,
`toggleActiveMutation`, `reloadMutation`, at `:141`–`:199`) match the inventory's summary of that
screen exactly.

## Who could open it

One person. `src/App.tsx:81` read:

```ts
const isAuthorized = user?.username?.toLowerCase() === 'nate';
```

Anyone else — signed in or not — got the login shell. There were no roles, no groups and no audit
of who did what. Any replacement surface should treat that as a requirement it must not reproduce.

## The screens

`Destination` is the `targetPath` on that screen's row in
[`ownership-matrix.json`](./ownership-matrix.json), which is the authority; the ids are given so
the two can be diffed.

### Provider operations — destination `internal-kaana-ops`

| Screen | What an operator did there | Matrix row |
| --- | --- | --- |
| **Dashboard** (`/dashboard`) | Read a provider-segmented operations overview: request timeline, top models, spend by provider, average latency per provider, credits overview, and an alerts panel for failing keys, open circuit breakers and keys near their credit limit. Rendered `provider — keyPrefix` pairs. | `ga-screen-dashboard` |
| **API Keys** (`/keys`) | Full CRUD over **upstream provider credentials**: create by pasting a raw key, rotate to a new raw key, activate/deactivate, delete, hot-reload the key pool, and set per-key rate limits and credit caps. | `ga-screen-keys` |
| **Models** (`/models`) | Edited two catalogues: provider model configs (provider, provider model id, pricing, capabilities) and the Alia virtual models with their ordered `providerMappings`. This was the alias-to-provider routing editor, with a drag-and-drop fallback-chain component beside it. 1506 lines, the largest screen. | `ga-screen-models`, `ga-component-fallback-chain` |
| **Monitoring** (`/monitoring`) | Watched live provider and model health: success rate, latency, consecutive failures, circuit-breaker state, with per-key drilldowns that printed key prefixes. | `ga-screen-monitoring` |
| **Usage** (`/usage`) | Read aggregate usage and cost over a selectable period. The cost figure was upstream provider COGS, **not** customer billing. | `ga-screen-usage` |
| **Logs** (`/logs`) | Browsed request logs filtered by provider, model and status, with a provider facet list and aggregate stats over an hours window. | `ga-screen-logs` |

### Alia product configuration — destination `keep-as-alia-product-setting`

| Screen | What an operator did there | Matrix row |
| --- | --- | --- |
| **Plans** (`/plans`) | CRUD over subscription plans — credits per month, monthly and annual price, Stripe price ids, featured and free flags — **and the set of Alia model ids each plan unlocks**. | `ga-screen-plans` |
| **Credit Packages** (`/credit-packages`) | CRUD over one-off credit packs: credits, price, currency, Stripe price id. | `ga-screen-credit-packages` |
| **Features** (`/features`) | CRUD over entitlement features, plus a bulk-editable plan-by-feature matrix that drives the pricing page copy and plan gating. | `ga-screen-features` |
| **Billing** (`/billing`) | Read-only browsing of customer transactions and subscriptions, including Stripe customer, payment-intent and subscription ids alongside `oxyUserId`. | `ga-screen-billing` |

### Deleted outright

| Screen | Why | Matrix row |
| --- | --- | --- |
| **Login** (`*`, unauthenticated) | An Oxy sign-in shell branded "Alia Providers / Admin Panel", shown to any unauthenticated or unauthorized visitor. Authentication belongs to `@oxyhq/services`; the shell had nothing to preserve. | `ga-screen-login` |

## What an operator could do when this archive was written

At the time of this archive, **ten of the eleven screens had no replacement
surface**. `internal-kaana-ops` named a future Kaana operations surface and
`keep-as-alia-product-setting` named Alia product settings that had not been
built. Both were open checkboxes on #139 workstream 9:

- *"Move customer-facing application, credential, usage, billing, model and routing controls to
  Oxy Console."*
- *"Move provider/deployment operational controls to an internal Kaana operations surface if still
  required."*

The operator paths recorded at that time were:

| Was | Is now |
| --- | --- |
| **API Keys** — create, rotate, revoke a provider credential | A SQL statement against `provider_keys`, run by someone with production database access. [`runbooks/credential-rotation.md`](../runbooks/credential-rotation.md) § *Provider API keys* is the procedure, and it says why: there is no admin API for that table, asserted by `packages/api/src/routes/__tests__/inference-boundary.test.ts:458-468`, which lists `createProviderKey` / `updateProviderKey` / `deleteProviderKey` as writers with zero runtime callers and fails if a route file ever calls one. |
| **Models** — edit the routing catalogue | Nothing. `model_configs` and `alia_model_provider_mappings` are seeded by `packages/api/src/internal/providers/lib/seed-model-configs.ts`; the alias set itself is a frozen literal in `internal/providers/lib/alia-models.ts` and changing it fails gate 3 of `packages/api/src/__tests__/architectureGates.test.ts`. |
| **Plans / Features / Credit Packages** — edit the product catalogue | Nothing, and this is a measured gap rather than an omission: `packages/api/src/lib/routing/__tests__/routing-config-audit.test.ts` records that plan model access is *"an UNAUDITED database row"* and that *"the plan seeder would re-assert the model list, but NOTHING RUNS IT"*. Earning #139 workstream 14's *"Allow the product team to select which Oxy/Kaana models are available per plan/surface"* is what closes it. |
| **Dashboard / Monitoring / Logs / Usage / Billing** — read | Nothing UI-side. The data is still written: `provider_health`, `routing_logs`, `fallback_events`, `api_usage`, `cost_entries`, `chat_analytics`, `transactions`, `subscriptions`. Reading it is a database query. |

## Two things worth carrying into the replacement

- **Four screens rendered a provider `keyPrefix`** — Dashboard, Monitoring, Keys and the API
  client's key diagnostics. `key_prefix` is the first eight characters plus an ellipsis and is the
  only part of a provider credential that is safe to display, but a surface that shows it is still
  a surface that has to be authorized. `credential-rotation.md` additionally notes that `key_hash`
  is an exact-match **oracle** and must be treated as sensitive as the key itself.
- **The provider list was maintained by hand in the frontend.** `src/types/index.ts:244-264` held a
  nineteen-entry literal that drifted against `packages/shared-types/src/models.ts`. In this
  repository that class of drift is now closed at the source: `PROVIDER_NAMES`
  (`packages/api/src/internal/providers/lib/provider-names.ts`) renders the database `CHECK`
  constraints and is asserted against gate 2's hostname map, so registering a provider without
  recording where it egresses fails CI. A replacement surface should read that list, never restate
  it.
