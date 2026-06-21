# Alia Gateway Architecture

```
                                    ALIA GATEWAY (Express + WebSocket on :9091)
                                    ==========================================

    CLIENTS                              MIDDLEWARE                           ROUTE LAYER
    -------                              ----------                           -----------

                                    +------------------+
    Alia Main API  ----HMAC Auth--->|  authenticateService  |
    (alia-api)     X-Service-Name   |  (middleware/auth.ts)  |
                   X-Timestamp      |                        |
                   X-Signature      |  - HMAC-SHA256 verify  |
                                    |  - 60s replay window   |
    Admin Panel  --Bearer Token---->|  - Bearer + OxyHQ JWT  |
    (Console UI)   Authorization    |  - Admin username gate  |
                                    +----------+-------------+
                                               |
                   +---------------------------+---------------------------+
                   |                                                       |
          SERVICE API (/api/*)                                  ADMIN API (/gateway/v1/*)
          ====================                                  ========================

    +------------------+  +------------------+          +------------------+  +------------------+
    | POST /api/resolve|  | POST /api/call   |          | /v1/keys         |  | /v1/providers    |
    |                  |  |                  |          |  GET / (list)    |  |  POST /proxy     |
    | Input:           |  | Input:           |          |  POST / (add)    |  |  GET /health     |
    |  model           |  |  provider        |          |  POST /export    |  |  POST /record    |
    |  estimatedTokens |  |  modelId         |          |  POST /import    |  |  POST /resolve   |
    |  skipProviders   |  |  endpoint        |          |  PATCH /:id      |  |  GET /available  |
    |  skipKeyIds      |  |  body            |          |  DELETE /:id     |  +------------------+
    |                  |  |  audio (base64)  |          |  POST /:id/rotate|
    | Output:          |  |  responseType    |          |  POST /reload    |  +------------------+
    |  keyConfig       |  |                  |          +------------------+  | /v1/models       |
    |  provider        |  | Used for:        |                               | /v1/alia-models   |
    |  modelId         |  |  images          |          +------------------+  |  CRUD + mappings |
    |  aliaModel       |  |  embeddings      |          | /v1/plans        |  +------------------+
    +--------+---------+  |  transcription   |          | /v1/credit-pkgs  |
             |            |  TTS             |          | /v1/features     |  +------------------+
             v            +--------+---------+          | /v1/plan-features|  | /v1/dashboard    |
                                   |                    |  CRUD + matrix   |  | /v1/usage        |
    +------------------+           v                    +------------------+  | /v1/fallback-stats|
    | POST /api/report |                                                     | /v1/logs         |
    |                  |                                +------------------+  | /v1/billing      |
    | Fire-and-forget  |                                | WebSocket /ws    |  +------------------+
    |  keyId           |                                |  Real-time push  |
    |  success/failure |                                |  Channel-based   |
    |  tokens          |                                |  subscribe/unsub |
    |  latencyMs       |                                +------------------+
    +------------------+


                                    CORE ENGINE
                                    ===========

    +--------------------------------------------------------------------------------------------------+
    |                                                                                                  |
    |   MODEL RESOLVER (lib/model-resolver.ts)                                                         |
    |   +-----------+     +------------------+     +------------------+     +------------------+        |
    |   | AliaModel |---->| TIER_MODEL_      |---->| Fallback Engine  |---->| Key Manager      |        |
    |   | "alia-v1" |     | MAPPINGS         |     | (fallback-       |     | (key-manager.ts) |        |
    |   +-----------+     | Priority-ordered |     |  engine.ts)      |     |                  |        |
    |                     | provider list    |     |                  |     | getBestKeyFor    |        |
    |   alia-v1 maps to:  | per Alia model   |     | Per-error retry: |     | Model():         |        |
    |   1. groq/llama     +------------------+     |  timeout→retry   |     |  1. Load keys    |        |
    |   2. cerebras/llama                          |  rate_limit→skip |     |  2. Check cooldown|       |
    |   3. openai/gpt-4o                           |  billing→skip    |     |  3. Check credits |       |
    |   4. anthropic/claude                        |  auth→next key   |     |  4. Check rate lim|       |
    |   ...                                        |  format→abort    |     |  5. Return best   |       |
    |                                              +--------+---------+     +--------+---------+        |
    |                                                       |                        |                  |
    |                                              +--------v---------+     +--------v---------+        |
    |                                              | Provider Health  |     | Rate Limit Check |        |
    |                                              | (provider-       |     | (ApiUsage agg)   |        |
    |                                              |  health.ts)      |     |                  |        |
    |                                              |                  |     | rps/rpm/rph/rpd  |        |
    |                                              | Circuit Breaker: |     | tps/tpm/tph/tpd  |        |
    |                                              |  closed→open     |     +------------------+        |
    |                                              |  (5 failures)    |                                 |
    |                                              |  open→half-open  |                                 |
    |                                              |  (60s timeout)   |                                 |
    |                                              |  half-open→closed|                                 |
    |                                              |  (2/3 successes) |                                 |
    |                                              +------------------+                                 |
    |                                                                                                  |
    +--------------------------------------------------------------------------------------------------+


                                    PROVIDER LAYER
                                    ==============

    +------------------+  +------------------+  +------------------+  +------------------+
    | OpenAI           |  | Anthropic        |  | Google           |  | Groq             |
    | (openai.ts)      |  | (anthropic.ts)   |  | (google.ts)      |  | (groq.ts)        |
    |                  |  |                  |  |                  |  |                  |
    | OpenAI-compat    |  | Claude format    |  | Gemini format    |  | OpenAI-compat    |
    | Bearer auth      |  | x-api-key auth   |  | ?key= URL param  |  | Bearer auth      |
    +------------------+  +------------------+  +------------------+  +------------------+

    +------------------+  +------------------+  +------------------+  +------------------+
    | DeepSeek         |  | Cerebras         |  | Together         |  | Mistral          |
    | (deepseek.ts)    |  | (cerebras.ts)    |  | (together.ts)    |  | (mistral.ts)     |
    | OpenAI-compat    |  | OpenAI-compat    |  | OpenAI-compat    |  | OpenAI-compat    |
    +------------------+  +------------------+  +------------------+  +------------------+

    +------------------+  +------------------+  +------------------+  +------------------+
    | OpenRouter       |  | Cloudflare       |  | Cohere           |  | Replicate        |
    | (openrouter.ts)  |  | (cloudflare.ts)  |  | (cohere.ts)      |  | (replicate.ts)   |
    | OpenAI-compat    |  | OpenAI-compat    |  | OpenAI-compat    |  | Async invoke     |
    +------------------+  +------------------+  +------------------+  +------------------+


                                    DATA LAYER
                                    ==========

    MongoDB (alia-{env})
    +------------------+  +------------------+  +------------------+  +------------------+
    | ProviderKey      |  | ModelConfig      |  | AliaModel        |  | ApiUsage         |
    | API keys +       |  | Provider model   |  | Virtual models   |  | Request audit    |
    | rate limits +    |  | definitions +    |  | + provider       |  | (rate limit      |
    | credit tracking  |  | capabilities     |  | mappings         |  |  checks)         |
    +------------------+  +------------------+  +------------------+  +------------------+

    +------------------+  +------------------+  +------------------+  +------------------+
    | ProviderHealth   |  | FallbackEvent    |  | Plan             |  | Feature          |
    | Circuit breaker  |  | Retry analytics  |  | Subscription     |  | Feature defs     |
    | state            |  | (30-day TTL)     |  | tiers            |  | + PlanFeature    |
    +------------------+  +------------------+  +------------------+  +------------------+

    +------------------+  +------------------+
    | CreditPackage    |  | UserCredits      |
    | One-time packs   |  | Billing refs     |
    +------------------+  +------------------+
```

