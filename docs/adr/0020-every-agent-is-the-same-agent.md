# 20. Every agent is the same agent

*Todos los agentes son el mismo agente: Alia, los agentes de las personas y los de las apps comparten una sola base.*

**Status:** Proposed

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
∩ autonomy of a direct request (at most execute_on_request)
∩ the tool's declared actors (the tool must admit `agent`)
```

No standing grant from the requester to the agent is created, and nothing ever runs unattended on a requester's data through this lane. The ceiling replaces the question ADR 0015 deferred ("somebody using a shared or public agent never gets its owner's data"). That rule still holds: the ceiling reaches the *requester's* data, never the owner's.

**The owner sets the ceiling per app in the agent editor**, under "For whoever uses it". The choices are **Nada**, **Ver** (read packages, `read_only`) and **Ver y actuar** (every non-sensitive package, `execute_on_request`). Sensitive packages (`finance`, `security`, `delegate`) are never part of a ceiling.

### 3. An agent you do not own asks before it acts

On the present-requester lane, every tool whose effect is not `read` proposes an approval card in the requester's chat. The proposal uses the existing review machinery (`action-proposal.ts`) with a new review kind, `third_party_agent_write`.

The card is skipped only when both of these allow it: the ceiling says `writes: 'on_request'`, and the requester's own account policy for that app allows direct requests without review. Payments and irreversible deletes always show a card, as `reviewKindOf` already decides.

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
- `ALIA_INTERNAL_MCP_PILOT`: the internal transport is read from each app's catalogue.

## Consequences

- **Sindi works everywhere a person can open an agent.** That covers Homiio's sheet, panel and screen, the Alia app, and a consultation from Alia in any app, all billed to that person.
- **Sindi's capabilities on Homiio come from Homiio's catalogue**, the same one that serves Homiio's public MCP. Homiio's backend stops calling Alia at all.
- **An app agent's owner now carries the responsibility of an ordinary agent's owner:** the prompt, the families and the ceiling are edited in the agent editor and audited like any other agent.
- **Migration order is expand/contract.**
  1. Oxy ships ceilings (ADR 0042).
  2. Alia ships the requester lane, `consultAgent`, host tools and gates, while keeping the old lane working.
  3. Homiio ships its catalogue, then its SDK-based chat.
  4. Only then are the old lane's code and column removed.
- **The wire stays compatible.** The new SSE events (`alia.agent_start | agent_delta | agent_tool | agent_end | host_action`) are emitted only to clients that send `streamFeatures`. The SDK's parser is strict, so older SDKs keep receiving the single `alia.agent` frame until every first-party client has upgraded.
- **Clarity loses its pinned lane too.** Its owner must re-create its access through the ordinary model before the contract step.

## Alternatives considered

- **Keep the native lane and add Alia beside it.** That would mean two agent models, two payer rules and two chats in Homiio, which is the duplication the owner rejected.
- **A grant from each requester to each public agent.** It would make a consent step part of every first use and store long-lived authority nobody asked for. A ceiling bounded by the requester's live authority gives the same safety with nothing standing.
- **Run Sindi's tools as Alia.** That gives the wrong attribution: the effect would be recorded as Alia's, not the agent's. It would also give the agent Alia's unbounded reach.
- **Keep host UI actions derived on the product's server.** That is a second decision-maker beside the model, and it drops the model's own tool results. It is the workaround Homiio's `services/sindiActions.ts` documents as temporary.
- **Product-paid agent inference.** It contradicts the owner's billing decision, and it makes an agent's cost depend on which app opened it.

## Enforcement

- **Present-requester lane:** `tool-pipeline` pgdb tests. The lane binds only the requester's account root, `self_*` is absent for a non-owner, a write proposes `third_party_agent_write`, and a revoked ceiling removes the tools on the next turn.
- **`consultAgent`:** tests prove that it uses `canReachAgent`, bills the outer payer and refunds on failure, and that the nested turn has no `consultAgent` and no host tools.
- **Wire compatibility:** `streamFeatures` negotiation tests. An old SDK receives only `alia.agent`.
- **Feature gates:** a locked gate refuses before any reservation, and a retried turn consumes once.
- **SDK:** `one-thread.test.tsx` fails if any file other than `AliaParticipants` imports `AgentProfile` or the join-flight spec.
- **Contract step:** a CI grep gate fails on `native-product-agent`, `RequesterAssertion`, `ALIA_INTERNAL_MCP_PILOT` or an `applicationId` on agents.
- **Not yet enforced:** no check yet stops a future surface from paying an agent turn from an application. Review is the gate until the product-payer code is gone, after which there is nothing left to call.
