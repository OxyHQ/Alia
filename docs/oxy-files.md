# Alia on Oxy Files

How Alia stores bytes under oxy ADR 0043 (application-owned files, references,
lifecycle), how existing bytes move out of Alia's own bucket, and when that
bucket can be retired. The decision is [ADR 0019](./adr/0019-alia-stores-files-in-oxy-files.md);
the code is `packages/api/src/lib/files/`.

## Who owns what

| What | Owner | Visibility | Reference (`entityType`/`entityId`) | Where today |
|---|---|---|---|---|
| A show's cover art | **Alia** (Alia draws it) | public | `show_series`/series id | **Oxy Files** once `SYRA_COVER_FILE_IDS=enabled`; until then Syra's image store, as before |
| A library upload | **the person** | private | `library_file`/row id | **Oxy Files** (`uploadUserMedia` for media ≤ 40 MiB, else `uploadUserMediaLarge`) |
| A spoken clip (TTS cache) | **Alia** (a cache Alia expires) | private | `speech_clip`/cache key | **Oxy Files** (`uploadAppFile`, audio) |
| A catalogue skill's bundled file | **Alia** | private | `skill_file`/row id | **Oxy Files** (`uploadAppFileLarge`; small media streamed) |
| A person's own skill's bundled file | **the person** | private | `skill_file`/row id | **Oxy Files** (`uploadUserMediaLarge`; small media streamed) |
| A show's working segments | — | — | — | **not stored at all** |
| A published episode's audio | Syra | — | — | Syra (unchanged) |

- **A spoken clip is Alia's, not the person's.** It is a 30-day cache that Alia
  deletes when unused and with its conversation. An account's file is never
  deleted behind its owner's back (ADR 0043 D5), so a clip owned by the person
  could never expire; it would pile up as "not in use" in their file manager.
  As Alia's, releasing the reference IS the expiry: Oxy trashes an unreferenced
  application file after 24 hours and purges it 30 days later.
- **Show segments were never content.** The pipeline wrote every spoken line to
  `show-segments/` as "working storage", joined the episode from the buffers it
  already held, and deleted the objects in a `finally` — so nothing read them,
  and a worker that died mid-run leaked them. They are now joined in memory and
  never stored; the published file lives in Syra.
