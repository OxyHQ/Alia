# Background work and proactive outreach

Last updated: 2026-10-06

Alia proactive intelligence has one normalized control plane (`/automations`) and
one elected scheduler (`trigger-engine.ts`). A task always owns its human objective,
schedule and a responsible actor: Alia by default (`actorSelection: { mode: 'alia' }`,
what an omitted `actorSelection` means), or one of the person's agents. Nobody has
to pick an agent; agents are optional. Connected work additionally owns exact Oxy
actions, data flow and limits; reminders, research and assistant responses
deliberately carry no fabricated app resource or tool.

The actor model behind this page is [Actors: Alia and agents](./actors.mdx); the
control-plane endpoints are in [API reference](./api-reference.md).

## Who runs a task

| `actorSelection` (`automation_definitions.actor_mode`) | Who is responsible | How it runs |
|---|---|---|
| omitted, or `{ mode: 'alia' }` | Alia | One unattended Alia turn on the `alia-tasks` queue (below), under her standing authority. |
| `{ mode: 'fixed', agentId }` | that agent | The agent receives the prompt in a durable session; connected actions go through the coordinator. |
| `{ mode: 'automatic', eligibleAgentIds }` | the first eligible agent per action | The coordinator assigns each ordered action to an agent whose live capability map covers it. |

Which agent may be named is one rule shared by creation and dispatch
(`mayRunForAutomationOwner`, `lib/automation-actors.ts`): the owner's own agent, or a
public, active marketplace agent — never by `author`, and never an agent Oxy confines to
an app (ADR 0021): an unattended run has no app to be in.
Schemas: `lib/structured-automation-creation.ts`.

## Alia's standing authority

Alia acts for the owner in their Oxy apps the way an assistant reads its owner's
mail: no permission prompt per run. When an Alia task is created or edited in
execute mode while the owner's bearer is present, Alia asks Oxy for `automation`
execution authorizations with actor `{ type: 'alia', ownerAccountId }`
(`provisionAliaTaskAuthorizations`, `lib/automation-authority.ts`):

- every READ tool of every Oxy app at the owner's account root, `read_only`,
  best effort (a refused read only leaves that tool out) — so "summarise my
  email every morning" works unattended;
- each declared connected action exactly, at the task's autonomy,
  all-or-nothing (one refusal revokes the rest and the task stays inert).

Only opaque Oxy ids are stored, in `alia_task_authorizations`; Oxy re-checks
live authority, account policy and catalog on every ticket, and issues it for
the run (`runId`, plus the action's `stepId`). The runner passes them to
`ToolPipeline` as `oxyExecutionAuthorizations`: reads are `repeatable`, a
declared action runs once per run. A task with none (older tasks, API-key
callers) gets no Oxy app tools. Stopping or editing a task revokes them with
the agent path's authorizations (`listActiveTaskAuthorityIds`). A watch gets no
app reads. New apps registered after the task was saved are covered at its
next edit; authorizations expire after a year like the agent path's.

## Watches

`inputs.watch = { url | query, condition: 'change' | 'contains', value? }` on
an Alia schedule task makes each tick cheap (`lib/alia-watch.ts`): a Clarity
page read or search, normalised and hashed, compared with
`automation_watch_states`. Only when the condition is crossed (a new result
URL, a changed page hash, or `value` newly present) is an Alia run queued, with
the change in `trigger.watch`; it decides whether to tell the person and
replies `NOTHING_TO_REPORT` otherwise. Ticks are free; only the run holds and
spends credits. The run's trigger id `watch:<id>:<hash>` makes it and its
message idempotent. A failing source backs off `min(60, 2^n)` minutes and after
5 failures in a row the task is disabled with one notification.

## Writing first: an important email

Alia and every agent behave like a friend who tells you when something that
needs you arrives — and never like a feed. `lib/proactive/email-outreach.ts`
handles Inbox's `new_email` event (version 1.1.0: `messageId`, `from`,
`subject`, a one-line `snippet` of at most 140 characters, and `folder`),
delivered on the same signed lane as every Oxy event (`POST /webhooks/oxy`).
It runs once per claimed event, beside — never instead of — automation
matching, and its failures notify nobody.

