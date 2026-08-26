# Architecture decision records

An ADR records a decision that is **in force now**, the context that forced it, and what it costs. It is not a tutorial, not a plan, and not a proposal. If a document describes something that has not been decided, it does not belong here.

## Index

| ADR | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](./0001-alia-oxy-kaana-responsibility-boundary.md) | Alia / Oxy / Kaana responsibility boundary | Accepted | 2026-08-15 |
| [0002](./0002-alia-is-a-kaana-consumer-and-future-model-publisher.md) | Alia is a Kaana consumer, and a future model publisher | Accepted | 2026-08-15 |
| [0003](./0003-model-revision-deployment-provider-routing-profile.md) | Model, revision, deployment, provider and routing profile are five distinct things | Accepted | 2026-08-15 |
| [0004](./0004-product-endpoints-versus-generic-inference-endpoints.md) | Alia product endpoints versus generic inference endpoints | Accepted | 2026-08-15 |
| [0005](./0005-product-entitlements-versus-financial-ledger.md) | Product entitlements versus the financial ledger | Accepted | 2026-08-15 |
| [0006](./0006-the-destination-of-api-alia-onl-v1-is-recorded-twice.md) | The destination of `api.alia.onl/v1/*` is recorded twice, differently | Proposed | 2026-08-19 |
| [0007](./0007-a-users-own-machine-as-an-inference-runtime.md) | A user's own machine as an inference runtime | Accepted | 2026-08-24 |

Companion document: [the compatibility window and sunset criteria](../migration/compatibility-window.md), which binds ADR 0002, ADR 0003 and ADR 0004 to measurable removal gates.

ADRs 0001 through 0005 were written together for epic #139 and are consistent by construction. Read 0001 first: the other four are consequences of the boundary it draws.

ADR 0006 is `Proposed` rather than `Accepted` because it does not decide anything: it records that four derived notes under `docs/migration/` contradict ADR 0004 about whether `api.alia.onl/v1/*` ever goes away, and asks the repository owner which is authoritative. It is the one document here that describes something not yet decided, and it says so in its own Decision section.

## Conventions

**Numbering** is sequential and permanent. A number is never reused, including for an ADR that is later superseded or rejected.

**File names** are `NNNN-kebab-case-title.md`, zero-padded to four digits.

**Status** is one of:

- `Proposed` — written, not yet agreed.
- `Accepted` — in force.
- `Superseded by NNNN` — no longer in force. The record stays; it is the history of why the current decision looks the way it does.
- `Rejected` — considered and declined. Worth keeping when the option is likely to be proposed again.

**Sections** are Status, Date, Context, Decision, Consequences, Alternatives considered, Enforcement.

**Enforcement names the concrete check** that catches a violation — an architecture test, a CI gate, or a code review rule. Where no check exists yet, the ADR says so explicitly rather than implying one exists. A decision nobody can violate accidentally needs no check; a decision that everything in the codebase currently violates needs one badly, and saying which is which is the point of the section.

**An accepted ADR is not edited to change its decision.** Correcting a typo or a broken link is fine. Changing what was decided means writing a new ADR that supersedes it, so that the reasoning behind the earlier state survives.

**No invented facts.** A claim about current code cites `path:line`. A claim about a future check says it does not exist yet.
