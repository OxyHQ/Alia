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