- **Syra uses Alia's cover; it does not own it.** `createPodcast` /
  `updatePodcast` receive `imageFileId` (Syra #214, `@syra.fm/sdk` 0.21.0); Syra accepts
  only an active public image owned by the caller or by an application in its
  `SYRA_COVER_APPLICATION_IDS` (Alia's id), and registers its own `podcast`
  reference. Deleting a series releases Alia's reference; deleting the podcast
  releases Syra's; Oxy collects the file when neither uses it.
- **Until Syra takes a file, a cover is uploaded into Syra.** A Syra without
  `imageFileId` would drop the field and leave the show without art, so
  `storeCoverForShow` (`lib/files/oxy-files.ts`) uploads it with
  `uploadPodcastImage` and records `cover_image_asset_id`, exactly as before
  this change, unless `SYRA_COVER_FILE_IDS=enabled`. Switch it on only after
  Syra is deployed with #214 and Alia's application id is in its
  `SYRA_COVER_APPLICATION_IDS`; a series made before the switch keeps its Syra
  cover until the cover migration below moves it.

## How a use reaches Oxy

Every row that names an Oxy file records the use in the **same transaction** as
the row (`oxy_file_reference_sync`, `db/files/oxyFileRepository.ts`): a desired
state, `present` or `absent`, per (file, entity). Writing the row and telling
Oxy can therefore never disagree after a crash. The worker
(`lib/files/oxy-file-sync.ts`) drains it on every task under leases into
`references.add` / `references.remove`, backing off 1 minute doubling to 6 hours
and dead-lettering after 16 attempts. `not_found` on an add (the file is gone, or
not one Alia may use) is not retried; the next reconciliation reports it as
`refused`.

Upload → reference is one flow: the bytes are stored first (never inside a
database transaction), the row and its reference commit together. If the row
never commits, the stored bytes are named by nothing, and each kind is collected
by construction:

- an Oxy file **Alia** owns has no reference, so Oxy trashes it after 24 hours;
- a legacy object was marked in `storage_gc_candidates` **before** it was
  written, with an hour's grace; the collector deletes it once no row names it;
- a **person's** Oxy file stays theirs, shown as "not in use" — ADR 0043 D5 —
  never deleted behind their back.

This is what fixes the skill store's old "uploaded, then the transaction
failed" orphan (and the leak of every deleted skill's objects, which the
deterministic keys never covered): skill rows and their file references commit
together, and keys are unique per upload so the collector can never take a key
another import is rewriting.

**Nightly reconciliation** (ADR 0043 D6) sends Oxy the full inventory of each
entity type, streamed from Postgres in keyset pages. It runs once a day per type
on the trigger-engine leader, claimed through `oxy_file_reconcile_runs` (which
also records the last result), so restarts and several tasks still run it once.
Every entity type is reconciled: `show_series`, `library_file`, `speech_clip`
and `skill_file`.

## File events

`POST /webhooks/oxy-files` receives Oxy's file events, mounted above
`express.json()` because the `oxy-signature` HMAC covers the raw bytes, and
verified with `verifyFileEventSignature` from `@oxy.so/core/server`.

1. In Oxy Console → Alia → Webhooks → **File events**, set
   `https://api.alia.onl/webhooks/oxy-files`. Oxy sends a `webhook.challenge`
   that the endpoint echoes; the console shows the `whsec_…` secret **once**.
2. Write it to SSM: `/oxy/alia/OXY_FILES_WEBHOOK_SECRET`, then bind it in the
   task definition (SSM first, then the binding — `docs/deployment.md`).
   Without the secret the route answers 404 to everything.

| Event | What Alia does |
|---|---|
| `file.deleted`, `file.blocked` | every row of Alia that used the file lets go of it: a series loses its cover (the legacy Syra cover too — same bytes, so showing it would route around a takedown), a library file or a spoken clip loses its row; a skill's bundled file is logged as an error (a published version cannot drop a file; the file route answers 404 for it) |
| `file.trashed`, `file.restored`, `file.unblocked`, `file.visibility_changed` | logged; a cover that stops being public is logged as an error |

Delivery is at least once. An event is remembered (`oxy_file_events`, 30 days)
only after it was handled, so a failure answers 500 and is delivered again.

## Moving what is already stored

`src/scripts/migrate-to-oxy-files.ts`, bundled to
`packages/api/dist/scripts/migrate-to-oxy-files.js`. It acts as Alia through the
task role's attested identity, which a checkout does not have, so it runs as an
ECS one-shot on the live task definition (the same networking and role as the
service), with the command overridden:

```bash
TD=$(aws ecs describe-services --cluster oxy-cluster --services alia \
  --query 'services[0].taskDefinition' --output text)
NET=$(aws ecs describe-services --cluster oxy-cluster --services alia \
  --query 'services[0].networkConfiguration' --output json)
aws ecs run-task --cluster oxy-cluster --launch-type FARGATE --task-definition "$TD" \
  --network-configuration "$NET" --overrides '{"containerOverrides":[{"name":"alia",
  "command":["bun","packages/api/dist/scripts/migrate-to-oxy-files.js",
  "--target-database=alia","--kind","library"]}]}'
```

The report (one JSON line per item) goes to the task's log; the summary line is
the last one. Preview is the default; `--apply` writes. Every run names its database
(`--target-database`), reads each item, hashes it, and copies it only if the
hash Oxy reports equals the hash of what was read (a skill file must also match
the sha256 its row was written with). Reports are JSON lines with sha256
hashes, never URLs. The work list is "rows naming a legacy object and no Oxy
file", and an applied item sets its Oxy column and reference in one
transaction, so a stopped run resumes where it stopped. The legacy copy is kept
as the read fallback until the bucket is retired.

An apply is paced to Oxy's upload budget: Oxy lets an application make 30
uploads a minute, a large upload spends two (start and complete), and the run
spends at most 24 of them (`MIGRATION_UPLOADS_PER_MINUTE`) so Alia's live writes
keep the rest. An item Oxy answers 429 waits a minute and is tried again; it is
reported `failed` only after eleven 429s in a row.

### Covers: two steps, Alia first, after Syra #214 is deployed

1. **Alia** copies each legacy cover — the EXACT bytes Syra serves at
   `GET {SYRA_API_URL}/api/images/:id`, never re-encoded — into an Alia-owned
   public file, references it, and sets `show_series.cover_file_id`:

   ```bash
   bun run --cwd packages/api migrate:oxy-files --target-database <db> --kind show-covers \
     --report covers-preview.jsonl                      # preview
   bun run --cwd packages/api migrate:oxy-files --target-database <db> --kind show-covers \
     --apply --report covers-apply.jsonl --syra-mapping covers-handover.jsonl
   ```

   `covers-handover.jsonl` is the operator's record, one line per podcast:
   `{"syraPodcastId","legacyImageAssetId","fileId","sha256"}` (sha256 as Oxy
   reports it). It is regenerated complete on every run, whatever earlier runs
   copied.
2. **Syra** then runs `migrate:alia-covers --apply`: for each podcast with an
   `alia_series_id` whose cover is still a legacy bucket image, it hashes its
   own legacy object, finds the Oxy file with that sha256, and repoints the
   podcast only if that file is owned by an application in
   `SYRA_COVER_APPLICATION_IDS` (Alia), active and an image. That is why step 1
   must upload the exact bytes, and must run first.

The app reads `coverFileId` first (through Bloom's image resolver, bound to
`oxyServices.assets.publicUrl`) and Syra's legacy image only when there is none.

### Library files, spoken clips, skill files

New writes go to Oxy with no switch (stage 4c, OxyHQ/oxy#1774, is in
production). A write that fell back logs `Oxy did not take private content;
storing it in the legacy bucket` with its `kind` and `reason` (CloudWatch
`/oxy/ecs`, streams `alia/…`), and leaves a row on legacy storage that
`--status` counts (`rowsOnLegacyStorage`). The process counters
(`alia_oxy_files_fallback_writes_total`, `alia_legacy_storage_reads_total`) are
not scraped — the API serves no `/metrics` — so the log and `--status` are what
to watch. A steady `not_private` or `oxy_404` means Oxy stopped serving 4c, an
incident on Oxy's side; every such write still lands in the bucket and is moved
by the next backfill.

Backfill each kind, preview first, then a canary, then the rest (arguments to
the one-shot above):

```bash
--target-database=alia --kind library                    # preview
--target-database=alia --kind library --apply --limit 20 # canary
--target-database=alia --kind library --apply
```

and the same for `--kind speech` and `--kind skills`. An item Oxy does not take
(below) is reported `failed` and stays on legacy storage; the next run tries it
again.

## How private content is stored (stage 4c)

Everything is in ONE module, `packages/api/src/lib/files/oxy-files.ts`; a test
fails if any other source stores bytes in Oxy or reads them back.

- **Always `visibility: 'private'`.** A person's file is theirs (the library,
  their own skills): Oxy writes Alia a consent grant when Alia stores it for
  them, so `linkedDownloadUrls` serves it back to Alia — until the person
  revokes Alia's access in their file manager. Alia's own files (clips,
  catalogue skills) are always readable by Alia.
