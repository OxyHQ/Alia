# 6. The destination of `api.alia.onl/v1/*` is recorded twice, differently

**Status:** Proposed

**Date:** 2026-08-19

## Context

This repository states two incompatible destinations for the same HTTP surface.
One says `api.alia.onl/v1/*` is a permanent product contract. The other says it
is a bounded compatibility surface that sunsets. Both are written down, both are
cited by other documents, and neither knows about the other.

This record exists to make the disagreement precise enough to settle in one
sitting. **It does not settle it.** Which destination is right is a product
decision, and choosing one by editing a file would remove the evidence that
there was ever a question.

### The census

Population: the 1,665 files tracked by git at `fc613f2d`. Of those, **170
contain a `/v1` token**. That number is the floor and the sanity check: it counts
path strings, so it would be roughly 170 whether or not any file in the
repository asserted a destination at all. If the answer below had come back
"zero artifacts assert anything", the floor is what would distinguish a broken
search from a repository that genuinely says nothing.

Screening: every line containing `/v1` was taken with a window of the twelve
lines either side, and the window matched against destination vocabulary in both
directions — `never removed`, `keep-alia-product`, `what stays`, `public product
contract` on one side; `bounded window`, `compatibility surface`, `compatibility
window`, `sunset`, `ADR 0004` on the other. A deliberately over-broad first pass
at ±4 lines returned 383 lines across 47 files; those were then read.

Positive control: the screen was required to return the four artifacts already
known to assert a destination — `docs/migration/ownership.md`,
`docs/migration/ownership-matrix.json`,
`docs/adr/0004-product-endpoints-versus-generic-inference-endpoints.md` and
`docs/migration/compatibility-window.md`. A first version of the permanence
pattern missed `ownership.md`, whose claim is phrased "What stays. All of `/v1`"
and contains none of the obvious permanence words; the control caught that, and
the pattern was widened. An instrument that finds two conflicts and a repository
that contains two conflicts are indistinguishable without this step.

**Result: 30 artifacts assert a destination.** Four say permanent, twenty-six say
bounded. The remaining 140 of the 170 name a `/v1` path and say nothing about its
future.

### The four that say it is permanent

Four files, five quoted claims — `ownership-matrix.json` carries two. Every one
is a derived migration note under `docs/migration/`. **No ADR asserts
permanence.**

| artifact | claim |
| --- | --- |
| `docs/migration/ownership.md:328` | *"**What stays.** All of `/v1`. It is the public product contract: the OpenAI-compatible shape, the `alia_usage` / `alia_meta` extensions, `system_fingerprint: 'fp_alia'`, and the named SSE events."* |
| `docs/migration/ownership-matrix.json:5764` (`v1-chat-completions-post`) | `removalGate`: *"**Never removed.** If inference moves to Relay, this endpoint stays as the Alia-facing facade…"* |
| `docs/migration/ownership-matrix.json:5904` (`v1-router-mount`) | `removalGate`: *"**Never removed.** Any route moved OUT of `/v1` loses wildcard CORS and instantly breaks every browser-based external client."* |
| `docs/migration/inventories/product-api.json:46,143` | the same two gates, in the inventory the matrix was derived from |
| `docs/migration/inventories/provider-runtime.json` (`sdk-openai-client-codea`) | *"They only require that Alia keeps serving an OpenAI-compatible `/v1` surface after the Relay switch — which is itself a contract Relay must not break."* |

Two of those rows are the loudest, but they are not the extent of it. **Thirty
rows of `ownership-matrix.json` have a `currentPath` under
`packages/api/src/routes/v1/`.** Two are the existing `410` tombstones. Of the
other twenty-eight, nineteen carry `targetPath: keep-alia-product` or `keep`,
and four of the nine assigned to Relay say in their `targetPath` that *"Alia
keeps the `/v1/audio/speech` facade"*, *"…the `/v1/images/generations` facade"*,
*"…the `/v1/voice/transcribe` facade"*. **Not one row on the `/v1` surface
records a sunset.** The strings `sunset`, `compatibility window` and `ADR 0004`
occur zero times in the entire file, and zero times in
`inventories/product-api.json`, which carries 77 `keep-alia-product` entries.

### The twenty-six that say it is bounded and sunsets

**Decision records (3).** These are the artifacts that decide, rather than
describe.

