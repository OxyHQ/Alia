# Runbook: provider credentials in the git history, the logs and `provider_keys`

Three places a credential can be, and they need different answers. Read the one that
applies:

| Where | Status | Section |
|---|---|---|
| This repository's PUBLIC git history | **MEASURED, three live keys found** | [The git-history audit](#the-git-history-audit) |
| CloudWatch, the deployment logs | UNRUN, needs AWS access | [Step 3](#step-3--the-same-question-about-the-logs) |
| `provider_keys.last_failure_reason` | UNRUN, needs database access | [Step 1](#step-1--does-any-stored-row-contain-key-material) |

---

## The git-history audit

**Run 2026-08-17 over the 1 700 commits reachable from `main` — 9 565 blobs,
456 MB. Four matches in two blobs. Three of them are live upstream provider
credentials and this repository is PUBLIC.**

Reproduce it, at any time, with:

```bash
bun run --filter @alia/api scan:credentials
```

Exit `0` means every finding is recorded and rotated, `1` means a credential is in
the history that nobody has recorded, `2` means every finding is recorded and at
least one is still waiting for a rotation. It prints paths, blobs and eight-character
prefixes and never a value.

### What was found

`packages/api/src/lib/security/known-disclosures.ts` is the machine-readable ledger
and is the authority; this table is it in prose. No value appears in either, by
design — an eight-character prefix is enough to match a row against
`provider_keys.key_prefix` and is not enough to use.

| What | Where | In | Out | Decision |
|---|---|---|---|---|
| Google Generative Language key (Gemini) | `keys.json` | `94a0ba8d` | `3ccbf430` | **Revoke and replace** |
| Groq key (Llama) | `keys.json` | `94a0ba8d` | `3ccbf430` | **Revoke and replace** |
| OpenAI project key (`sk-proj-…`, GPT-4o) | `keys.json` | `94a0ba8d` | `3ccbf430` | **Revoke and replace** |
| Firebase Android client key | `apps/app/google-services.json` | `413ffa3f` | `042baefd` | Restrict, do not rotate |

`keys.json` was a three-entry provider-key fixture (`{provider, modelId, key}`)
committed and deleted on the same day, 2026-01-14. **Deleting a file removes it from
the tree and from nothing else** — the blob is in every clone, every fork and every
archive of this repository, and has been for seven months.

The Firebase entry is a different kind of value and is classified separately rather
than rotated by reflex: Google ships `google-services.json` inside every APK, so its
`AIza…` key is a client identifier whose protection is API restrictions in the Cloud
console, not secrecy. It was removed from the tree and gitignored on 2026-03-11.
Confirm the key has application and API restrictions; do not treat its presence here
as a breach.

Not found, and each of these is a claim about a measurement rather than an absence
nobody looked for: no `.env` file has ever been committed (the only credential-shaped
paths in the whole history are the two above plus Android's standard `debug.keystore`,
whose password is the public constant `android`); no AWS key, GitHub token, Stripe key,
Slack token or private-key block appears in any blob.

### What to do about it

The three provider keys are already public, so there is no safe window and no clean
handover: **revoke upstream first and accept the outage.** The full procedure —
including how to find the `provider_keys` row without ever selecting `key`, and what
to conclude when no row matches — is
[credential-rotation § Rotating the keys found in git history](./credential-rotation.md#rotating-the-keys-found-in-git-history).
When each is done, set `rotatedAt` on its entry in `known-disclosures.ts` in the same
change; that field is the only durable record that it happened.

**Do not try to rewrite the history.** `git filter-repo` changes what this remote
serves and reaches no fork, no CI cache, no mirror and no archive, while breaking every
open branch and every commit reference in this repository's own documentation. It
would not un-publish a single one of these values, and the ledger is written on the
assumption that it will not be attempted.

### What the audit does NOT cover

- **A credential from one of the seven providers with no distinctive prefix** —
  Mistral, Cohere, Together, SambaNova, Hyperbolic, Novita, Cloudflare. Their keys are
  opaque strings and no pattern can recognise one. The same blind spot the runtime
  redactor has, for the same reason.
- **Any blob over 2 MB, and any blob containing a NUL byte.** Lockfiles and binaries
  are skipped; a credential inside a committed archive or an image would not be seen.
- **Deployment logs.** [Step 3](#step-3--the-same-question-about-the-logs) below is
  still unrun. What HAS been checked is the workflows that write them: no version of
  `deploy-aws.yml` has ever echoed a secret VALUE — the `toJSON(secrets)` step that
  `d9c2a079` replaced piped the context into `jq` and printed only parameter PATHS.
  One residual worth knowing: `aws ssm put-parameter --value "$value"` passes each
  secret on a command line, so it is briefly readable in `/proc` on the runner. That is
  a property of the AWS CLI's interface, not of this workflow, and it is recorded here
  rather than worked around.

---

## Provider credentials quoted back into logs and `provider_keys`

An upstream provider's error body is text Alia forwards without controlling it, and a
rejected credential is frequently part of it — OpenAI's 401 body begins
`{"error":{"message":"Incorrect API key provided: sk-…"}}`. Until #139 workstream 15 that
body was written to the logs in full and up to 200 characters of it were stored in
`provider_keys.last_failure_reason`, a column inside the safe projection.

Both writers are now redacted at the point the body is read
(`packages/api/src/internal/providers/lib/provider-error-body.ts`) and at the point an
error is serialized (`packages/api/src/lib/logger.ts`). Neither change touches data that
was already written.

**Everything below is UNRUN.** These steps need production database and CloudWatch
access, which the change that produced this runbook deliberately did not have and did not
seek. Nobody has established whether any stored row or any retained log line contains key
material. Treat each step as open until someone with access records its output and the
date they ran it.

## Step 1 — does any stored row contain key material?

Against the production database, read-only:

```sql
SELECT id, provider, key_prefix, left(last_failure_reason, 120) AS excerpt
FROM provider_keys
WHERE last_failure_reason ~ '(sk-|AIza|gsk_|xai-|r8_|dop_v1_|fw_|pplx-|csk-|alia_sk_|Bearer )';
```

The prefix list is the same one `packages/api/src/lib/agent/secret-scanner.ts` matches, so
a row this query returns is a row the new redaction would have caught. It does **not**
cover the seven providers whose keys have no distinctive prefix (Mistral, Cohere,
Together, SambaNova, Hyperbolic, Novita, Cloudflare); for those, compare against
`key_prefix` instead:

```sql
SELECT id, provider, key_prefix
FROM provider_keys
WHERE last_failure_reason IS NOT NULL
  AND key_prefix IS NOT NULL
  AND position(rtrim(key_prefix, '.') in last_failure_reason) > 0;
```

`key_prefix` is stored as the first eight characters plus `...`, so `rtrim` is what makes
the comparison match an echo of the key itself rather than the display form.

## Step 2 — if either query returns rows

1. **Rotate every matched key**, in the provider's own console. Scrubbing the column does
   not un-expose a value that has been in the database and therefore in every backup and
   every replica since it was written. Rotation is the remedy; the scrub below only stops
   it spreading further.
2. **Then** clear the stored text:

   ```sql
   UPDATE provider_keys
   SET last_failure_reason = NULL
   WHERE last_failure_reason ~ '(sk-|AIza|gsk_|xai-|r8_|dop_v1_|fw_|pplx-|csk-|alia_sk_|Bearer )';
   ```

   `NULL` rather than a partial `regexp_replace`: the column is a diagnostic convenience,
   the matched rows are by definition stale failures, and a regex that half-scrubs is
   worse than an empty column because it reads as clean. Run the `SELECT` first and record
   the row count, so the `UPDATE`'s effect can be checked against it.

## Step 3 — the same question about the logs

The API runs on ECS Fargate in `us-west-2`, so its stdout is CloudWatch. Search the full
retention window of the Alia API log group, and the `integrations` service's log group
too:

```
aws logs filter-log-events --log-group-name <alia-api-log-group> \
  --filter-pattern '?"sk-proj-" ?"sk-ant-" ?"AIza" ?"gsk_" ?"xai-" ?"dop_v1_" ?"Incorrect API key provided"' \
  --start-time <epoch-ms> --profile oxy --region us-west-2
```

CloudWatch filter patterns are not regular expressions; the literal prefixes above are
what work there. Any hit means the matched credential is disclosed to everyone with log
read access, and rotation is required — deleting log events does not undo the disclosure.

## What changed, so the same question does not have to be asked again

- `internal/providers/lib/provider-error-body.ts` is the only place in the provider tree
  that turns a response into a string. It removes the credential that was sent, by exact
  value, so a truncated echo or one inside a URL is caught too, and then runs the pattern
  scrubber for credentials it did not send.
- `lib/logger.ts` scrubs every error it serializes. That is the only chokepoint that can
  see an error Alia did not construct — the AI SDK's `APICallError` carries the raw
  upstream body on `responseBody`, and the chat path logs that object directly.
- `db/providers/providerKeyRepository.ts` redacts before it truncates, so the column
  cannot hold key material even if a future writer bypasses the provider tree.
- `packages/api/src/__tests__/architectureGates.test.ts` gate 4 fails if a new
  `.text()` appears in the provider tree outside the chokepoint, if the logger loses its
  serializer, or if the column write stops going through the redactor.

## What is still not covered

- A credential belonging to another account, issued by a provider with no distinctive
  prefix, echoed by a provider we did not send it to. No pattern can see it and neither
  can the exact-value pass.
- A credential interpolated into a log MESSAGE rather than into `{ err }`. Message strings
  do not reach a pino serializer. Nothing does this today, and it stays true only because
  no unredacted body exists as a string to interpolate.
- `packages/integrations`, which holds encrypted OAuth tokens and has its own log paths.
  It was not in scope here.
