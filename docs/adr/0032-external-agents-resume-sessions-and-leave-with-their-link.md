# 32. External agents continue the CLI's own session and are deleted with their link

Status: Accepted (2026-11-10). Completes [ADR 0030](./0030-external-agents.md) and
[ADR 0031](./0031-external-agents-edit-by-default-and-span-instances.md).
Date: 2026-11-10.

## Context

Four things ADR 0030 listed as not built, or that its use exposed:

- Every turn was stateless: the daemon re-sent the conversation as text, so the CLI lost its own
  tool context between messages and the prompt grew with the conversation.
- Revoking an agent dropped its link but left the `agents` row, which then answered as an ordinary
  agent with Alia's model.
- The sidebar listed an external agent like any other, with no sign that its computer was off.
- The migration for the ADR number collision: ADR 0028 was taken at the same time by Spaces, so the
  external-agents ADRs moved to 0030 and 0031.

## Decision

1. **A conversation continues the CLI's own session.** A turn frame carries `threadKey` (the Alia
   conversation id) for direct chats; the daemon keeps `<agentId>:<threadKey> -> session id` in its
   config (bounded to 300) and resumes it: Claude Code with `--resume <session_id>` (read from the
   `result` event) and Codex with `codex exec resume <thread_id>` (read from `thread.started`).
   A resumed turn sends only the new message. If the CLI no longer has the session and nothing was
   streamed yet, the daemon starts a new one with the conversation spelled out. Consultations and
   room turns carry no key and stay stateless; OpenCode stays stateless (`resumes: false`).
   Codex's mode now goes through `-c sandbox_mode=…`, because `exec resume` takes no `--sandbox`.
2. **Revoking deletes the agent.** `DELETE /agents/external/:agentId` revokes the link, cuts the
   socket (on any instance) and then deletes the agent row. The Oxy `bot` account survives, as for
   every deleted agent (`DELETE /agents/:id`).
3. **The agent list says when the computer is off.** `GET /agents/me` adds
   `external: { cli, online } | null` per agent (presence through `lib/external-agents/presence.ts`,
   loaded lazily), the sidebar shows "Offline" under an external agent that is not connected, and
   re-reads the list every 30 s while any of the person's agents is external.

## Consequences

- A resumed Codex or Claude session is the CLI's own, on the person's computer: Alia stores no
  transcript of it beyond the chat messages it already stores.
- The session map is per machine. Reconnecting the same agent from another computer starts fresh.
- Still not built: ACP adapters (Gemini CLI, Grok), a narrower Oxy scope for the daemon's token,
  and resuming OpenCode.