- **Which upload.** Media (image, video, audio) of at most 40 MiB is streamed
  (`uploadAppFile` / `uploadUserMedia`); anything else — PDFs, documents, text,
  archives, skill binaries, files over 40 MiB — is a resumable large upload
  (`uploadAppFileLarge` / `uploadUserMediaLarge`, up to 8 GiB).
- **Checked before it is recorded.** Oxy must report the sha256 of the bytes
  sent and `private`. A deduplicated file comes back as it was, and an Oxy
  without stage 4c stores a person's small upload public, so either check
  failing means the row is not pointed at that file.
- **Falls back, never fails a person's action.** A write Oxy does not take — a type its content policy refuses (executables and active
  documents, 415), an API without stage 4c, a file not stored private, an
  SVG (stored sanitized, so another hash), Oxy unreachable — is written to the
  legacy bucket instead, logged and counted in
  `alia_oxy_files_fallback_writes_total{kind,reason}`. The one exception is
  taken-down bytes (451 `CONTENT_BLOCKED`): the upload fails, as it would for
  any owner.
- **Reads.** The Oxy file first; the legacy copy when there is no Oxy file, or
  when Oxy fails to answer during the move (counted as a legacy read). When
  Oxy REFUSES — the person revoked Alia's access, the file is gone or taken
  down — the answer stands and the legacy copy is not read around it.

## Retiring the bucket

The bucket (`AWS_S3_BUCKET`) is retired only when BOTH hold, measured with
`migrate:oxy-files --status --window-days 14`:

- **zero legacy reads** for 14 consecutive days in `legacy_storage_reads`
  (the durable count; the process counter `alia_legacy_storage_reads_total` is
  not scraped) — every read
  served from the bucket by `/media`, the skill file route and the dual-read
  fallback is counted there;
- **zero rows still on legacy storage** (`rowsOnLegacyStorage`: series with a
  legacy cover and no file, library files, clips and skill files with a key and
  no Oxy file), and an empty reference outbox (`referenceOutbox`).

Then, in order: a `post` migration dropping `show_series.cover_image_asset_id`
and the legacy key columns (`library_files.url`/`thumbnail`,
`speech_clips.object_key`, `skill_files.s3_key`) together with the code paths
that read them, `lib/s3.ts` and the garbage collector; then empty and delete
the bucket and remove `AWS_S3_BUCKET` and the IAM grant. Covers alone can be
closed earlier (their legacy copies live in Syra's bucket, not Alia's): drop
`cover_image_asset_id` once Syra reports no Alia podcast on a legacy image.
`audio_job` reads are the retired audio-generation feature's results; their rows
expire after a day, so that kind reaches zero by itself.

## Scopes and configuration

Alia's Oxy application (internal tier, granted by staff): `files:app:write`
(covers, clips, catalogue skill files), `files:app:delete`,
`files:references:write` (outbox, reconciliation), `files:read`
(`metadataByIds` for the cover handover record), `files:linked:read` (read-back),
and `files:user-media:write` (staff-granted act-as: the library and a person's
own skill files, stored for them as their private files — the grant Oxy's
consent for Alia to read them back rests on).

| Variable | Default | Meaning |
|---|---|---|
| `OXY_FILES_WEBHOOK_SECRET` | unset → route 404 | the file-events endpoint's `whsec_…` secret (SSM) |
| `SYRA_COVER_FILE_IDS` | off | `enabled` stores a new cover as Alia's Oxy file and hands Syra `imageFileId` — only after Syra #214 is deployed and trusts Alia |
