# Console machine chat contract

Uses published core4.4.0, with its coordinated Oxy backend deployed before adoption. Deployment and full Console key-lifecycle acceptance are tracked separately in Oxy#1571. Implements ADR 0010's Console-issued product-key direction with a limited app-only chat surface. Oxy's ADR 0035 owns the shared receiver and scope contract. The dated implementation census in ADR 0010 describes the earlier unsupported raw-key lane.

Only POST `/alia/chat` and `/v1/chat/completions` opt in. Both reuse the existing shared handler. Oxy validates the machine key through the Alia resource's service-authenticated introspection endpoint; both credential and app must explicitly grant `alia:chat` and `inference:invoke`. The SDK returns separate `machineCredential` metadata, never `req.user`, service tier or grants. `X-Oxy-User-Id` and requester assertions are refused for this lane. All other product routes stay closed to raw machine keys.

Accepted body fields: `messages`, `input`, `model`, `stream`, `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `reasoning_effort`, `response_format`, `stop`, `seed`, `presence_penalty`, `frequency_penalty`. Existing handler validation still applies. Exact hosted model selectors remain supported; `local/*` belongs to a person and is refused. Tools and personal/product-state selectors are refused before model or context work. The machine tool turn is empty, including the otherwise ungranted clock helper; no tool sources are fetched.

The request-scoped SDK bearer is forwarded only to the approved Oxy inference origin. Oxy revalidates it and derives its calling application as payer. No caller body field or owner identity selects the payer, and there is no fallback to Alia's process credential. The existing user/session and present/offline requester contracts stay separate.

Release order: Oxy#1577 deployed the additive scope-vocabulary migration and resource endpoint, then core4.4.0 was built and published from accepted main0c6. Alia pins that exact registry version and lock before deployment. The original dated candidate proof retains its unpublished-fixture limitation; current adoption validation uses the published package. Neither manifest nor lock points to a local package.

No default permissions, credentials, consent grants, production calls or live inference are created by these changes. They do not complete the generic service-access model in Oxy #873/#874 or give arbitrary Console keys access to all Alia routes.
