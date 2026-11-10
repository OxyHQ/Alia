# 30. A coding-agent CLI on a person's own computer can be one of their agents

Status: Accepted (2026-11-10, the owner's decision: a person pastes a short text into Claude Code,
Codex or OpenCode and the agent shows up in Alia's sidebar, answering with the person's own
subscription, and other agents of Alia can talk to it the way they talk to each other).
Date: 2026-11-10.

## Context

Alia has no inbound surface for other agents: no MCP server, no A2A or ACP endpoint, no pairing.
`/ws/mcp` (`packages/api/src/lib/mcp-relay.ts`) runs the other way: Cowork and Codea lend Alia
*tools*. An MCP server would not help either, because MCP is pull: the agent calls tools, and nobody
can wake it with a message.

Three constraints shaped the answer:

- Alia issues no keys of its own (`AGENTS.md`, "Alia no emite ni acepta claves propias"); every
  credential is Oxy's. Oxy's machine key opens a chat lane with no tools, which is not an agent.
- The model must run on the person's **subscription**, not on an API key. The vendors differ on what
  that allows: Anthropic permits the unmodified `claude` binary signed in by its user and forbids
  routing a subscription's credentials through a product; OpenAI supports Codex's login in external
  tools; Google bans third-party use of Gemini CLI's OAuth. So Alia must never hold or relay a
  vendor token.
- Agents already talk to each other in rooms (ADR 0025) through `runAgentTurn`, and every other
  caller (`consultAgent`, the 1:1 chat) reaches an agent the same way.

## Decision

1. **A daemon on the person's computer dials Alia; Alia never dials in.** `codea connect` (the
   Codea CLI) holds one outbound WebSocket per agent to `/ws/external-agent`
   (`lib/external-agents/relay.ts`, a `WebSocketRoute` beside `mcpRelayRoute`). A turn is a `turn`
   frame down and `delta`* + `end` (or `error`) frames back. Nothing listens on the machine.
2. **The daemon runs the person's own CLI, signed in as them.** Claude Code (`claude -p`), Codex
   (`codex exec`) and OpenCode (`opencode run`), without a shell, read-only unless the person starts
   the daemon with `--write`. Alia sees text, never a vendor credential.
3. **An external agent is an ordinary agent plus a link.** Pairing creates the usual Oxy `bot`
   account and `agents` row (private, unlisted) and one `external_agent_links` row. The `agents`
   table gains nothing, so it keeps its migration locks and its CHECKs. `runAgentTurn` asks
   `isExternalAgent` first and, if so, hands the turn to the relay: this one branch serves
   `consultAgent`, group rooms and everything else. The direct 1:1 chat has its own branch
   (`routes/v1/chat-completions.ts`) because it streams and stores through the chat lifecycle. An
   external turn costs no credits; the reservation is left unsettled and the handler's release point
   refunds it.
4. **Pairing is a single-use code, not a secret.** The app mints `XXXX-XXXX-XXXX`
   (`POST /agents/external/pair`), stores only its SHA-256 and returns the text to paste. The daemon
   redeems it with the person's own Oxy session (`POST /agents/external/redeem`); the redeeming
   account must be the one that minted it, the code lives 10 minutes, and consuming it is one
   conditional `UPDATE` so two daemons cannot both win. The daemon signs in to Oxy by the existing
   device flow (`codea login`); the pasted text contains no long-lived token. Rows are swept at
   `expires_at` (`db/expiryTargets.ts`).
5. **The socket authenticates the session and the link.** The first frame carries the Oxy bearer
   and the agent id; the relay accepts it only if the session's account owns a live link to that
   agent. Revoking (`DELETE /agents/external/:agentId`) marks the link revoked and closes the
   socket.
6. **What other people and agents write is untrusted.** The daemon frames each turn as data and
   states that the conversation cannot widen what the person already allowed the CLI to do.

## Consequences

- A connected agent appears in the sidebar and answers 1:1, in group rooms and when consulted; its
  presence is reported by `GET /agents/external` (`online`).
- **One API instance.** Like the MCP relay, a connection lives in the process that accepted it. A
  turn running on another instance reports the agent offline. Cross-instance routing (Redis
  pub/sub) is not built; until it is, this holds at one replica or with sticky routing for
  `/ws/external-agent`.
- **The daemon's bearer is the person's Oxy session**, the same scope `codea login` holds today. A
  narrower Oxy scope for external agents does not exist yet.
- **Claude Code's terms** are the grey one: the daemon spawns the unmodified binary on the
  person's computer, which Anthropic's text permits, but a high-volume automated loop may exceed
  "ordinary, individual usage". The app tells the person.
- Turns are stateless: the daemon sends the conversation as text each time. Resuming the CLI's own
  session (`claude --resume`, `codex exec resume`) is a follow-up.
- Gemini CLI and Grok are not supported; both speak ACP, and a generic ACP adapter is the planned
  way in.

## Not built

- Cross-instance delivery, a narrower token scope, session resume, ACP adapters, and a
  presence dot in the sidebar. None of them exists in the code at the time of writing.
