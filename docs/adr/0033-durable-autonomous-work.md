# 33. Durable autonomous work, with the original requester's authority

Status: Accepted, 2026-11-12, by the owner's request to implement autonomous collaborators.
Supersedes ADR 0026's handoff and ADR 0027 decision 2. Exact-action automations remain exact-action automations.

## Decision

An agent can investigate, continue a task and start useful related work, including acting through its existing tools. A heartbeat is not a second runtime or an authorization shortcut: it submits to the existing leased runner, tool assembler, product policy and credit accounting. No per-action approval flow is added. External connectors retain their live grants; Oxy tools retain requester, actor, account and resource checks. Agent memory remains per agent and person.

`POST /agents/:id/work` establishes an Oxy goal task from the actual owner's authenticated session. The app calls it for active owned agents with attention enabled after account restoration; creation and settings changes also establish it. Store only the returned task id and expiry. A bot owner id from an event is never enough. Existing pauses remain pauses; new agents start with a 60-minute attention interval. Sources remain explicit subscriptions.

`agent_work_authorities` owns standing task lifetime. Individual executions must not retire that root. Disabling autonomous work persists its revocation in an outbox that survives agent deletion; pending work is cancelled and workers observe cancellation before inference and between steps. A source session's own task remains live while its dated follow-ups remain pending or running.

`agent_work_items` is a durable outbox. Taking an inbox batch, advancing its heartbeat timestamp and creating work commit together. The common empty case never calls inference. Dispatch creates the session, its credit hold and its work association in one transaction, after remote credit preflight. Queue delivery happens afterward and can be repeated using the same session. Admission serializes across replicas and waits while that person's agent is already busy. Terminal work is not automatically replayed.

Follow-ups store an absolute date and source session, not an annual cron. Continuations carry the originating objective and bounded earlier result and plan; their shared root accounts for consumed steps and tokens instead of resetting the allowance. A work chain is bounded to 50 steps and 100,000 tokens; existing per-execution time, credit and tool limits also apply. Five follow-ups may be pending. Transient admission failures back off, with at most twelve attempts. No new daily inference quota is introduced.

Unexecuted historical internal one-shots are adopted when the actual owner establishes work authority. Their original date is recovered relative to creation, preserving the old 90-day horizon. Old, ambiguous or expired work is not replayed. Migration and dispatch share the definition lock. User-defined automations and executed history are not converted.

Events are JSON-encoded, escaped and bounded UTF-8 projections, never stored email bodies. Event-dispatch failures remain retryable with backoff; only exhaustion is terminal. The per-email classifier is skipped only when the same agent has already received that event durably and can process its batch. Personal Alia email alerts retain their existing behavior.

Work and conversation are separate: unanswered check-ins limit notifications, not progress on authorized tasks. Check-in admission and message insertion serialize across replicas, with stable receipts for retried messages. Requested results do not consume the check-in allowance. The inbox surface exposes waiting, working, scheduled, paused and blocked states.

## Evidence and implementation constraints

- [Grok routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) distinguish event sources from tools and warn that frequent triggers consume usage. [Initiative](https://docs.x.ai/grok-bot/initiative) distinguishes suggestions from action.
- [Dots tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory) documents responsibilities, explicit schedules/events and selected task context; connecting an app alone is not monitoring.
- [Claude Duet](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet) documents background work and interval-based account checks.
- [Manus schedules](https://manus.im/blog/manus-schedules) preserve existing task context. Its [API webhooks](https://open.manus.im/docs/v2/webhooks-overview) are outgoing task-status callbacks, not evidence of generic incoming monitoring.
- [Muse's design](https://muse.ai/blog/how-we-designed-muse) describes sustained goals and initiative; its [security design](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse) separates agent execution from authority enforcement.
- [nanoMuse source](https://github.com/nano-muse/nanoMuse/blob/c4fda49b802371c464a85e29ab9b5b1697ad09dd/nanomuse/server/service.py), the successor to OpenMuse, persists delivery claims, replays pending work and selects due work without inference when nothing is actionable. It is an independent implementation, not Meta's source.

These support the product and reliability choices. Closed products do not disclose sufficient internals to claim their scheduling algorithm or operating costs. Alia reuses its own infrastructure. GitHub MCP tools do not constitute an incoming PR event source; adding that source is separate work.

## Verification and rollout

Additive pre-deploy migrations precede new readers. Verify PostgreSQL rollback and concurrent claims, held-credit/session atomicity, queue interruption, continuation provenance, cumulative limits, cancellation, event retries and message deduplication. Verify web/native account restoration, no requests before usable authentication and no cached empty success from a 401. SDK consumers require Oxy Services 14.19.1 or newer.

Deploy only after package tests, type checks, lint and CI pass. Verify the exact API image, web revision and compatible mobile update separately. A successful rollout or enabled Inbox outbox flag alone does not prove an agent received and acted on an event.
