# Alia integrations service

Messaging gateways, channel bots, MCP connectors, browser automation and terminal
sessions run in this process. The API accesses it at `INTEGRATIONS_URL`; production
uses `http://integrations.alia.internal.oxy.so:3005`.

## Internal authentication

Both directions use `@alia.onl/server`'s canonical Oxy transport and temporary
workload identity. Receivers verify the live first-party authority, Alia app,
recipient audience and exact opposite process. Another Oxy application or Alia
workload cannot substitute for the registered API or integrations role. Internal
scopes, client API keys and shared gateway passwords are absent.

API → integrations operations carry a separate internal account context derived
from the API's authenticated session/task. Every session and MCP resource must
belong to that account. This is local Alia context, never an Oxy user session or
cross-product requester proof.

Integrations → API channels identify their provider link or connected-account
session. The API resolves the account from that live row; a remote sender cannot
choose an account or impersonate its owner. Private background tools use a
revocable Oxy automation task created with the real requester when linking. Only
the task ID is stored. Legacy connections without valid authority renew automatically when their owner
uses the normal signed-in app session. No extra permission prompt is introduced. Disconnect/delete/relink revokes the old task.

## Configuration

`DATABASE_URL` is the integrations database. `TOKEN_ENCRYPTION_KEY` must match the
API's encryption key for connector records. `API_BASE_URL` points to Alia's API;
`OXY_API_URL` points to Oxy. `PORT` defaults to 3005.

| Adapter | Configuration |
| --- | --- |
| Telegram bot | `TELEGRAM_BOT_ENABLED`, `TELEGRAM_BOT_TOKEN` |
| Discord bot | `DISCORD_BOT_ENABLED`, `DISCORD_BOT_TOKEN` |
| WhatsApp accounts | `WHATSAPP_ENABLED` |
| Telegram accounts | `TELEGRAM_GATEWAY_ENABLED`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` |
| Signal accounts | `SIGNAL_ENABLED` |

Adapters are enabled by default; set the corresponding enabled value to false
to disable one. External provider OAuth scopes and webhook signatures remain
provider requirements; they do not authenticate internal Alia traffic.

## Development

Run `bun run dev:integrations` from the repository root. The optional
`@oxy.so/core/server/aws` provider uses the AWS server credential chain for ECS
and temporary IAM SSO credentials. Set `AWS_PROFILE` to a registered development
role profile. The registry owns the role's application and environment binding.

Production receiver pins default to the exact roles exported by
`@alia.onl/server/internal`. For distinct registered development roles, configure
`ALIA_API_WORKLOAD_ID` and `ALIA_INTEGRATIONS_WORKLOAD_ID` on the servers. These
are deployment pins, never values accepted from a request. No API key fallback
is used. Traffic reporting uses the same workload provider.

The HTTP server starts before adapter initialization for health checks. Individual
adapter startup failures do not stop other adapters. Follow
[the rollout runbook](../../docs/runbooks/integrations-service-rollout.md) before deploying.
