# 15. Actors and identities: Alia and agents, for the person and as themselves

*Actores e identidades: Alia y los agentes, por la persona y como sí mismos.*

**Status:** Accepted

**Date:** 2026-10-06

**Builds on:** Oxy ADR 0018 (native Alia agency; its 2026-10-06 addendum "an
agent acts as itself") and Oxy ADR 0025 (present requesters).

## Context

**The owner's decision, 2026-09-30 and 2026-10-06, is the source of this ADR.**

Two production failures were the same confusion seen twice: "what's in my email?"
answered "connect your inbox" (Inbox and Alia are both Oxy), and a recurring task
answered "this automation needs a responsible agent". The code had one notion of
an agent reaching Oxy apps — an Oxy `DelegationGrant` made in the accounts app's
Agency tab, which Alia never linked — and none of an agent using its OWN account,
although every agent is an Oxy `bot` account that already receives mail.

Concretely, before this change:

- An agent's own account was never an effective account: no binding used
  `effectiveAccountId = agent.oxyAccountId`.
- A non-automation agent run handed `buildOxyServiceTools` an empty
  authorization map (`lib/agent/runner.ts`), which filtered every Oxy tool away.
- `domain/capability-grants.ts` deliberately keeps Oxy apps out of Alia's grant
  vocabulary, so the editor had nothing to offer.

## Decision

### 1. Two actors, two modes

| | For the person (their data) | As itself (its own account) |
|---|---|---|
| **Alia** — one for everybody | Every Oxy app of the person and the accounts they operate, read and act, no permission prompts. Authority: the person present (`direct_request`) or the task's standing authority. No grants. | Oxy account "alia": a public identity, no mailbox. |
| **Agent** — a "persona" a person creates | Only the apps and levels its owner gave it (§2). Each level is an Oxy `DelegationGrant`. | Its own bot account: its own Inbox, its own accounts on websites. Authority: active bot + live Alia coordinator; no grant. |

The **requester is the authenticated person in the turn** (`requesterAccountId`,
PR #648). Somebody using a shared or public agent never gets its owner's data —
and, in this phase, not its own account either, since mail to the agent is often
about the owner.

### 2. Per-agent permissions: three levels per app

The agent editor's "Apps de Oxy" section lists every Oxy app from the live
catalogues with one selector: **Nada** · **Ver** · **Ver y actuar**. A new agent
starts at Nada everywhere.

| Level | Oxy grant (owner → agent bot, owner's account root of the app) |
|---|---|
| Nada | none (revoked) |
| Ver | the packages of the app's read tools, `read_only` |
| Ver y actuar | every non-sensitive package, `autonomous` — no approval, also unattended |

Sensitive packages (`finance`, `security`, `delegate`) are never part of a level;
payments stay behind an explicit, bounded grant in the Agency tab, which remains
the advanced view of the same grants. Only payments and deletes still confirm.

Alia writes the grant with the **owner's bearer** (`PUT /agents/:id/oxy-apps/:appId`,
owner only) and records `agent_oxy_app_permissions(agent_id, app_id, level,
oxy_grant_id)` only after Oxy accepted it. Every read reconciles with Oxy: a
grant revoked elsewhere reads as Nada and its row is dropped; a grant made
elsewhere is adopted. Oxy, not the row, decides at call time.

### 3. One toolset, two identities, named apart

`buildOxyServiceTools` takes an explicit `agentIdentity`:

- `oxy_<app>__<tool>` — the **person's** account, per the levels. A Ver grant
  only ever yields read tools.
- `self_<app>__<tool>` — the **agent's own** account, every app's account root.

Descriptions start with whose account it is (`[Your own Inbox] YOUR account…` vs
`[Inbox] The PERSON you work for…`), and an autonomous run's prompt says the same
once (`agentIdentityPrompt`).

### 4. How each call is authorized

- **Owner present in their agent's chat:** a `direct_request` with the owner's
  bearer, trimmed by Oxy to the agent's grants (the levels). The agent's own
  account needs no grant.
- **Unattended agent run** (the runner, nobody present): each step uses Oxy's
  agent-run lane (`POST /capabilities/agent-run-authorizations`, Alia's service
  token). Oxy derives the requester from the bot's live parent; Alia never sends
  one. Owner effects then need *Ver y actuar* (`autonomous`).
- **Automation stage:** unchanged — its exact preauthorized steps.

## Consequences

- An agent can read and send from its own inbox the day it is created.
- "Summarise my email every morning" works for an agent with Ver on Inbox, and
  replying needs Ver y actuar — the owner can see exactly why.
- Alia's coordinator can act as any agent on that agent's own account while its
  owner still operates the bot; archiving the bot or removing the owner's
  membership ends it. Owner data is never reachable that way without a grant.
- Deleting an agent revokes its level grants (best effort; the bot account
  stays, so a leftover grant is still visible in the Agency tab).
- Migration 0083 (pre) adds `agent_oxy_app_permissions`; Oxy must ship the
  self-binding and the agent-run lane first (rollout order: Oxy, then Alia).

## Alternatives considered

- **Levels as strings in `agents.capability_grants`.** A second copy of a
  decision Oxy already enforces; it would drift from the Agency tab.
- **A grant for the agent's own account.** Nobody can delegate to an account
  what it already owns, and the owner would have to create one per app.
- **Run unattended agent work as Alia.** Wrong attribution: the public effect
  would be authored by the person, executed by "Alia", not by the agent.
- **Let strangers on a public agent use its own account.** Deferred: the agent's
  mailbox may hold the owner's mail; it needs its own policy.

## Enforcement

- Oxy: `agentSelfBinding.db.test.ts` — own account allowed without a grant; the
  owner's account and ANOTHER bot the owner operates refused without one
  (mutation-checked: dropping the equality fails four cases); the agent-run lane
  derives the requester and needs an `autonomous` grant for owner effects.
- Alia: `oxy-services-agent-identity.test.ts` (both sets, names, lanes, Ver
  never yields writes), `agent-oxy-apps.test.ts` (level ↔ grant mapping,
  reconciliation), `routes/agents/__tests__/oxy-apps.test.ts` (owner only),
  `agentOxyAppPermissions.pgdb.test.ts` (migration), and the app's
  `agent-oxy-apps-section.test.tsx`.
- No check yet prevents a new surface from building an agent's tools for a
  requester who is not the owner; `ownerIsPresent` in `lib/tool-pipeline.ts` is
  the one place it is decided, and review is the gate.
