# Runbook: provider credentials quoted back into logs and `provider_keys`

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