- `docs/adr/0004-…md:44` — *"`api.alia.onl/v1/*` is a bounded-window
  compatibility surface, then it sunsets."* Status **Accepted**. Condition 4 of
  four: *"It sunsets. The window is bounded, its deprecation signals and its
  measurable removal gate are specified in `docs/migration/compatibility-window.md`,
  and the surface is removed once that gate is satisfied."* Its
  *Alternatives considered* rejects the other destination by name at `:80` —
  *"**Keep `api.alia.onl/v1/*` permanently as a product-branded inference API.**
  Rejected."*
- `docs/migration/compatibility-window.md:104` — section **(b)**, Status
  **Accepted**, named by `docs/adr/README.md` as the companion document that
  binds ADRs 0002, 0003 and 0004 to measurable gates. It carries the per-route
  removal gate, the owner and the review cadence.
- `docs/adr/0001-…md:94` — *"Alia's public generic inference surface stops being
  canonical. ADR 0004 records what happens to `api.alia.onl/v1/*`."* Accepted;
  defers the destination to 0004 rather than deciding it.

Outside the repository, **issue #139 line 318 is ticked**: under *"Decide whether
`api.alia.onl/v1/*`:"*, the chosen sub-option is *"remains a product-specific
compatibility endpoint for a bounded period"*, with *"returns a documented
redirect/proxy"* and *"is removed with a fixed sunset"* both unticked.
`docs/migration/epic-139-decisions.md:183` records that those two are the
rejected alternatives of an already-made decision, not open questions.

**Descriptive documentation (7).** `README.md:69`
(*"a **bounded compatibility surface** that sunsets under ADR 0004"*),
`docs/index.mdx:109`, `docs/api-reference.md:12` and `:198`
(a section titled *"The bounded compatibility surface (`/v1/*`)"*),
`docs/developers-portal.md:13`, `docs/chat-runtime.mdx:133`,
`docs/migration/epic-139-decisions.md:185`,
`docs/migration/epic-139-status.json:527`.

