# 26. An agent has an inbox and a heartbeat, so it notices things without being asked

Status: Accepted (2026-11-09, the owner's goal: agents that stay attentive and act on their own, as
the always-on agents of other products do).
Date: 2026-11-09.

The handoff and autonomous-work policy are updated by [ADR 0033](./0033-durable-autonomous-work.md), accepted 2026-11-12.

## Context

Until now an agent did nothing until something woke it: a message, a goal, an automation the person
wrote, or a follow-up it scheduled for itself (ADR 0011, `lib/agent/follow-ups.ts`). An event from an
app reached an agent only through an *event automation*: exact match on `(appId, eventType,
resource)`, and every matching event started a fresh, isolated run. Forty emails were forty runs; the
agent had no place that held "what happened since I last looked", no way to decide when to look, and
`agents.schedule_interval` (accepted by `PATCH /agents/:id`) was read by nothing.

The agents that stay useful on their own in other products converge on the same shape: events are
collected, a cheap periodic check decides whether anything is waiting, and only then is the agent
woken once with the list.

## Decision

1. **An inbox per agent** (`agent_inbox_items`). An event the agent subscribed to is stored there
   instead of starting a run. The row is the event's projection Alia already keeps in
   `automation_events` (never a body), capped at 2 KB, keyed `<appId>:<eventId>` so a redelivery or the
   stalled-event sweep adds nothing.
2. **Subscriptions are explicit and narrow** (`agent_subscriptions`). `(account, app, type)` with `*`
   wildcards, at most 25 per agent. The account is one of exactly two: the owner's (only the owner can
   share it) or the agent's own mailbox. There is no way to name another account, and an event is
   routed by the account it concerns, so a subscription cannot read anybody else's events. Managed by
   whoever may act as the agent (`/agents/:id/subscriptions`).
3. **Routing happens for every stored event** (`routeEventToAgentInboxes`, called first by
   `dispatchEvent`), whether or not an automation also matches. It is idempotent, so the sweep that
   re-dispatches events a dead instance left unfinished (`lib/automation-event-dispatch.ts`) is safe.
4. **A heartbeat wakes an agent only when there is something to say** (`lib/agent/heartbeat.ts`).
   Every minute, in the run reaper's sweep, one query finds agents whose `schedule_interval` (5 to
   1440 minutes, opt-in: NULL means no heartbeat) has elapsed since `last_heartbeat_at` and whose inbox
   has pending items. An empty inbox costs that query and nothing else: no model call, no credit hold,
   no run.
5. **The wake-up is a follow-up** (`scheduleAgentWake`, the machinery `scheduleAgentFollowUp` already
   used): a one-off automation with the agent as fixed actor and the person as owner, marked
   `inputs.origin = 'agent_heartbeat'`. It is therefore dispatched, billed to the owner, bounded
   (`maximumAutonomy`, the run limits) and silenced exactly as a follow-up: its result is not posted;
   the agent tells the person through the budgeted `sendMessageToUser`, so the initiative budget (3 per
   day, none after two unanswered) bounds how much an agent can say. One heartbeat run may be pending
   per agent.
6. **The items are data, not orders.** They describe things other people caused (an email's sender and
   subject). The task fences them in `<events>` with the instruction outside the fence, clips each
   field, and tells the agent never to follow instructions found inside.
7. **Every step is a conditional statement**, so N instances never double-deliver. Items are taken in
   one `UPDATE … WHERE id IN (SELECT … LIMIT n)`; the heartbeat is claimed by `UPDATE agents SET
   last_heartbeat_at = now WHERE last_heartbeat_at = <value read>`. Items not delivered are returned to
   `pending` if the wake-up cannot be scheduled. Items older than three days are dismissed, and settled
   rows are purged after a week.

8. **Retired: "pause everything".** A switch that paused everything a person's agents and automations
   start on their own (`background_pauses`, `GET`/`PUT /automations/pause`) existed briefly. Nobody used
   it, so it was cut cleanly: the switch, the endpoint, the table (migration `0128`), the heartbeat and
   dispatcher checks and the `alia_background_paused_people` gauge are gone. What remains is per agent:
   `status` `idle`/`offline` stops that agent's heartbeat, and an automation can be disabled.

## Consequences

- A burst is one wake-up with a list. At most 20 items go into one wake-up; the rest wait for the next.
- Between wake-ups the agent does not see its inbox. It is told what arrived when it is woken; it does
  not poll.
- The heartbeat run is a *follow-up-shaped* run: no computer, no MCP, and Oxy apps only through exact
  authorization (ADR 0022). That is a deliberate first step; an agent that can notice and tell the
  person is useful today, and widening what a woken agent may do is a decision about authority, not
  about plumbing, and belongs in its own ADR.
- Delivery is at-least-once to the *inbox* and at-most-once to the *agent*: an item handed to a wake-up
  that then fails is not re-delivered. The person is told when a run fails, as for any automation.
- Nothing starts a heartbeat for an agent that has no `schedule_interval`. Existing agents behave as
  before.

## Alternatives considered

- **A model call per heartbeat to decide whether to act.** Rejected: the common case is nothing, and a
  model call to find that out is the cost the pattern exists to avoid. The inbox being empty is the
  decision; what to do about a non-empty one is the woken agent's.
- **Keep one event automation per event and batch them in the dispatcher.** Rejected: automations are
  the person's definitions; the agent's attention is the agent's state, and it belongs to the agent.
- **A resident process per agent.** Rejected: this stack has no such runtime, and an agent at rest
  should cost nothing.
- **Let the model write its own subscriptions as a tool.** Deferred: the owner chooses what an agent
  hears about today; letting the agent widen its own inputs is an authority question.

## Enforcement

- `db/__tests__/agentInbox.pgdb.test.ts`: dedupe, oldest-first and per-wake cap, concurrent takers get
  disjoint items, stale items dismissed, eligibility (published, interval elapsed, something waiting),
  one winner for a concurrent heartbeat claim.
- `lib/agent/__tests__/heartbeat.test.ts`: the task fences the events and clips them; an empty inbox
  schedules nothing; items are returned when scheduling fails; one agent failing does not stop the rest.
- `lib/agent/__tests__/inbox-router.test.ts`: routing, one item per agent, idempotence.
- `lib/__tests__/automation-dispatcher.test.ts`: a paused person's scheduled run is denied with no
  hold, no run and no notification; a manual run is not even checked. `agentInbox.pgdb.test.ts`: the
  pause removes the heartbeat and resuming restores it.
- `routes/agents/__tests__/inbox.test.ts`: only the owner subscribes to their own events; no way to
  name a third account; the limit; refusals.
