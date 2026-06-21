# Alia Gateway

Internal gateway service that brokers provider calls with key rotation, health-aware routing, and fallback analytics.

## Non-Streaming Call API (`POST /api/call`)

Fields:
- `endpoint` (required): Provider-relative path, e.g. `/v1/images/generations`.
- `provider` + `modelId`: Explicit provider path (no cross-provider fallback).
- `model`: Alia model alias (e.g. `alia-v1`) for cross-provider fallback. Omit `provider/modelId` when using this.
- `body` or `formData`: JSON payload or server-built multipart (audio uses `audio.base64`).
- `responseType`: `json` (default) or `arrayBuffer` for binary (returns base64).
- `maxAttempts`: Per-provider key retry count (default 3).
- `maxProviderAttempts`: Cap how many providers in the tier to try (defaults to all).
- `timeout`: Per-attempt timeout in ms (default 30000).

Behavior:
- With `model` (alias): iterates tier mappings by priority, skips providers with open circuits, retries keys per provider, and advances on timeout, rate_limit, billing, auth, or unknown errors. Stops immediately on `format` or `content_filter`.
- With `provider/modelId`: uses existing per-provider retries but no cross-provider fallback.
- Records fallback attempts for analytics; updates provider health on success/failure.
- Only returns an error after all eligible providers are exhausted.

Binary responses:
- When `responseType` is `arrayBuffer`, the response returns `{ success: true, data: <base64>, encoding: 'base64' }`.
