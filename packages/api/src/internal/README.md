# Internal Modules

**CRITICAL: This directory contains internal-only modules that should NEVER be exposed publicly.**

## Providers Module

The `providers/` module holds the in-process logic for provider keys, model
configurations and request routing for virtual Alia models. It is a **library,
not a service**: nothing here is mounted on the HTTP server.

### Key Points:

- **No HTTP surface**: `providers/lib/**` is reached only through
  `../../lib/gateway-client.ts`, which every consumer imports. There are no
  provider routes to call, and none should be added — expose a public endpoint
  in `routes/` that abstracts the provider details instead.
- **Never publicly documented**: provider names and provider model ids stay
  inside this directory. Everything that crosses the boundary is Alia-branded.
- **Virtual Alia Models**: used exclusively for internal Alia model resolution
  (alia-v1, alia-lite, etc.)

### Architecture:

The providers module was previously a separate microservice, then a set of
admin routes under `/internal/gateway` driven by a Vite admin panel. Both are
gone; the module is now imported directly by the API that uses it.

```
Main API (Port 3001)
├── Public Endpoints (/health, /auth, /chat, etc.)
├── Public Billing (/billing/plans, /billing/checkout, /billing/subscription)
└── lib/gateway-client.ts  ← the only door into internal/providers
```

### Provider Failover & Key Management:

The module provides a multi-layer failover system for AI provider requests:

**Key Manager** (`lib/key-manager.ts`):
- Loads provider keys from the `provider_keys` PostgreSQL table, sorted by priority (free first, then paid), through `db/providers/providerKeyRepository.ts`
- 10-second cache TTL to minimize stale-key window
- Rate limit checking in one statement covering all four windows (rps/rpm/rph/rpd and tps/tpm/tph/tpd), via `db/telemetry/apiUsageRepository.ts`
- Credit limit enforcement (`spentUSD >= creditLimitUSD` → skip)
- Cooldown management: exponential backoff for errors, flat 60s for rate limits, provider Retry-After header priority
- `skipKeyIds` parameter for caller-driven key exclusion (failed keys from previous attempts)

**Fallback Engine** (`lib/fallback-engine.ts`):
- Iterates tier model mappings by priority, applying reason-specific retry strategies
- Key-level retry: up to 3 keys per provider before skipping to next provider
- Error reason strategies:
  - `timeout` → retry same provider once, then next
  - `rate_limit` / `auth` / `unknown` → try next key (up to 3), then next provider
  - `billing` → skip provider, mark key credit-exhausted
  - `provider_unavailable` → skip provider entirely (geo-restriction, service down)
  - `format` / `content_filter` → stop (non-retryable)
- Records `fallback_events` rows for analytics, fire-and-forget, via `db/telemetry/fallbackEventRepository.ts`

**Error Classification** (`../../lib/errors/failover-error.ts`):
- Classifies unknown errors into `FailoverReason` categories
- Provider-specific structured data extraction from `APICallError.data`:
  - Google: `data.error.status` (FAILED_PRECONDITION, RESOURCE_EXHAUSTED, UNAVAILABLE)
  - OpenAI: `data.error.type` + `data.error.code` (billing_hard_limit_reached, insufficient_quota)
  - Anthropic: `data.error.type` (overloaded_error, rate_limit_error)
- Classification priority: HTTP status → error codes → timeout detection → provider data → message regex → fallback
- `getRetryAfterHeader()` extracts Retry-After from error response headers

**Provider Health** (`lib/provider-health.ts`):
- Circuit breaker pattern: 5 consecutive failures → open for 60s → half-open (3 attempts, 2 successes to close)
- Per-provider/model health tracked in the `provider_health` PostgreSQL table, via `db/telemetry/providerHealthRepository.ts`

---

**Remember**: If you need to expose provider functionality publicly, create new public endpoints in the main API that abstract away the internal provider details.
