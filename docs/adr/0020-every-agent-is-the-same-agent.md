# 20. Every agent is the same agent

*Todos los agentes son el mismo agente: Alia, los agentes de las personas y los de las apps comparten una sola base.*

**Status:** Accepted

**Date:** 2026-10-16

**Amends:** ADR 0015 (actors and identities) and ADR 0018 (the conversation screen is the SDK's).
**Depends on:** Oxy ADR 0042 (an agent acts for a present requester under its owner's published ceiling), which supersedes Oxy ADR 0025.

## Context

**This ADR comes from the owner's decision of 2026-10-16.** Sindi (Homiio's housing agent) is to become an ordinary Alia agent. Alia becomes Homiio's main AI, and Alia can consult Sindi for anything to do with housing, from any app. "Ask Sindi" opens the same dialog as "Ask Alia", with Sindi's character instead of Alia's, and any future app agent works the same way. In the owner's words, *all agents must use this one Alia base of agents*. The owner decides what an agent may do and whether it is private or public.

Today Alia has two kinds of agent:

- **Ordinary agents.** An `agents` row plus an Oxy `bot` account. The owner grants per-app levels to the bot (ADR 0015) and `access` decides who can reach the agent.
- **Native product agents (Sindi, Clarity).** The same row, plus a lane that exists only for them:
  - A manifest pinned in two repositories with a cross-repo SHA-256 (`config/native-product-agents.ts` here, `config/nativeProductAgents.ts` in oxy), applied by a bootstrap script and workflow.
  - An `agents.application_id` binding: `canReachAgent` admits the agent only when `caller.applicationId === agent.applicationId`.
  - A request authenticated with the product backend's workload token plus a one-use `X-Oxy-Requester-Assertion` (Oxy ADR 0025), mounted through `authenticateRequesterAssertion`.
  - A refusal in `lib/chat/request-context.ts` of any `agentId` other than the asserted one. This makes "plain Alia inside Homiio" impossible on that lane.
  - A payer branch that charges the product application for the agent's inference.

That lane has the following consequences today:

- **Sindi is unreachable outside Homiio.** `delegateToAgent` calls `canReachAgent` without an application and always gets `out_of_reach`. `askAgent` lists only the person's own agents.
- **Sindi has no tools on Homiio.** Homiio publishes no capability catalogue. Its backend therefore derives search filters with a separate inference call, calls its own HTTP API, injects the listings into the prompt as system text, and drops `alia.tool_result`.
- **Sindi's published `memory` grant never takes effect.** Memory tools are built only when `actsForPerson`, which is false for the product's service-token turn.
- **Sindi's chat in Homiio is a separate chat implementation**, with its own conversation tables, share links and streaming format, beside the SDK's sheet that "Ask Alia" already uses.
- **A second copy of every agent decision, in another repository, has to stay byte-identical.**

## Decision

### 1. One agent base

An agent is an `agents` row plus its Oxy `bot` account, and nothing else:

- `access` (`private` | `public`) decides who can reach it.
- `is_published` decides whether it is listed in the catalogue.
- `capability_grants` decides which Alia families it has.
- Per-app levels (ADR 0015 §2) decide what it may do on its owner's data.

There is no `application_id`, no manifest and no bootstrap. An app's agent is created, edited, published and given permissions by whoever operates the owning account, through the same API and agent editor as every other agent. Sindi's row is owned by the Homiio project account. Clarity's row is owned by Clarity's project account.

Alia herself is the default lead of every conversation, not a special agent type. Wherever this ADR says "an agent", Alia is included unless it says otherwise.

### 2. Three authorities, named apart

| Tools | Whose account | When present | Authority |
|---|---|---|---|
| `self_<app>__*` | the agent's own bot account | owner present (unchanged) | ADR 0015 §4 |
| `oxy_<app>__*` | **the person present in the turn**, their own account in that app | owner present | the owner's standing grants (ADR 0015 §2, unchanged) |
| `oxy_<app>__*` | same | any other person (public or shared agent) | **new**: Oxy ADR 0042 present-requester ceiling |

For a person who is not the owner, the effective authority is:

```text
requester's live authority over their own account in the app
∩ the owner's published ceiling for that app on this agent
∩ the requester's account policy for that app
∩ the tool's declared actors (the tool must admit `agent`)
```

No grant from the requester to the agent is created: using the agent is the person's whole act. A run the person starts (an autonomous task, a recurring instruction, ADR 0011) keeps that person as its requester and may continue unattended within the same ceiling; it ends when the person stops it or loses authority over the account. The ceiling replaces the question ADR 0015 deferred ("somebody using a shared or public agent never gets its owner's data"). That rule still holds: the ceiling reaches the *requester's* data, never the owner's.

**The owner sets the ceiling per app in the agent editor**, under "For whoever uses it". The choices are the same three levels as ADR 0015 §2: **Nada**, **Ver** (read packages, `read_only`) and **Ver y actuar** (every non-sensitive package, `autonomous`). Sensitive packages (`finance`, `security`, `delegate`) are never part of a level; an owner who wants them adds them explicitly with bounded limits, exactly as for a grant.

### 3. No agent asks for approval

**An agent's configuration is its permission.** What it may do is decided once, by its owner's levels, its ceiling, its families and its limits, and enforced by Oxy on every call. Every agent, Alia included, is fully autonomous inside those bounds and never stops a conversation to ask whether it may act.

This retires approval cards for tool effects everywhere, including the "payments and deletes still confirm" rule of ADR 0015 §2. A payment is bounded by an explicit `finance` grant or ceiling with limits, never by a prompt. Asking the person a *question* (`askUserQuestion`, missing information, a choice between options) is not an approval and stays.

### 4. The person present pays

- A turn is paid by the person present: their Alia credits, inside the free tier when they have no plan.
- A nested agent turn (§5) is paid by whoever pays the outer turn.
- No product application pays for an agent's inference.

This removes the product-payer branch of `lib/chat/request-context.ts`.

### 5. Delegation is one streaming tool

`consultAgent { agent: id | @handle, task, context? }` replaces both `askAgent` and `delegateToAgent`.

- **Reach:** decided by `canReachAgent(caller)`, the same rule as opening the agent directly. Alia may therefore consult any public agent, including Sindi, from any app.
- **Execution:** the nested turn runs the callee's own prompt, families and `oxy_<app>__*` tools, on the outer requester's account, under the same lane as §2.
- **Streaming:** the nested turn streams. Its text, tool calls and tool results are forwarded tagged with the agent's id.
- **Depth is one:** a nested turn never receives `consultAgent` or host tools (§6).
- **Discovery:** `searchAgents` lists public, published agents by their description and specialties. That is how Alia finds Sindi for housing questions.

### 6. Any app embeds any agent, through the SDK

An Oxy app embeds Alia's conversation through `@alia.onl/sdk` under the person's own Oxy session. It may open any agent it can reach (`agent={{ id }}`). The lead participant then becomes that agent: its greeting, name, character, starters and the header's first avatar. The surface may also declare the following:

- **Host tools.** UI effects in the embedding client, declared per request as `host: { app, version, tools, context }` and named `host_<app>__<name>`.
  - The server records the call and emits `alia.host_action`. Only the declaring client executes it, and it returns an outcome (`applied | inline | rejected | stale | failed`) that becomes the tool result of the next turn.
  - A host tool is never authority over data.
  - Host tools are absent in nested, voice and channel turns.
  - The host-tool lane is separate from the editor lane (`body.tools`). The editor lane is unchanged.
- **Tool-result renderers.** Keyed by `<app>:<tool>`, parsed from the tool's canonical name and never from free text. Renderers draw a catalogue tool's structured output with the app's own components.

Agents gain **feature gates** (`agents.feature_gates`). A gate maps an Alia feature, such as `attachments.documents` or `attachments.images`, to a feature declared in an app's capability catalogue (`features[{ key, checkTool, consumeTool? }]`):

- Alia asks the publishing app, under the requester's ticket, whether the feature is available.
- If the feature has a `consumeTool`, Alia consumes it idempotently **before** any credit is reserved.
- A refusal ends the turn with `feature_entitlement_required`, and the host shows its own upsell.

This is how Homiio+ keeps unlocking files for Sindi without Alia knowing what Homiio+ is.

### 7. One conversation surface, one participants header

ADR 0018 stands: the SDK's `AliaChatContent` is the only conversation implementation.

The header's participants are Bloom's `AgentProfile` with `agents = [lead, ...joined]`. A consulted agent joins by flying from its reply's avatar into the header, which is Bloom's multi-agent choreography (`@oxy.so/bloom/avatar-flight`). One SDK component, `AliaParticipants`, draws it, and the app places it in its chrome instead of drawing a title of its own.

### 8. Retired

The following are deleted, not deprecated:

- the native-product-agent manifest, its bootstrap, workflow and docs gate;
- `authenticateRequesterAssertion` and `ALIA_REQUESTER_ASSERTION_AUDIENCE`;
- `isPresentRequesterSession` and the asserted-agent refusal;
- the product-payer branch;
- `applicationId` in `canReachAgent`, `loadTurnAgent` and `loadThreadAgent`, and the `agents.application_id` column (migration `-- oxy:deploy-phase=post`);
- `askAgent` and `delegateToAgent`;
- `ALIA_INTERNAL_MCP_PILOT`: the internal transport is read from each app's catalogue;
- approval cards for tool effects: the review proposal path, its approval events and the confirmation kinds for payments and deletes;
- the single `alia.agent` delegation frame, replaced by the streamed `alia.agent_start | agent_delta | agent_tool | agent_end` events.

**There is no compatibility code.** No flag, no negotiated stream feature, no 410 handler and no "old lane kept working" window. Each repository makes its cut in one change, and what it replaces is deleted in that same change.

## Consequences

- **Sindi works everywhere a person can open an agent.** That covers Homiio's sheet, panel and screen, the Alia app, and a consultation from Alia in any app, all billed to that person.
- **Sindi's capabilities on Homiio come from Homiio's catalogue**, the same one that serves Homiio's public MCP. Homiio's backend stops calling Alia at all.
- **An app agent's owner now carries the responsibility of an ordinary agent's owner:** the prompt, the families and the ceiling are edited in the agent editor and audited like any other agent.
- **A clean cut, in dependency order.**
  1. Oxy ships ceilings and deletes ADR 0025's lane in the same release.
  2. Alia ships the requester lane, `consultAgent`, host tools, feature gates and the new stream events, and deletes everything in §8 in the same release.
  3. Homiio ships its catalogue, its SDK-based chat and the deletion of its relay and conversation tables.

  Database changes still follow the deploy phases (`pre` adds, `post` drops), because that is how a rolling deploy stays correct, not a compatibility window.
- **Old native binaries stop chatting until they update.** The SDK's stream parser is strict, so an Alia or Homiio build with an older SDK fails on the new events, and Homiio's removed `/api/ai` answers 404. The owner accepted this on 2026-10-16 in favour of a clean cut.
- **Clarity loses its pinned lane too.** Its owner gives it access through the ordinary model (ceiling or levels) in the same window.

## Alternatives considered

- **Keep the native lane and add Alia beside it.** That would mean two agent models, two payer rules and two chats in Homiio, which is the duplication the owner rejected.
- **A grant from each requester to each public agent.** It would make a consent step part of every first use and store long-lived authority nobody asked for. A ceiling bounded by the requester's live authority gives the same safety with nothing standing.
- **Approval cards for an agent you do not own.** The owner rejected them: an agent's configuration already says what it may do, and asking again in the chat is a second permission system that the person can only rubber-stamp.
- **A compatibility window for old clients.** The owner chose a clean cut; a window is code that outlives its reason.
- **Run Sindi's tools as Alia.** That gives the wrong attribution: the effect would be recorded as Alia's, not the agent's. It would also give the agent Alia's unbounded reach.
- **Keep host UI actions derived on the product's server.** That is a second decision-maker beside the model, and it drops the model's own tool results. It is the workaround Homiio's `services/sindiActions.ts` documents as temporary.
- **Product-paid agent inference.** It contradicts the owner's billing decision, and it makes an agent's cost depend on which app opened it.

## Enforcement

- **Present-requester lane:** `tool-pipeline` pgdb tests. The lane binds only the requester's account root, `self_*` is absent for a non-owner, a write under Ver y actuar executes with no proposal, a write under Ver is not offered, and a revoked ceiling removes the tools on the next turn.
- **`consultAgent`:** tests prove that it uses `canReachAgent`, bills the outer payer and refunds on failure, and that the nested turn has no `consultAgent` and no host tools.
- **No approvals:** a test fails if any tool path returns an approval proposal for an effect.
- **Feature gates:** a locked gate refuses before any reservation, and a retried turn consumes once.
- **SDK:** `one-thread.test.tsx` fails if any file other than `AliaParticipants` imports `AgentProfile` or the join-flight spec.
- **Clean cut:** a CI grep gate fails on `native-product-agent`, `RequesterAssertion`, `ALIA_INTERNAL_MCP_PILOT`, `askAgent`, `delegateToAgent`, `streamFeatures` or an `applicationId` on agents (`scripts/check-retired-vocabulary.mjs`).
- **The person pays:** the product-payer branch is deleted, so no code path forwards a product token to pay for an agent turn; `request-context-model-selection.test.ts` asserts that a delegated product token never becomes the turn's payer.
