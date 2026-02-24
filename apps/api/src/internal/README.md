# Internal Modules

**CRITICAL: This directory contains internal-only modules that should NEVER be exposed publicly.**

## Providers Module

The `providers/` module is an internal service for managing AI provider keys, model configurations, and request routing for virtual Alia models.

### Key Points:

- **Internal Use Only**: These endpoints are NOT part of the public API
- **Admin Panel Access**: Only accessible to the admin panel via HMAC authentication
- **No Public Documentation**: Never document these endpoints in public API docs
- **Virtual Alia Models**: Used exclusively for internal Alia model resolution (alia-v1, alia-lite, etc.)

### Architecture:

The providers module was previously a separate microservice but has been integrated into the main API to reduce infrastructure costs while maintaining clear separation.

```
Main API (Port 3001)
├── Public Endpoints (/health, /auth, /chat, etc.)
├── Public Billing (/billing/plans, /billing/checkout, /billing/subscription)
└── Internal Providers (/internal/providers)
    ├── /v1/providers (model resolution, health monitoring)
    ├── /v1/models (model configuration)
    ├── /v1/keys (API key management)
    └── /v1/plans (subscription plan CRUD, seeded on startup)
```

### Provider Failover & Key Management:

The module provides a multi-layer failover system for AI provider requests:

**Key Manager** (`lib/key-manager.ts`):
- Loads provider keys from MongoDB, sorted by priority (free first, then paid)
- 10-second cache TTL to minimize stale-key window
- Rate limit checking via single `$facet` aggregation (rps/rpm/rph/rpd and tps/tpm/tph/tpd)
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
- Records `FallbackEvent` documents for analytics (fire-and-forget)

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
- Per-provider/model health tracking in MongoDB

### Authentication:

All internal provider endpoints require HMAC-based service authentication:
- `X-Service-Name`: Calling service identifier
- `X-Timestamp`: Unix timestamp (60-second window)
- `X-Signature`: HMAC-SHA256 signature

### Access Control:

Endpoints are protected by:
1. HMAC authentication middleware
2. CORS restrictions (admin panel origin only)
3. No inclusion in public API documentation

---

**Remember**: If you need to expose provider functionality publicly, create new public endpoints in the main API that abstract away the internal provider details.