**Code and executable gates (16).** `packages/api/src/routes/__tests__/v1-compatibility-surface.test.ts:2`
(*"The `api.alia.onl/v1/*` compatibility surface is frozen"*, and four `describe`
blocks naming ADR 0004), `packages/api/src/__tests__/architectureGates.test.ts:2897`
(gate 8), `packages/api/src/index.ts:262`, `packages/api/src/routes/v1/models.ts:21,73`,
`packages/api/src/routes/catalogue.ts:26` (*"the surface whose whole plan is to
sunset"*), `packages/api/src/middleware/alias-deprecation.ts:141`,
`packages/app/lib/api/routes.ts:56`, `packages/app/lib/hooks/use-chat-conversation.ts:40`,
`packages/alia-codea/src/chatParticipant.ts:184`,
`packages/alia-codea/src/chatProvider.ts:718`,
`packages/alia-codea-cli/src/utils/api.ts:150`,
`packages/alia-chat/src/hooks/useAliaChat.ts:246`,
`packages/alia-console/src/routes/_layout/playground.tsx:162`,
`packages/alia-cowork/src/main/chat.ts:161`,
`packages/alia-cowork/src/main/tools.ts:457`,
`packages/integrations/src/shared/api-client.ts:198`.

### The shape of the conflict, which matters to whoever resolves it

This is **not two ADRs disagreeing.** `docs/adr/README.md` says an ADR *"records
a decision that is in force now"*; a matrix row and an inventory entry are
derived notes about a subject, and `ownership.md` is prose over the matrix. All
four permanence assertions are on the derived side. Under the repository's own
hierarchy the accepted ADR governs and the notes are simply stale — which is why
one direction of this decision is a documentation correction and the other is a
new ADR superseding an accepted one.

`docs/migration/ownership.md:334` and the two `ownership-matrix.json` rows above
now carry a `CONTESTED` note pointing here, added by the same change that wrote
this record. The note states that ADR 0004 decides the opposite and that neither
side has been settled; it does not alter either claim, and the claims are quoted
above as they stand.

The chronology supports that reading without settling it. ADR 0004 and the
compatibility window landed in `0bbe6719` (#140) at 20:52 on 2026-08-15. The
matrix, `ownership.md` and the inventories landed 35 minutes later in `cee91953`
(#142), whose **first parent is `0bbe6719`** — so the notes were merged onto a
tree that already contained the ADR, and reference it nowhere.

## Decision

**No destination is chosen here.** What this record asks the repository owner for
is one sentence naming which of the two artifacts above is authoritative:

- **Either** ADR 0004 §*"…is a bounded-window compatibility surface, then it
  sunsets"* stands, and the four derived notes are corrected to match; **or**
- the notes describe the intended end state, and ADR 0004 is superseded by a new
  ADR — `docs/adr/README.md` forbids editing an accepted ADR to change what it
  decided.

In the meantime this record **proposes a hold**: no sunset date is set for path
(b) and no `/v1` route is removed until the sentence exists, because either
action would rest on a document the repository contradicts. A `Proposed` ADR
binds nothing, so this is a request rather than a rule — and it costs nothing
today, because `compatibility-window.md:67` already states that no removal date
is set for any path.

## Consequences

### If `api.alia.onl/v1/*` is permanent

- **ADR 0004 must be superseded, not edited.** Its Decision section §3 and its
  rejected alternative at `:80` are the record of the opposite choice, and the
  README requires a new ADR rather than a rewrite.
- **`compatibility-window.md` loses section (b) entirely.** Three compatibility
  paths become two, and the document's "who owns the clock" for workstream 6
  becomes vacant.
- **Twenty-six artifacts become wrong**, sixteen of them code comments that a
  reader will treat as current. **Nothing in CI would catch that.** The two
  executable gates — `v1-compatibility-surface.test.ts` and gate 8 of
  `architectureGates.test.ts` — freeze the surface's *shape* and its *caller set*,
  which permanence also wants; they would stay green while every prose rationale
  above them described a plan that had been abandoned.
- **On #139: no box becomes unachievable, but one becomes untrue.** The ticked
  line 318 (*"remains a product-specific compatibility endpoint for a bounded
  period"*) would no longer describe the outcome, and none of the three
  sub-options under line 316 would — the epic would need a fourth. Line 315
  (*"Move generic inference access to `api.oxy.so/v1` backed by Relay"*) survives
  either way: Oxy can own generic inference while Alia keeps an OpenAI-shaped
  product surface.
- **It re-opens ADR 0001 and ADR 0005, not just 0004.** ADR 0004's four
  conditions — authenticate through Oxy, issue no new `alia_sk_*`, meter through
  Relay and the Oxy ledger, then sunset — were attached to a *window*. A
  permanent surface has to answer whose credentials and whose ledger it runs on
  for good, and ADR 0001 assigns the generic inference API to Oxy.
- **PR #205 is unaffected.** Its date is `ALIAS_SUNSET`, path **(a)** of the
  compatibility window — the thirteen `alia-*` identifiers — and it touches no
  route. Path (b) has no date and no signal in that PR or anywhere else.

### If `api.alia.onl/v1/*` sunsets

- **Four artifacts become wrong**, all machine-readable or derived from
  something that is: `ownership.md`'s *Product API* section, nineteen
  `keep-alia-product`/`keep` rows plus four "Alia keeps the … facade"
  `targetPath` values in `ownership-matrix.json`, 77 `keep-alia-product` entries
  in `inventories/product-api.json`, and one gate in
  `inventories/provider-runtime.json`.
- **The clock has not started, and cannot start yet.** `compatibility-window.md:65`:
  *"Path (b) emits nothing"* — no `Deprecation`, no `Sunset`, no `Link`, no
  `alia.deprecation` — and the same document calls emitting *"a prerequisite for
  starting those clocks, not an optional extra"*. Emitting them is workstream 19
  and does not exist (`docs/adr/0004-…md:88`).
- **The gate cannot currently be measured.** Section (b) asks for a per-route
  count over `api_key_usage` with a positive control, in a window shorter than
  the 90-day sweep. Production is parked at desired count 0 and the database is
  not reachable from this repository, which is the same obstruction recorded for
  path (a) at `compatibility-window.md:87`.
- **Eleven files across five packages are still on it**, frozen by name in gate 8
  of `architectureGates.test.ts:3024` and `:3048`, each with its reason at the
  call site:
  - `@alia.onl/sdk` — `packages/alia-chat/src/hooks/useAliaChat.ts`. Only `/v1`
    carries the public wildcard CORS policy; measured 2026-08-19, an
    `OPTIONS /alia/chat` preflight from an unlisted origin returns no
    `access-control-allow-origin` at all. The SDK ships raw source into consumer
    apps on origins Alia does not enumerate, so no deploy here reaches an
    installed copy.
  - The developer console — six files: `routes/_layout/playground.tsx` and
    `documentation/{authentication,chat-completions,quickstart,sdks}.tsx` plus
    `routes/_layout/examples.tsx`. Their audience *is* the generic-inference
    audience the surface exists for; they retire with the surface, not before.
  - Four OpenAI-protocol clients — `packages/alia-codea-cli/src/utils/api.ts`
    (published `@alia-codea/cli`), `packages/alia-codea/src/chatProvider.ts`
    (marketplace-published extension), `packages/alia-cowork/src/main/chat.ts`
    and `packages/alia-cowork/src/main/tools.ts`. Each hands a `baseURL` to the
    `openai` package or to Stagehand, which derive `POST {baseURL}/chat/completions`
    themselves — so the path is not Alia code to change.
  - And one artifact that follows no source edit: `packages/alia-cowork/out/main/index.js`,
    a built bundle that still contains the path (matrix row
    `cowork-built-bundle-endpoint`).
- **What would have to move first**, in order: a CORS decision on `/alia/chat`
  taken with the SDK's consumer origins enumerated, or an `@alia.onl/sdk` major;
  the console documentation rewrite already assigned to #139 workstream 20; and
  published majors for `@alia-codea/cli` and the VS Code extension. Then the
  deprecation signal, then the measurement.
- **Removal is per route, not per surface.** `compatibility-window.md:119` is
  explicit that gating the whole surface on its least-migrated route keeps the
  rest alive for no reason — and `:161` leaves open whether `/v1/shows` belongs
  to this window at all.

## Alternatives considered

**Pick the destination here and edit the losing artifacts.** Rejected. The
choice is a product decision, and an ADR written by whoever noticed the conflict
would launder a preference into a decision record. The conflict is also the
evidence: once the losing side is edited away, the next reader cannot tell that
the two halves of the repository ever disagreed, or for how long.

**Correct the four derived notes to match ADR 0004 and record nothing.**
Rejected, though it is what the hierarchy in `docs/adr/README.md` implies. It is
a defensible action *after* the owner confirms ADR 0004 still holds, and an
undetectable erasure before. The notes were written by someone with the
inventory in front of them, and *"Never removed. Any route moved OUT of `/v1`
loses wildcard CORS"* is a real constraint whether or not it is the decision.

**Leave it open and let each workstream follow whichever document it reads.**
Rejected. That is the state that produced this record, and the two halves are
not even in different hands: `ownership-matrix.json`'s `/v1` rows carry
`workstream: "6"`, and ADR 0004 is the workstream 6 decision. The next change to
act on the wrong half either deletes a live public route or builds a permanent
surface the boundary epic exists to remove.

**Write it as an open question in `compatibility-window.md` instead.** Rejected.
That document's *Open questions* section is scoped to questions *within* an
accepted window — who the named owner is, whether headers are per-route. Whether
the window exists at all is a question about the document, not inside it.

## Enforcement

- **No check exists** that compares a destination asserted in `docs/migration/*`
  against the ADR that decides it. `packages/api/src/db/__tests__/ownershipMatrixCoverage.test.ts`
  validates the matrix's *structure* — legal `owner` and `reachable` values,
  every governed file classified, `removedIn` in both directions — and never
  reads `removalGate` or `targetPath` for agreement with anything. A row can say
  "Never removed" about a route an accepted ADR sunsets, and the suite is green.
- **A check that would work**, if this is resolved in favour of the ADR: assert
  that no row whose `currentPath` is under `packages/api/src/routes/v1/` carries
  a `targetPath` of `keep-alia-product`, with a positive control on a row that
  legitimately does (`packages/api/src/routes/chat.ts`) and a vacuity floor on
  the number of `/v1` rows found — currently 30. It is not written, because
  which way it should point is the open question.
- **Until then this is a review rule:** a change that sets a removal date for
  path (b), or that removes a `/v1` route, cites the sentence that resolved this
  ADR. A change that cites only one side of it has not resolved anything.
