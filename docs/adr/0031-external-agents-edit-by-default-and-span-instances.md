# 31. External agents edit their working directory by default and are reachable from any instance

Status: Accepted (2026-11-10, after the first real use of ADR 0030: replies came "sometimes", and
when they came the agent often said it had no permissions). Refines [ADR 0030](./0030-external-agents.md)
without reversing it.
Date: 2026-11-10.

## Context

Two things in ADR 0030 failed in use:

- Its "Consequences" accepted that a connection lives on one API instance and that a turn started on
  another reports the agent offline. Production runs more than one, so an agent answered only when the
  request landed on the instance holding its socket.
- It ran the CLI read-only unless the person started the daemon with `--write`. Measured with the
  installed `claude` 2.x and `codex` 0.167 (`codea connect` adapters, prompt "create a file and run
  `ls`"): read-only, Claude Code answered "write permission wasn't granted" and Codex "the filesystem is
  read-only"; with editing allowed, both did it. The person never sees the flag, because an agent
  pasted the command, so every action request read as "no permissions".

## Decision

1. **Turns cross instances through Redis** (`lib/external-agents/cluster.ts`). The instance holding a
   daemon's socket sets a presence key (`alia:xagent:online:<agentId>`, 90 s TTL, refreshed with the
   socket's 25 s ping) and listens on `alia:xagent:cmd:*`. An instance without the socket publishes a
   `turn` command, listens on `alia:xagent:evt:<turnId>` and receives `ack`, `delta`, `end` and `error`
   events; an `ack` that does not arrive in 4 s means the claim outlived its holder and the agent is
   offline. `cancel` and `revoke` travel the same way. Without Redis the bus is `null` and nothing
   changes. `GET /agents/external` reports presence from any instance.
2. **The daemon may edit its working directory by default.** Claude Code runs with
   `--permission-mode acceptEdits` and Codex with `--sandbox workspace-write`; both stay confined to
   the directory `codea connect` was started in. `--read-only` restores the old behaviour, and a
   read-only agent is told to say how to lift it rather than that it lacks permission. The pasted text
   asks the agent to run the command from the folder the person wants worked on and says it can edit
   files there.

## Consequences

- The delivery is at-most-once and best effort, like the room bus (ADR 0025): a Redis blip fails the
  turn with "offline" rather than hanging.
- Presence can be stale for up to 90 s after an instance dies; a turn then fails after the 4 s ack
  wait, not later.
- Shell commands beyond what the CLI's own mode allows still need the person's approval inside that
  CLI, which a headless run cannot give. A fuller-access mode (`bypassPermissions`,
  `danger-full-access`) is not offered.
- Revoking an agent drops its link but leaves the agent row: it then answers as an ordinary agent.
  Deleting it on revoke is not built.