## Request Flow: Streaming Chat

```
User → Alia API → POST /api/resolve { model: "alia-v1" }
                        │
                        ▼
                  Model Resolver
                        │
                  ┌─────┴─────┐
                  │ AliaModel  │ "alia-v1" → tier mappings
                  └─────┬─────┘
                        │
                  ┌─────┴──────────┐
                  │ Fallback Engine │ Try providers in priority order
                  └─────┬──────────┘
                        │
              ┌─────────┼─────────┐
              ▼         ▼         ▼
           groq/     cerebras/  openai/
           llama     llama      gpt-4o
              │
        ┌─────┴─────┐
        │ Key Mgr   │ Select best key for groq
        └─────┬─────┘
              │
        ┌─────┴─────┐
        │ Health    │ Check circuit breaker
        └─────┬─────┘
              │
              ▼
        Return { provider: "groq", modelId: "llama-...", keyConfig: {...} }

Alia API → POST /gateway/v1/providers/groq/proxy (stream)
                        │
                        ▼
                  Provider Adapter (groq.ts)
                        │
                        ▼
                  Groq API (OpenAI-compat SSE)
                        │
                        ▼
                  Stream piped back to Alia API → User

Alia API → POST /api/report { keyId, success: true, tokens: 1500 }
                        │
                        ▼
                  Key Manager: update usage stats
                  Provider Health: record success
```
