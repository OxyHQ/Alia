# Runbook: rotating and revoking credentials

Every secret this service holds, how to replace it, how to revoke it, and what
breaks while you do.

This is the ROUTINE procedure — a scheduled rotation, a departing operator, a key
a provider has rate-limited into uselessness. When a credential has actually
LEAKED, [provider-credential-exposure](./provider-credential-exposure.md) is the
one that applies first: it establishes whether a value reached the logs or the
`provider_keys.last_failure_reason` column, and rotation is only its step 2. The
two are meant to be read in that order, and nothing here repeats what it covers.

**There is a live reason this document exists.** #139's own audit checkbox —
`Audit git history and deployment logs for exposed credentials; rotate where
necessary.` — is open, and the audit that produced the epic's findings reports
provider API keys present in this repository's PUBLIC git history. Rewriting
history does not un-publish them; only rotation does. [Provider API
keys](#provider-api-keys-provider_keys) below is written to be followed for
exactly that job today.

## Two facts that govern everything below

**1. GitHub Actions repository secrets are the source of truth — for ten secrets,
and only those ten.** `.github/workflows/deploy-aws.yml:65` onward syncs an
explicitly enumerated list into SSM with `aws ssm put-parameter … --overwrite`
(`:84`), so a value edited in SSM alone is silently reverted by the next deploy.
The list is `DATABASE_URL`, `SERVICE_SECRET`, `TOKEN_ENCRYPTION_KEY`,
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` under `/oxy/alia/*`, and
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `REDIS_URL` under `/oxy/_shared/*` (`:88`–`:106`).

For every OTHER secret in the inventory the relationship is INVERTED: nothing
syncs them, so SSM and the `oxy-infra` terraform are the source of truth and
setting a GitHub secret of that name accomplishes nothing at all. Getting this
backwards fails in the quiet direction — you edit the wrong store, no error
appears anywhere, and the old credential keeps working until someone wonders why.

Two details of the sync that change what you should expect to see:

- An EMPTY value, or the literal `-`, is SKIPPED with a warning and leaves SSM
  unchanged (`:80`–`:83`). So a rotation cannot be performed by blanking the
  GitHub secret; that is a no-op, not a revocation. Note what that guard does and
  does not cover: it recognises exactly two placeholder forms. **Any other
  placeholder — `changeme`, `unset`, a description of the value — is a real string
  and IS written over the production secret**, and the service then fails at task
  launch or, worse, starts with a credential that does not work.
- `REDIS_URL` carries an extra regional guard and is skipped unless it names a
  `us-west-2` Valkey endpoint (`:100`–`:106`).

**2. `TOKEN_ENCRYPTION_KEY` is shared between the API and the `integrations`
service, and rotating it in one place breaks the other.**
`packages/api/src/lib/crypto-utils.ts` and
`packages/integrations/src/shared/crypto.ts` are the same AES-256-GCM
implementation over the same `iv:authTag:ciphertext` wire format, deliberately —
the integrations copy says so at `packages/integrations/src/shared/crypto.ts:1`
— because one process encrypts values the other decrypts. Both refuse anything
that is not 64 hex characters (`crypto-utils.ts:17`, `crypto.ts:28`).

The API's sync writes `/oxy/alia/TOKEN_ENCRYPTION_KEY` and nothing else. The
`integrations` service is deployed by no workflow in this repository — it has a
Dockerfile at `packages/integrations/Dockerfile` and no pipeline — so its
environment is somewhere this repo cannot see. Rotating the key here without the
same edit there does not raise an error at deploy time; it produces
authentication-tag failures on every read of an encrypted column, at the moment a
user next touches a connector or a bot.

## The inventory

Listed by where the value lives, because that decides who can read it and how it
is replaced. Everything above the last row is a Postgres column; the last row is
the environment.

| Credential | Where it lives | Form |
|---|---|---|
| Upstream provider API keys | `provider_keys.key` | **plaintext** |
| Developer API keys (`alia_sk_*`) | `developer_api_keys.key_hash` | sha256, irreversible |
| Telegram/platform bot tokens | `bots.bot_token` | encrypted |
| Per-bot inbound webhook secrets | `bots.webhook_secret` | **plaintext, indexed** |
| Bot account-linking tokens | `bot_users.auth_token` | plaintext, expiring |
| OAuth integration tokens | `integrations.oauth_*`, `connected_accounts.oauth_*` | encrypted |
| MCP connector OAuth state | `mcp_connector_auths.*` | encrypted |
| Messaging session credentials | `telegram_sessions`, `whatsapp_sessions`, `signal_sessions` | **plaintext**, projection-protected only |
| User-supplied MCP server config | `mcp_servers.config_headers`, `config_env` | **plaintext jsonb** |
| Oxy service webhook HMAC keys | `oxy_services.webhook_secret` | **plaintext** |
| Trigger webhook secrets | `triggers.webhook_secret` | **plaintext** |
| Process secrets | environment / SSM | plaintext |

Every row above except the last one lives in PostgreSQL, so it is reachable by
anyone with a production database connection, a replica, or a backup —
encryption narrows that to anyone who also holds `TOKEN_ENCRYPTION_KEY`, and the
two travel together in an incident. That is the honest read-access boundary for
this service, and it is wider than the SSM one.

---

## Provider API keys (`provider_keys`)

**Where it lives.** `provider_keys.key` holds the credential in PLAINTEXT
(`packages/api/src/db/schema/providers.ts:315`). Not a hash — `key_hash` is a
sha256 beside it (`:311`), and `key_prefix` is the first eight characters plus an
ellipsis, the only identifier that is safe to display or log (`:313`). The table
comment at `:274`–`:287` states the rule the schema cannot enforce: there is no
protected-column mechanism in `packages/api` yet (`:285`), so "never select this
column" holds by discipline alone.

Treat `key_hash` as equally sensitive. A hash of a credential is an exact-match
ORACLE: anyone holding a candidate key can confirm it against that column.

**Who can read it.** Anyone with a connection to the production database, and
anyone with a backup or replica of it. Not the AWS console, not SSM, not GitHub —
upstream provider credentials are NOT environment variables in this service, and
`docs/deployment.md` records the one leftover `GROK_API_KEY` read as dead code.

**There is no admin API for this table.** This is the fact that shapes the whole
procedure, and it is asserted rather than assumed:
`packages/api/src/routes/__tests__/inference-boundary.test.ts:458`–`:468` lists
`createProviderKey`, `updateProviderKey` and `deleteProviderKey` as writers with
zero runtime callers, and `:536`–`:556` fails if any route file calls one. The
gateway admin that used to expose them was retired by #141. So rotation is a SQL
statement, run by someone with production database access — and the repository
functions in `packages/api/src/db/providers/providerKeyRepository.ts` are the
reference for what a correct statement writes, not something you can invoke.

### Rotating one key

1. **Mint the replacement in the provider's own console first.** That is outside
   this repository and outside AWS; you need an account on the upstream provider.
   Alia never creates upstream credentials.

2. **Write it in place**, which is what `rotateProviderKey`
   (`providerKeyRepository.ts:330`–`:348`) does: replace `key`, recompute
   `key_hash` and `key_prefix`, and stamp `rotated_at`. All four together —
   `key_hash` carries a unique index (`providers.ts:392`), so a stale hash beside
   a new key is both wrong and the thing that will make the next insert fail
   confusingly.

   ```sql
   UPDATE provider_keys
   SET key        = :new_key,
       key_hash   = encode(digest(:new_key, 'sha256'), 'hex'),
       key_prefix = left(:new_key, 8) || '...',
       rotated_at = now(),
       updated_at = date_trunc('milliseconds', now())
   WHERE id = :id;
   ```

   `key_prefix`'s exact shape matters beyond display: the exposure runbook's
   step-1 query matches stored failure text against `rtrim(key_prefix, '.')`, so
   a prefix written in another format silently removes that row from a future
   audit. The expression above matches `providerKeyPrefix`
   (`providerKeyRepository.ts:62`), which is `key.substring(0, min(8, length)) +
   '...'` — but that is what the CODE writes, not a measurement of what existing
   rows hold. Check one row before trusting it across a batch.

   `digest()` needs `pgcrypto`. If the extension is not installed, compute the
   sha256 outside the database rather than installing an extension during a
   rotation.

3. **Wait ten seconds.** `key-manager.ts:35`–`:37` caches loaded keys per
   provider for 10 000 ms, and `loadProviderKeys` (`:46`–`:58`) serves that cache
   without consulting the database. Every running task holds its own copy, so the
   old value can still sign an upstream request for up to ten seconds after the
   `UPDATE` commits. There is no invalidation hook and no way to flush it short of
   restarting the tasks.

**Blast radius during the window:** none, if the old credential is still valid
upstream. The failure mode to plan for is the reverse order — revoking upstream
before writing the new value here — which produces up to ten seconds of 401s from
the provider, each one recorded by `recordKeyFailure`, which demotes the key's
`current_priority` to the back of the queue. The key recovers on the next success
(`recordKeySuccess`, `providerKeyRepository.ts:490`), so this is noisy rather than
lasting. Rotate here first, then revoke upstream.

### Rotating the keys found in git history

This is the job to do today, and it differs from a scheduled rotation in one
respect: **the old value is already public, so there is no safe window.** Revoke
upstream FIRST and accept the outage, rather than rotating here first and leaving
a published credential live for the convenience of a clean handover.

If the `alia` ECS service is still parked at `desiredCount: 0`, there is no
outage to accept — nothing is calling providers. Check before you plan around one
([rollback](./rollback.md) opens with the command).

For each key the audit named:

1. Revoke it in the provider's console. It is disclosed; nothing done in this
   repository changes that.
2. Mint a replacement and apply the `UPDATE` above, matching the row by
   `key_prefix` — you can find it without ever selecting `key`:

   ```sql
   SELECT id, name, provider, key_prefix, is_active, is_archived, last_used_at
   FROM provider_keys
   WHERE key_prefix = :prefix;
   ```

3. If no row matches, do not conclude the key was never here. Two cases produce
   an empty result and they need different responses: the key was a developer's
   own credential committed by accident and was never in this database, or it WAS
   here and has already been rotated, which changed `key_prefix`. Distinguish them
   with `SELECT count(*) FROM provider_keys WHERE provider = :provider` and the
   `rotated_at` values on those rows. Either way, revoking it upstream is
   required; only the second case has nothing left to update.
4. Record the row count and the date. `rotated_at` is the only durable evidence
   the rotation happened.

### Revoking a provider key

`loadActiveProviderKeys` (`providerKeyRepository.ts:135`–`:150`) selects on
`is_archived = false AND is_active = true`, so either flag removes a key from
routing:

```sql
UPDATE provider_keys
SET is_active = false, is_archived = true,
    archived_at = now(), archived_reason = :reason
WHERE id = :id;
```

Prefer this to `DELETE`. The row carries the spend and failure history, and
`key_hash` is what makes "has this credential been seen before" answerable. If
the plaintext itself must go, `SET key = NULL` — `key-manager.ts:138`–`:141`
skips a key with no stored value and logs a warning, so a null-keyed row is inert
rather than broken.

**A key can also archive itself.** `recordKeyFailure`
(`providerKeyRepository.ts:437`–`:469`) sets `is_archived = true` and
`is_active = false` once `total_failures` reaches `max_total_failures`, writing
`archived_reason` as `Archived after N total failures`. So an archived key you did
not archive means the credential has been failing upstream — check
`last_failure_reason` before assuming a colleague revoked it. Rate-limit failures
are excluded from that count (`:445`–`:447`); only real failures accumulate.

**Blast radius:** the same ten-second cache. Beyond that, if you revoke the LAST
active key for a provider, requests routed to it fail; the fallback engine tries
other providers, and a tier with no reachable provider fails outright.

**One consequence worth knowing before you revoke in bulk.** `/health/ready`
returns 503 `no_healthy_providers` when no provider is healthy and at least one
is known (`packages/api/src/routes/health.ts:144`–`:148`) — but the `oxy-alia`
target group health-checks `/health/live`, which consults nothing
(`packages/api/src/routes/health.ts:28`, `:132`). So a task with every provider
key revoked stays IN the load balancer and keeps accepting requests it cannot
serve. Readiness will tell you; the load balancer will not act on it.

---

## Developer API keys (`alia_sk_*`)

**Where it lives.** Only the sha256 does — `developer_api_keys.key_hash`
(`packages/api/src/db/schema/developers.ts:90`), unique-indexed at `:109`. The
plaintext is returned exactly once, at creation
(`packages/api/src/routes/developer.ts:239`, with the warning at `:244`), and is
not recoverable afterwards by anyone including an operator. `key_prefix` is the
first sixteen characters, `alia_sk_` plus eight (`:224`).

**Who can read it.** Nobody. The digest is still an exact-match oracle and
belongs out of responses, but there is no procedure that recovers a lost key —
the answer is always to issue a new one.

**Rotation is issue-then-delete, and it is the key OWNER's action**, not an
operator's. The routes are mounted at `/developer` behind user authentication
(`packages/api/src/index.ts:260`):

1. `POST /developer/apps/:appId/keys` returns the new plaintext once
   (`developer.ts:208`).
2. The owner updates their client.
3. `DELETE /developer/apps/:appId/keys/:keyId` (`developer.ts:311`), which also
   deletes the key's usage rows (`:330`).

**Revocation** is `PATCH …/keys/:keyId` with `isActive: false`
(`developer.ts:280`, schema at `:276`), or the `DELETE`. Prefer the PATCH when
you may need the usage history; the DELETE discards it.

**Blast radius: none, and effect is immediate.** `authenticateApiKey`
(`packages/api/src/middleware/auth.ts:142`–`:158`) hashes the presented key and
looks it up on every request, checking `isActive` (`:150`) and `expiresAt`
(`:155`) each time. There is no cache anywhere on this path — the contrast with
provider keys' ten-second window is deliberate and worth remembering under
pressure. A deactivated key stops working on the next request.

Deactivating the parent app is the wider hammer: `:161` rejects when the app is
inactive, which revokes every key under it at once.

---

## Bot tokens and per-bot webhook secrets

Two credentials on one table with deliberately OPPOSITE storage, and the reason
is structural rather than a judgement call — `packages/api/src/db/schema/bots.ts:1`–`:33`
sets it out.

**`bots.bot_token` is encrypted** (`bots.ts:75`, via `encryptedText` at
`packages/api/src/db/schema/columns.ts:73`–`:77`). It is only ever decrypted to
call the platform.

**`bots.webhook_secret` is PLAINTEXT and indexed** (`bots.ts:81`, index at
`:96`), because it is a LOOKUP KEY: inbound updates are matched by it
(`packages/api/src/db/integrations/botRepository.ts:134`–`:142`). Encrypting it
would not weaken routing slightly, it would break it completely and silently,
because AES-GCM with a random IV never produces the same ciphertext twice.

### Rotating a user bot's token

The owner does this in the Agent editor, not an operator: revoke the token with
@BotFather, issue a new one, and update the bot. An operator holding only
database access cannot mint a Telegram token.

To revoke Alia's ability to act as a bot immediately, without touching Telegram:

```sql
UPDATE bots SET status = 'inactive' WHERE id = :id;
```

Inbound routing requires an ACTIVE user-owned bot, so this stops both directions.

### Rotating a per-bot webhook secret

Generate a new secret, write it, and re-register the webhook with the platform so
it echoes the new value in `X-Telegram-Bot-Api-Secret-Token`. **These must happen
together.** Between the write and the re-registration, inbound updates carry the
old secret, match no row, and fall through to the global-bot path — a silent
mis-route, not an error. Do it during a quiet window and confirm with a test
message.

There is no overlap mechanism here: the column holds one value and the lookup is
an equality match. A dual-secret window would need a second column, which is a
code change, not an operational choice.

### The system bot

The shared bot is configured from the environment — `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_BOT_SECRET` (`packages/api/src/lib/channels/plugins/telegram.ts:28`–`:29`,
verified at `packages/api/src/middleware/auth.ts:327`). Neither is in the
deploy workflow's sync list, so both are managed in SSM by `oxy-infra`. Rotating
either requires a task restart: the values are read from `process.env` and a
running task does not see an SSM edit.

**CRITICAL, when touching anything here:** every "find the system bot" lookup must
stay scoped to rows with no `user_id`. User bots share the table
(`bots.ts:72`), and an unscoped lookup can bind a global flow to a user's bot.

### Bot account-linking tokens

`bot_users.auth_token` (`bots.ts:134`) is a short-lived linking credential,
plaintext because the redemption path looks a row up by it, bounded by
`auth_token_expiry` (`:135`). There is deliberately no expiry sweep — the comment
at `:110`–`:115` explains that deleting the row would discard the link itself.
To revoke one, null the token; the link survives.

---

## Encrypted OAuth and connector tokens

Encrypted with AES-256-GCM under `TOKEN_ENCRYPTION_KEY`:

- `integrations.oauth_access_token` / `oauth_refresh_token`
  (`packages/api/src/db/schema/integrations.ts:94`, `:96`) and the same pair on
  `connected_accounts` (`:162`, `:164`), through the `encryptedText` codec
- `mcp_connector_auths.client_information`, `tokens`, `code_verifier`
  (`packages/integrations/src/db/schema/mcpAuth.ts:26`–`:30`). These are `text`
  columns holding values the OAuth provider encrypted before writing
  (`mcpAuth.ts:8`–`:13`) rather than a codec on the column, but the key and the
  wire format are the same.

**Not encrypted — protected only by projection.** This is the distinction to get
right, because "protected" reads like "encrypted" and is a much weaker property.
`packages/integrations/src/db/protectedColumns.ts:19`–`:40` excludes these from
`db.select()` at the TYPE level, which stops them being serialized into a
response. It does nothing at rest:

- `telegram_sessions.session_string` — plain `text`
  (`packages/integrations/src/db/schema/telegram.ts:43`). It is a GramJS
  `StringSession`: a FULL ACCOUNT credential that needs no second factor to reuse
  (`:39`–`:41`). Possession is the account.
- `whatsapp_sessions.auth_state` and `auth_keys` — plain `jsonb`
  (`packages/integrations/src/db/schema/whatsapp.ts:45`, `:47`). Baileys
  credentials; possession is the WhatsApp account.
- the `last_qr` columns on all three session tables — short-lived, but a live
  pairing credential while valid.

So a database dump exposes every messaging session outright, with no second
factor and no key required. Weigh that when scoping backup and replica access;
it is a stronger reason than the encrypted columns, which need
`TOKEN_ENCRYPTION_KEY` as well.

**Revocation for all of these is the same:** delete the row and have the user
reconnect. There is no re-issue path an operator can drive — the credential
belongs to a third party and only the user can re-authorize. Deleting a
`mcp_connector_auths` row sends that user back through the OAuth flow on their
next tool call.

**Two columns in this area are NOT encrypted and hold secrets anyway.**
`mcp_servers.config_headers` and `config_env`
(`packages/api/src/db/schema/integrations.ts:227`, `:229`) are arbitrary maps a
user supplies to reach their own MCP server, and an API key in an `Authorization`
header is the ordinary case. Their shape belongs to whichever server the user
configured, which is why no typed allow-list is available and the projection rule
is the only defence (`:14`–`:21`). Treat them as user-owned credentials in
plaintext: never select them into anything the user did not ask for, and if the
database is exposed, they are exposed.

---

## Webhook HMAC keys

**`oxy_services.webhook_secret`** (`packages/api/src/db/schema/oxy-services.ts:118`)
verifies inbound signatures from other Oxy apps. Unlike the bot one it is a
VERIFICATION key, found by `service_id` rather than looked up by
(`oxy-services.ts:10`–`:12`), so it could be encrypted; it is not, and the file
says why that stayed a separate decision (`:12`–`:15`). Rotating it requires the
same value on the other side, so coordinate with the owning app; the window
between the two edits is one where every event that service sends fails
verification.

**`triggers.webhook_secret`** (`packages/api/src/db/schema/automation.ts:100`) is
an optional per-trigger HMAC secret, user-owned, alongside `webhook_token`
(`:98`) which is the public URL's path segment and also a lookup key. Rotating
the token changes the trigger's URL; rotating the secret changes only the
signature. Both are the user's to rotate, through the triggers API.

**Stripe's webhook secret** is read at request time in
`packages/api/src/routes/billing.ts:621`, which returns 500 when it is absent.
It is not in the sync list, so it lives in SSM.

**CrowdSource has the only OVERLAP-WINDOW rotation this repository implements**,
and it is the pattern to copy if a second one is ever needed.
`CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS` is read alongside the current secret
(`packages/api/src/lib/crowdsource/config.ts:115`–`:117`) and passed as
`previousSecret` (`packages/api/src/routes/crowdsource-webhook.ts:99`–`:106`), so
both verify during a rotation. The sequence is: set `…_PREVIOUS` to the current
value, set the current to the new one, restart, have the sender cut over, then
clear `…_PREVIOUS` and restart again.

Both values are read once when the route is constructed
(`crowdsource-webhook.ts:85`, `:99`), so **each step needs a task restart** — an
SSM edit alone changes nothing in a running process. Note also that the route is
NOT MOUNTED at all when the secret is absent (`:86`–`:97`), so an unconfigured
deployment 404s rather than accepting unverified events; clearing that secret is
a way to disable the endpoint entirely.

---

## Process secrets

All of these are environment variables injected by ECS at task launch. **Every
one requires a task restart to take effect** — nothing re-reads `process.env`,
and several are captured at module load.

### `SERVICE_SECRET` — the highest-privilege value in the inventory

Presented as a bearer token it authenticates the caller as `system` with
`scopes: ['internal']` (`packages/api/src/middleware/auth.ts:257`–`:271`,
constant-time compared at `:259`–`:260`). It is not scoped to a route, a user or
a tenant. Anyone holding it is an internal service.

In the sync list, so rotate it in **GitHub repository secrets**, then run a
deploy. Its readers capture it at module load
(`packages/api/src/lib/gateway-client.ts:32`,
`packages/api/src/lib/tools/gateway-admin.ts:8`), so only a restart lands it.

**Blast radius:** internal callers presenting the old value get 401 until they are
updated too — the browse tool
(`packages/api/src/lib/tools/browse.ts:66`) and agent browser sessions
(`packages/api/src/lib/agent/browser-session.ts:399`) are in-process and rotate
with the task, but anything outside this repository that holds it must be rotated
in the same window.

One trap specific to this variable: setting `GATEWAY_API_URL` alongside it flips
`gateway-client.ts:32` into remote mode, pointed at a service that no longer
exists. Leave `GATEWAY_API_URL` unset while rotating.

### `TOKEN_ENCRYPTION_KEY` — the one that cannot be rotated in place

Read the second governing fact above before starting. Then understand what makes
this different from every other entry: **rotating it does not invalidate old
values, it makes them unreadable.** `encryptedText.fromDriver` calls `decrypt`
(`packages/api/src/db/schema/columns.ts:76`), so every read of an encrypted
column under a new key fails its authentication tag — bot tokens, both OAuth
token pairs and the MCP connector credentials, all at once, across two processes.
The plaintext messaging sessions are unaffected, which is the one silver lining
of their being plaintext.

A rotation that preserves data is a re-encryption: decrypt every value with the
old key and re-encrypt with the new one, in one pass, with both services stopped.
That code does not exist in this repository. The options actually available today
are:

- **Rotate and re-authorize.** Change the key in GitHub secrets AND in the
  `integrations` service's environment, deploy both, then delete every encrypted
  row and have users reconnect. Loud, correct, and users notice.
- **Write the re-encryption tool first.** A one-shot task that reads with the old
  key and writes with the new one. It must cover both processes' tables — the API
  schema's encrypted columns and `mcp_connector_auths` — and it must run with
  nothing else writing.

Either way, the two services must move TOGETHER. Deploying the API's new key
while `integrations` holds the old one is the failure this document's second
governing fact exists to prevent, and it presents as user-visible connector
errors rather than as anything a deploy reports.

### `INTEGRATIONS_SECRET`

The shared secret on the API↔integrations hop, sent as `X-Gateway-Secret`
(`packages/api/src/routes/mcp.ts:95`, `packages/api/src/routes/accounts.ts:45`).
The integrations service refuses to start without it
(`packages/integrations/src/index.ts:23`–`:27`).

**Not in the sync list**, so SSM/`oxy-infra` is the source of truth on both sides.
Both processes must carry the same value; the API captures it at module load
(`packages/api/src/routes/mcp.ts:35`). There is no overlap mechanism, so the
window between restarting the two services is one where MCP tool calls and
account operations fail with an auth error. Restart the integrations service
last, or accept a short failure window.

### The rest

| Variable | Sync list? | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Rotating the database password is an `oxy-infra` / RDS action first. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | yes | A pair. Rotating invalidates every existing push subscription — clients must re-subscribe. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | yes, `/oxy/_shared/*` | Shared across Oxy apps: rotating affects every consumer of that path, not just Alia. |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | yes, `/oxy/_shared/*` | Same shared-path caveat. |
| `REDIS_URL` | yes, `/oxy/_shared/*` | Extra regional guard; a non-`us-west-2` endpoint is skipped. |
| `DOCKER_HOST_SECRET` | no | SSM. Shared with the docker-host service. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_SECRET` | no | SSM. See *The system bot*. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | no | SSM. Rotate in the Stripe dashboard first. |
| `CROWDSOURCE_SERVICE_KEY` / `CROWDSOURCE_WEBHOOK_SECRET` | no | SSM. The webhook secret has an overlap window; the service key does not. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | no | SSM. Serves the two hand-written OAuth integrations that remain only because they have no hosted MCP. |
| `DISCORD_*`, `SLACK_*`, `WHATSAPP_*`, `SIGNAL_BOT_SECRET` | no | SSM, per channel. |

The authoritative list of what a running task actually consumes is the LIVE ECS
task definition's `secrets[]`, not this table and not `.env.example`. Read it
before rotating anything in the "no" column, because a variable absent from the
task definition can be rotated with no effect at all — and one present but not in
`.env.example` will not appear in any list this repository holds.

---

## What this repository cannot do

Named explicitly, because each is a step that looks runnable here and is not:

- **Mint or revoke an upstream provider credential.** Provider consoles only.
- **Read or write SSM, or restart an ECS task.** `oxy-infra` owns the parameter
  tree, the task definition and the service; you need AWS access under the `oxy`
  profile in `us-west-2`.
- **Deploy the `integrations` service.** No workflow here does. Its environment,
  including its half of `TOKEN_ENCRYPTION_KEY`, is set elsewhere.
- **Reach the production database.** Every SQL statement above needs a connection
  this repository does not provide and its CI never has.
- **Re-encrypt data under a new `TOKEN_ENCRYPTION_KEY`.** No such tool exists.

## Open questions

- **Has the git-history provider-key rotation been performed?** The #139 checkbox
  `Audit git history and deployment logs for exposed credentials; rotate where
  necessary.` is open. Nothing in this repository records a rotation date; the
  evidence would be `rotated_at` on the affected `provider_keys` rows.
  *Owner: the #139 epic owner.*
- **What is in the live task definition's `secrets[]`?** The table above is
  derived from the deploy workflow and from `process.env` readers in source, which
  is a claim about the CODE, not about the deployment. *Owner: whoever holds AWS
  access, with `oxy-infra`.*
- **Should `provider_keys.key` be encrypted at rest?** It is plaintext today for
  a faithful-port reason, not a considered one, and the schema comment
  (`providers.ts:285`) records that the protected-column mechanism `integrations`
  has was never built in `packages/api`. *Owner: the #139 epic owner —
  workstream 18's `Remove provider secrets from Alia runtime` may make the
  question moot.*
- **Is there a rotation schedule?** `provider_keys.rotation_schedule` exists with
  a `manual` default (`providers.ts:365`–`:367`) and `expires_at` beside it
  (`:364`). Both appear only in the schema and in the safe projection
  (`providerKeyRepository.ts:117`–`:118`); no code branches on either — measured
  against `cooldown_until`, which is read as a routing decision at
  `key-manager.ts:121`. So an EXPIRED key is still selected and still used. They
  are recorded intent, not enforcement, and a reader who assumes otherwise will
  believe expiry is handled. *Owner: the #139 epic owner.*