| Mailbox | Who is told | Where |
|---|---|---|
| The person's own Inbox | the person, by Alia | Alia's outreach conversation (`postAliaCheckIn`): one per person, id derived from the person (`aliaOutreachConversationId`) |
| An agent's OWN mailbox (its bot account, ADR 0015 `self_*`) | the agent's owner (`owner_oxy_account_id`), by the agent | their thread with the agent (`postAgentMessage`, `check_in`) |

The order is cheapest first, and the model is last:

1. `folder` other than `inbox` (Junk) → nothing.
2. Who would be told: a person who never opened Alia (no conversation at all)
   is skipped; an agent without an owner tells nobody.
3. Their switch — "Avísame de emails importantes", per actor, default **on**
   (`email_alert_preferences`; `GET|PUT /notifications/email-alerts`, the app's
   *Avisos* settings page). An agent's switch is its owner's alone.
4. The idempotency claim, `email_outreach_decisions(mailbox, message id)`,
   written before the classifier: a redelivered or duplicated event stops here.
   It stores the verdict and a closed-vocabulary reason, never the email, and is
   swept after 90 days (`db/expiryTargets.ts`).
5. The initiative budget, the agents' and now Alia's too
   (`lib/agent/outreach-budget.ts`): at most **3** own-initiative messages to a
   person per actor per rolling day, and none while the actor's last **2** are
   unanswered. A person who got three today costs no inference.
6. One call to the computed utility model (`generateTextViaKaana` with no
   `model`, ADR 0012), `json_schema` response, temperature 0.

**The email is untrusted.** The classifier sees sender, subject and snippet —
never the body — JSON-encoded inside an `<email>` block it is told is data
written by a stranger (`<` escaped, so no field can close the block). It may
answer only `{verdict: important | not_important, category}` from two closed
lists; anything else, or a verdict whose category belongs to the other list, is
a failure and tells nobody. What the person reads is a fixed, localised
template (es/en) filled with the markdown-escaped, one-line, bounded sender and
subject: no model-written text exists that an injected email could steer, and
the snippet is never shown. `automation_events` stores the event without its
snippet.

## Nothing accepted is lost

The platforms that tell Alia about something do not tell her twice, so what is accepted is stored first
and finished from the store:

