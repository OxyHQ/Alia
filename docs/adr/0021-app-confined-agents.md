# 21. An app's agent may be confined to that app, by Oxy

*El agente de una app puede quedarse dentro de esa app, por decisión de Oxy.*

**Status:** Accepted

**Date:** 2026-10-16

**Amends:** ADR 0020 §1 and §5.
**Depends on:** Oxy ADR 0044.

## Context

ADR 0020 removed `agents.application_id`, the binding that made a product agent
reachable only through its product's backend. Clarity's assistant must still be
usable by everybody but only inside Clarity. The owner decided on 2026-10-16
that this is an Oxy platform rule about Oxy's own applications, not a setting
anyone can apply to their agents, and that it must be done properly, with no
special lane.

## Decision

1. **Where an agent opens is Oxy's fact, read live.** Alia asks Oxy
   (`GET /capabilities/agent-availability/:agentAccountId`) whether an agent is
   confined and to which applications, caching the answer briefly. Alia stores
   no copy and offers no editor control for it.
2. **The surface is the session's application.** Oxy's validation of the
   person's session gives the `applicationId` of the client that session
   belongs to. Alia never reads a surface from the request.
3. **One reach rule.** `canReachAgent` answers `out_of_reach` for a confined
   agent when the session's application is not one it is confined to. Opening
   the agent, `consultAgent`, `searchAgents` and every agent read route go
   through it, so a confined agent is invisible outside its app.
4. **Nothing else differs.** The confined agent is an ordinary agent: `access`
   decides who, Oxy decides where, the person pays, the SDK draws it, and its
   app authority is its ceiling.

## Consequences

- Clarity's assistant is `public` and confined to Clarity. Sindi is not
  confined.
- A session with no application (a service or API-key turn) reaches no
  confined agent.
- ADR 0020's deletion of `agents.application_id` stands; this does not
  re-add it.

## Enforcement

- `canReachAgent` tests: a confined agent is reachable from its app's session,
  unreachable from any other session, from Alia's own app, and from a session
  without an application; `searchAgents` and `consultAgent` refuse it outside.
- No Alia table or column holds an application binding for an agent; a grep
  gate in the clean-cut step fails on `application_id` in the agents schema.
