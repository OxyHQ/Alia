# Alia Agents

Alia runs as a context-agent system that prioritizes autonomous retrieval and policy-safe execution.

Agents, tools, approvals, the risk policy, deep research and triggers are Alia's own responsibility and stay that way under [ADR 0001](./adr/0001-alia-oxy-kaana-responsibility-boundary.md). None of it moves to the Kaana data plane.

## An agent IS an Oxy `bot` account

Alia stores an agent's RUNTIME — the prompt, the models, the archetype, the
soul, the marketplace listing. It stores nothing about who the agent is.

The identity is an account in the Oxy account graph (`kind: 'bot'`, a child of
its owner's personal account), and `agents.oxy_account_id` is the whole seam:
one column, no foreign key, UNIQUE.

- **Name, handle and avatar are READ from Oxy**, batched through
  `POST /users/by-ids` by `lib/agent-identity.ts`. They are nullable on the
  wire: the lookup fails OPEN, so an unresolvable account renders as nulls
  rather than blanking a listing whose tagline and rating are Alia's own.
- **A handle is globally unique across the whole Oxy account graph**, not just
  across Alia's agents — so Alia neither generates one nor checks one.
  `POST /agents/generate` returns a `suggestedUsername`; `POST /accounts`
  decides.
- **Who may write to an agent is `account:act_as` over its bot account**,
  resolved by Oxy and cached briefly in `lib/agent-account.ts`.
  `author_oxy_user_id` survives as the index behind "my agents" and is never an
  authorization gate — an owner may grant a colleague `act_as` without handing
  over the row.
- **Creating an agent takes the caller's own credential**, because the account
  is minted under their tree and they become its owner. The app does it in one
  tap: generate → `createAccount` → `POST /agents`.

  **An agent has no picture.** It is drawn as a glyph tinted with its Oxy
  account's `User.color`, a Bloom preset key — so `AgentIdentity` carries
  `color` where it used to carry `avatar`, and there is no image-generation step
  between the generator and the account. `domain/agent-color.ts` records why
  Alia PROPOSES a colour (one of the free Bloom presets, offered by
  `POST /agents/generate` beside the name) and validates none.

  **Known dependency: a new agent is DISCOVERABLE in Oxy immediately.** Every
  Oxy account is born public — `createAccountRequestSchema` carries no privacy
  field and the account service never writes the column — so an agent created
  as a DRAFT (`isPublished: false`, which keeps it out of Alia's catalogue)
  still appears in Oxy's global people search from the moment its account
  exists. Nothing Alia can send changes that; it needs a privacy field on
  `POST /accounts`. `CreateBotAccountInput.private` is declared and passed by
  the create screen so the landing is one edit, and is deliberately NOT spread
  into the SDK call, which would drop it silently and read as privacy that
  works.
- **Searching the catalogue no longer matches a name or a handle.** They live
  in another database, and a denormalised copy here is the cache this split
  exists to delete. A search matches the tagline, the category and the tags.

  A KNOWN GAP with a named fix: Oxy owns the identity, so Oxy should own the
  search over it, and `GET /profiles/search` has no `kind` filter today
  (`profileSearchQuerySchema` takes `{query, limit, offset}`). Adding
  `?kind=bot`, folded into the aggregate's `$match` so it filters BEFORE the
  page is cut, is what closes it.

  Neither workaround does. Filtering the results in Alia fails because the
  `$match` precedes `$skip`/`$limit`, so a query matching many people and one
  bot returns a page with no agents in it. Paginating the Oxy search separately
  and intersecting fails for a sharper reason: a catalogue query is a
  conjunction of Alia's own facets AND an identity match, and intersecting two
  independently paginated result sets breaks `limit`/`offset` the same way —
  ask for ten, receive two, with no way to ask for the rest.

## Talking to one is a thread — a VIEW over many conversations

`/a/:username` shows one continuous history with an agent. Underneath, **each
stretch of it is an ordinary Alia conversation** carrying the same `agent_id`,
and there are many. The thread is a view over the (person, agent) pair, never a
row.

That is not an implementation detail. **What the model is given as context is
the ACTIVE conversation, not the whole thread**, so starting a new stretch is
what keeps that context bounded — no compaction to invent, and the machinery
Alia already has (per-conversation model choice, titles) applies unchanged. One
row forever would grow the context without limit and make "start a new
conversation" a line that draws and changes nothing.

- `GET /agents/thread/:username` answers `{ agent, conversationId }`, where
  `conversationId` is the **active** stretch: the most recent conversation of
  the pair, or a new one when the two have never spoken. There is no unique
  index on `(oxy_user_id, agent_id)` — one would forbid the model outright, and
  0046 briefly declared one before 0048 took it back out.
- **A break is the SEAM between two conversations**, deduced from which one each
  message belongs to. There is no `conversation_breaks` table and no endpoint to
  create a break: starting a new stretch is `POST /conversations/new` with the
  same `agentId`. Date separators are not stored either — the client derives
  them from `created_at`, being the only party that knows the reader's timezone.
- **Every refusal is 404, never 403.** A handle is guessable, and a 403 would
  confirm that somebody's unpublished draft exists. `canReachAgent` is the one
  place the rule lives: published-and-active, or `account:act_as` on the bot
  account — the Oxy graph decides, Alia adds no permission of its own.
- Two people talking to the same agent hold two threads and see two histories.
  Every read is scoped by `oxy_user_id` as well as `agent_id`; a lookup on the
  agent alone passes every single-user test ever written.

### The agent can SUGGEST a new stretch

`suggestNewConversation` emits `alia.suggest_new_conversation`
(`{ eventVersion: 1, reason }`) and does nothing else. **It cannot start a
conversation** — that is `POST /conversations/new` with the same `agentId`, a
request the client makes after a person accepts. If the agent could cut by
itself it would be throwing away its own context mid-task, and a person would
watch their conversation split without asking.

It is a TOOL rather than a server-side event because the requirement is that the
agent suggests it *when it considers it necessary* — the model decides. The only
server-side trigger available is elapsed time, and that heuristic lies the day
somebody returns a week later to continue the same idea.

**At most one per turn, enforced by the server**, not by the model behaving: the
factory runs once per turn and holds the flag, so a model that calls it three
times emits once and is told so. It carries no capability family — it reads
nothing, writes nothing and leaves the process only as a frame the person may
ignore — so it sits in `UNGRANTED_TOOLS` beside `planPreview` and `plan`.

### Getting back to something old

Three ways, in order of cost, and the third is the one with a decision in it:

1. **`GET /agents/thread/:username/messages`** — a page of the thread, crossing
   the seams.
2. **`GET /agents/thread/:username/search?q=`** — the person's own search.
3. **The `searchThread` tool** — the agent's recall, over the SAME index and the
   same query, so what counts as text is defined once.

Both search paths go through `searchThread`, which matches a `tsvector` built by
`alia_message_text` — a Postgres function created by hand in `0047`, because
`content` is `jsonb` and an index expression may not contain a subquery. It
takes a bare JSON string as itself and, from a parts array, only the
`type: 'text'` parts in order. **Tool payloads and attachments are deliberately
not searchable**: a hit on somebody else's API response shows a person a message
whose visible body does not contain what they searched for.

**Text, not embeddings, and that is the decision.** An embedding per message is
a cost per turn and a second store that grows without bound —
`db/schema/context-graph.ts` already records that the autonomy graph mints a node
per chat turn and that nothing reaps them. A `tsvector` adds no store. If the
text proves too blunt, embeddings are the answer and the evidence for adding
them is a measurement of this failing.

Every word in a query must be present (`websearch_to_tsquery` ANDs unquoted
terms — measured), with quoted phrases and `-` exclusion on top. The tool says
so in its description and again in the sentence it returns for an empty result,
because a bare `[]` reads to a model as a broken tool.

**The cursor is opaque and is not `seq`.** `seq` is absent on legacy messages
(`routes/webhooks.ts` appends bot turns without one) so paging by it skips old
rows silently, and it is unique only within a conversation so it cannot even
order a thread. The cursor is `(created_at, id)`, base64. `?before=` is
exclusive and scrolls back; `?at=` opens the window CONTAINING a message, which
is what a search hit's `cursor` is for — `before` cannot serve it, since the hit
would be the one message missing from the window meant to reveal it.

## Execution Loop

Every interaction follows one runtime loop:

1. `classify` - detect intent.
2. `recall` - load ranked sources + rules.
3. `retrieve` - gather context from top sources.
4. `act` - produce answer and run tools.
5. `learn` - update source quality and learned rules.

This loop is shared across app, Codea, and Cowork.

## Intents

Current first-wave intents:

- `meeting_prep`
- `inbox_digest`
- `project_status`
- `task_followup`
- `monitoring`
- `research`
- `general`

## Context Graph

Persistent entities, read through `db/autonomy/contextGraphRepository.ts`:

- `context_sources` - where data lives and how reliable it is.
- `context_nodes` - discovered entities (people, projects, docs, threads, etc.).
- `context_edges` - relationships between nodes.
- `retrieval_strategies` - per-intent navigation strategy.
- `learning_rules` - learned corrections, preferences and constraints; read through `db/autonomy/learningRuleRepository.ts` rather than the context-graph repository.

Ranking combines freshness, precision, and cost to choose source order.

## Capabilities

What an agent may reach is `agents.capability_grants`: one list of
`family` / `family:instanceId` strings, and the ONLY input that partitions
`ToolPipeline.forUser`. The families and the argument for each are in
`domain/capability-grants.ts`; the table of which tools each contributes is in
`docs/chat-runtime.mdx`.

Two properties are worth stating outright, because both reverse what came before:

- **Empty denies.** An agent whose owner has granted nothing reaches only
  `UNGRANTED_TOOLS`. The three vocabularies this replaced —`capabilities`,
  the six `permissions_*` columns and `archetypeConfig.knowledgeSources`— all
  treated an unset value as *allowed*, so an agent nobody had configured could
  reach everything its owner could.
- **Connectors are granted one at a time.** MCP connectors, Oxy services and
  OAuth integrations build their tool names from rows, so a grant names the row.
  An agent no longer inherits every connector its owner has installed.

### Talking to your own agents

`agent:<agentId>` is the fourth row-at-a-time family, and it is separate from
`delegation` on purpose: that one finds, hires and creates agents from the
CATALOGUE, this one reaches the agents you already have. Granting it exposes one
tool, `askAgent`, whose schema names exactly the agents the grant resolved to.

Two shapes, both real:

- `agent:<agentId>` — that agent, and no other.
- `agent` — every one of your agents whose `status` is `active`, resolved again
  on every turn, so a new agent joins on its own and switching one off removes
  it. The only bare instanced grant the vocabulary accepts; `EVERY_ROW_FAMILIES`
  argues why this family may and the connector families may not.

The id the model names is re-checked in `execute` against the allow-list the
server resolved AND against the row itself — same owner, still active. A grant
written by one owner never resolves against another person's agents, including
when a `public` agent runs inside a stranger's turn.

The answer comes from a nested turn (`lib/tools/agent-turn.ts`): the target's own
prompt, the target's own capability grants, reserved and settled against the
account that funds the outer turn. It does not act for a person, so it holds no
`askAgent` of its own — A can ask B, and B cannot ask back.

`lib/__tests__/capability-grants.test.ts` is what says the vocabulary is wired:
it grants one family, runs the real assembler and asserts the set gained exactly
that family's tools. A grant that reaches nothing produces an empty difference
and fails — which is the control the two dead vocabularies never had.

## Governance

Risk policy is enforced per action:

- `R0` read-only: autonomous.
- `R1` reversible write: autonomous + rollback record.
- `R2` external/unknown impact: approval required.
- `R3` destructive: blocked.

User approvals are interactive and real-time. `alia.approval_request` and `alia.approval_result` travel over Socket.IO, to the `agent-session:<sessionId>` room (`packages/api/src/socket.ts:216`, `:231`) — not over the chat SSE stream.

## Triggers and Proactive Runs

`/automations` is the normalized control plane for proactive work. Each definition stores
its objective, actor selection, trigger, resources, exact actions, allowed data flow,
limits, autonomy policy and `observe | execute` mode. Runs and their correlated policy
and tool decisions are persisted in `automation_runs` and `automation_steps`.

`/triggers` remains the transitional API for legacy routines. It supports:

- `schedule`
- `webhook`
- `integration_event`
- `agent_heartbeat`

Legacy executions remain in `trigger_executions`. Both scheduled row types are reconciled
by the same elected scheduler; there is no second automation runtime.

## Oxy Event Autonomy

`POST /webhooks/oxy` accepts normalized application events and enforces:

- Central Oxy service-identity authentication with the
  `capability-events:publish` scope.
- Ownership of the signed capability catalog for the event's app and declaration of
  the event type in that catalog.
- Exact app, effective-account and resource agreement in the event envelope.
- Idempotency by `(appId, eventId)` before matching structured automations.
- In-app and push notification fallback when asynchronous dispatch fails.

Alia stores neither per-app HMAC secrets nor user bearer tokens for these events. An event
selects an existing eligible automation and actor; execution authorization is resolved
at run time through Oxy and delivered to each app as a short-lived capability ticket.
The former `POST /webhooks/oxy/:serviceId` route is retired and returns `410 Gone`.

## Model Abstraction

The product surface exposes only the `alia-*` identifiers (`kaana-lite`, `kaana-v1` and so
on). Upstream routing detail is never returned to users. Several of those identifiers are
routing policies rather than models, and the set is frozen — see
[model abstraction](./model-abstraction.mdx).