- **Oxy events** (`POST /webhooks/oxy`) are stored in `automation_events` before the 202 and
  dispatched in the background. `reapStalledAutomationEvents` (`lib/automation-event-dispatch.ts`, in
  the run reaper's minute sweep) re-dispatches any event still `received` or `matched` after two
  minutes, up to a day old. Dispatching is idempotent by event id.
- **Messaging-platform messages** (Telegram, Slack, ...) are stored in `channel_inbound` before the
  platform is acked, claimed by whichever instance answers, and swept by `reapStalledChannelInbound`
  (`lib/channels/inbound-sweep.ts`) if it died: one retry at most, because a second reply is worse
  than a quiet failure. The dedup is the table's unique key with the same 60-second window, so it holds
  across instances and restarts; the person's text is cleared when the row settles. A storage failure
  answers 500 so the platform retries.
- **A retried run does not repeat an undoable effect**: inside a run, `sendTelegramMessage` claims
  (run, person, message) in Redis before sending and releases the claim if the send fails.
- Redis is required in production: the API refuses to boot without `REDIS_URL`
  (`lib/boot-guards.ts`), because without it every queue runs jobs inline and a restart loses them.

## Seeing that it flows

`GET /internal/metrics` (authenticated as an Oxy service, like `/internal/trigger`) answers Prometheus
text: what the process counted plus gauges read from the stores
(`lib/observability/operational-metrics.ts`) — `alia_automation_events_stalled` and
`alia_channel_inbound_stalled` (anything above zero for more than a minute means a sweep is not taking
them), `alia_channel_inbound_failed_total`, `alia_agent_inbox_pending`
and `alia_queue_jobs{queue,state}` for the agent-session and Alia-task
queues. A queue that cannot be counted is left out so the rest still answers. Nothing scrapes it yet.

## An agent that notices things (ADR 0026)

Events an agent asked to hear about land in its **inbox** (`agent_inbox_items`) instead of each starting
a run. A **heartbeat** wakes the agent once with the list, and only when something is waiting.

- **Subscriptions** (`agent_subscriptions`, `/agents/:id/subscriptions`): `(account, app, type)` with
  `*` wildcards, at most 25 per agent. The account is the owner's (only the owner can share it) or the
  agent's own mailbox; there is no way to name another account. `routeEventToAgentInboxes` runs for
  every stored event, whether or not an automation also matches it.
- **Heartbeat**: opt-in through `schedule_interval` (5 to 1440 minutes, `null` turns it off). Every
  minute `runAgentHeartbeats` (`lib/agent/heartbeat.ts`) finds active agents whose interval has elapsed
  and whose inbox has pending items. An empty inbox costs one query: no model call, no hold, no run.
- **The wake-up** is a one-off follow-up-shaped automation (`inputs.origin = 'agent_heartbeat'`, one
  pending per agent) with the inbox rendered as one task. Its items are data from other people and are
  fenced in `<events>` with the instruction outside; at most 20 go in one wake-up, the rest wait. Its
  result is not posted: the agent speaks through the budgeted `sendMessageToUser`.
- **A woken agent has the follow-up run's authority and no more**: no computer, no MCP, Oxy apps only
  through exact authorization. Widening it is a decision about authority (ADR 0022), not plumbing.
- **Pausing**: an agent whose `status` is `idle` or `offline` is not woken, and an automation can be
  disabled. There is no switch for everything at once (it was removed, ADR 0026 §8).
- **Bounds**: at most 100 enabled automations per person (`MAX_ENABLED_AUTOMATIONS_PER_OWNER`); items
  older than three days are dismissed; deleting an agent removes its inbox, subscriptions and memory
  and disables the automations that name it.

## Abandoned Alia runs

An Alia run stores its credit hold on `automation_runs.credit_reservation` and
takes a 15-minute lease when its worker starts (the turn itself aborts at 10).
`lib/alia-task-reaper.ts`, in the agent run reaper's minute sweep, fails a run
whose lease lapsed or that stayed `planned` for 30 minutes, refunds it and tells
the person. Every settlement is a conditional transition of an open run, so the
reaper and a slow worker never both refund or charge.

## How a run executes

1. A trigger fires: a schedule tick, a matched Oxy event, or `POST
   /automations/:id/run` for a manual task.
2. For assistant-only work Alia is responsible for, the run is claimed with
   `selected_actor_type = 'alia'` and queued on `alia-tasks` (`lib/alia-task-queue.ts`).
   `lib/alia-task-run.ts` takes one unattended Alia turn for the owner (default
   model, no agent, web search on), settles the credit hold against the tokens
   spent and posts the answer into the task's own Alia conversation
   (`automation_definitions.conversation_id`, claimed on first delivery) with a
   notification that opens it. A failed last attempt refunds and says so there.
   For assistant-only work an agent is responsible for, that owned agent receives
   the prompt directly.
   For connected work, the coordinator assigns each ordered action to the first eligible agent
   whose live capability map covers it. The first stage must also cover every
   declared source resource.
3. Consecutive actions for the same agent form one stage. Each stage has its
   own session; one run may therefore identify several real Oxy bot accounts.
4. Observation mode records the complete actor/action graph without making a
   session or an external effect.
5. Execution mode loads only that stage's opaque Oxy authorization ids and asks
   Oxy for fresh capability tickets bound to the shared run and exact steps.
6. Stages run sequentially, with one durable session per `(run, stage)`. Each
   declared Oxy action can begin once in that session, and app idempotency keys
   protect effect retries. A prior result reaches the next agent only when the
   definition explicitly names a source and destination for that handoff.
7. The run finishes only after every declared action step succeeds, then sends
   the configured result notification.

An agent's own unattended run (a goal, `continueInBackground`, a follow-up) is a
durable session with a lease and the run reaper (`lib/agent/run-reaper.ts`); its
Oxy calls use Oxy's agent-run authorizations ([agents](./agents.md#oxy-apps-for-the-person-and-as-itself)).

## Triggers

`automationTriggerSchema` (`lib/structured-automation-creation.ts`) has three kinds:

- `schedule` — a five-field `cron` and an IANA `timezone`. `lib/trigger-engine.ts`
  is the one elected scheduler (leader election, a 30-second reconcile, and a
  catch-up for an occurrence missed during a deploy or an outage: the latest one
  inside a window of a quarter of the schedule's own gap, between 30 minutes and
  6 hours — `catchUpWindowMs` — and never more than one run per schedule). A
  recurring schedule may not fire more often than every five minutes
  (`automationScheduleTooFrequent`: the closest pair of the next twelve
  occurrences is compared, so `0,2 * * * *` is refused too); a one-off is exempt.
- `event` — an Oxy app event (`appId`, `eventType`, optional resource), matched by
  `POST /webhooks/oxy` (below).
- `manual` — only `POST /automations/:id/run`.

Runs persist in `automation_runs` and ordered `automation_steps`. Each Oxy step
carries its stable action id, fresh run/step correlation and policy decision.
Agent sessions carry an explicit `(automationRunId, stage)` binding; a unique
database index prevents duplicate sessions for one stage. Alia stores no user
bearer or app credential. The legacy `/triggers` model, its tables and its
`TriggerExecution` records are gone (migrations 0069 and 0070).

A task's `maximumAutonomy` bounds its connected actions: manual execution requires
`execute_on_request` or `autonomous`; background event and schedule execution
requires `autonomous`; `draft` and `read_only` definitions produce no effects.

## Governance

The risk classes (`R0`–`R3`) are documented once, in
[Agents → Governance](./agents.md#governance). No run — background or attended,
Alia's or an agent's — asks for approval (ADR 0020 §3): R2 runs flagged, R3 is
blocked.

The Oxy autonomy vocabulary is `read_only`, `draft`, `execute_on_request` and
`autonomous`; the most restrictive live policy wins. Risk classes still govern
Alia-local tools, while Oxy app effects are authorized by exact action/resource
capability tickets.

## Oxy Service Events

Source: `packages/api/src/routes/oxy-service-events.ts`

Behavior:

- Authenticate the publisher with an Oxy service identity and its signed app catalog.
- Dedupe by `(appId, eventId)` in `automation_events`.
- Match explicit source resources and deterministically build the eligible
  single- or multi-agent stage plan.
- In observation mode, persist the decision graph and execute nothing.
- In execution mode, require live capability coverage plus every durable action authorization before queueing.
- If autonomous execution fails, send an in-app/push fallback notification.

## Prompt suggestions are not an automation

Welcome cards come from the seeded `suggestions` catalogue. `POST
/suggestions/welcome` ranks that pool using the current user's memory when one
is available; opening an authenticated app session does not start inference or
write new suggestions.

`POST /suggestions/generate` remains an explicit authenticated operation for
creating personal suggestions. It makes one request through Oxy on the utility
model — the cheapest chat-usable catalogue model with at least 32k context,
computed rather than configured (ADR 0012). Oxy and Kaana own route selection
and retry, so Alia does not loop over providers or repeat an identical request. An Oxy routing refusal is `503` with its safe request ID; an
empty or schema-invalid model answer is `502`. Neither is presented as an
internal Alia `500`.
