# 19. Alia stores files in Oxy Files, behind one seam

*Alia guarda sus archivos en Oxy Files, tras una sola costura.*

**Status:** Accepted (implemented: covers switched on after Syra #214; private content switched on after Oxy stage 4c is deployed)

**Date:** 2026-10-16

**Builds on:** Oxy ADR 0043 (who owns a file, who uses it, and when it goes
away), stage 4: "own-bucket products move into Oxy Files … Syra (catalogue
artwork, and Alia's show covers move to Alia) … Alia (skill bundles)".

## Context

Alia kept its own S3 bucket for five kinds of bytes: show covers (uploaded INTO
Syra's image store, not Alia's), library uploads, spoken clips, show working
segments and skill bundle files. Nothing told Oxy who owned or used any of it,
nothing collected what lost its row, and two leaks were acknowledged in code:
the skill store's "uploaded, then the transaction failed" orphan, and the
show pipeline's segments, left behind by any worker that died mid-run.

## Decision

1. **Ownership follows who makes the bytes.** A cover Alia draws is ALIA's
   public Oxy file (no person uploads one). A library upload is the person's. A
   spoken clip is Alia's private file, because it is a cache Alia expires and an
   account's file is never deleted behind its owner's back (ADR 0043 D5). A
   catalogue skill's files are Alia's; a person's own skill's files are theirs.
2. **Syra uses Alia's cover; Alia owns it.** Syra receives `imageFileId` and
   holds its own reference. Existing covers move in two steps: Alia copies the
   exact bytes into its own file, then Syra repoints each Alia podcast to the
   Oxy file with the same sha256 that Alia owns. Until Syra is deployed with
   `imageFileId`, a cover is still uploaded into Syra (`SYRA_COVER_FILE_IDS`
   switches it), because a Syra without it would drop the field.
3. **Every use is recorded in the transaction of the row that makes it**
   (`oxy_file_reference_sync`, a desired state per file and entity), drained to
   `references.add` / `remove` by a worker, reconciled nightly (D6). Stored
   bytes nothing names are collected by construction: Oxy collects Alia's
   unreferenced files; legacy objects are marked as garbage before they are
   written; a person's file stays theirs.
4. **Show segments are not stored.** They were never read back.
5. **Private content goes through ONE module** (`lib/files/oxy-files.ts`, the
   only source that stores bytes in Oxy or reads them back) on Oxy stage 4c:
   always private; a person's file stored as theirs, with the consent grant
   that lets Alia read it back until they revoke it; small media streamed,
   everything else a large upload. It is written to Oxy only behind
   `OXY_FILES_PRIVATE_CONTENT` (off by default, so the release is safe before
   4c is deployed), and a write Oxy does not take falls back to the legacy
   bucket — except taken-down bytes. Oxy's refusal to serve a file is final;
   the legacy copy is read only when Oxy fails to answer.
6. **The bucket is retired on evidence**: zero counted legacy reads for 14 days
   and zero rows on legacy storage (`docs/oxy-files.md`).

## Consequences

- Alia's Oxy application needs `files:app:write`, `files:app:delete`,
  `files:references:write`, `files:read`, `files:linked:read` and
  `files:user-media:write`.
- Alia must receive Oxy's file events (`OXY_FILES_WEBHOOK_SECRET`); a deleted or
  taken-down cover is removed rather than replaced by the legacy copy of the
  same bytes.
- Until the bucket is retired, Alia runs two backends. The cost is bounded by the seam: no
  other module knows which backend holds a byte.
