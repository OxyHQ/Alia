# Embedding an agent: the wire contract

Alia ADR 0020 §5–§7. This is the contract between Alia's API and every surface that
opens a conversation through `@alia.onl/sdk` (19.0.0 and later): Homiio's "Ask
Sindi", oxy accounts' "Ask Alia", and the Alia app itself.

Alia is the lead of a conversation unless the surface names an agent. Any agent the
caller can reach (`canReachAgent`) can be opened. The conversation is billed to the
person present.

## 1. Opening an agent

`POST /v1/chat/completions` takes `agentId` with the agent's id. The lead participant
is that agent. Without `agentId`, the lead is Alia.

`GET /v1/agents/:id/profile` is authenticated by the person's session, and answers
404 when `canReachAgent` refuses:

```json
{
  "id": "…",
  "name": "Sindi",
  "handle": "sindibot",
  "character": { "…": "Oxy users.character" },
  "color": "teal",
  "description": "…",
  "greeting": "…",
  "starters": [{ "title": "…", "prompt": "…" }],
  "access": "public",
  "features": [{ "key": "attachments.documents", "gated": true }]
}
```

## 2. Host tools: UI effects in the embedding client

A request may declare the UI effects its own client can perform. What is on the person's screen is sent the usual way, in `clientContext`; `host` carries only the actions and the outcomes of earlier ones:

```json
"host": {
  "app": "homiio",
  "version": 1,
  "tools": [
    { "name": "apply_search", "description": "…", "inputSchema": { "type": "object", "…": "…" } }
  ],
  "outcomes": [
    { "toolCallId": "call_1", "outcome": "applied", "detail": "optional, ≤ 500 chars" }
  ]
}
```

These are the rules for host tools:

- **Naming.** `app` matches `^[a-z][a-z0-9-]{0,31}$`. A tool `name` matches `^[a-z][a-z0-9_]{0,47}$`. A request may declare at most 16 tools, and each `inputSchema` has an object root.
- **What the model sees.** The model sees each tool as `host_<app>__<name>`. Its description is prefixed with `[In the app on the person's screen]`.
- **Execution.** Executing a host tool on the server does nothing. Alia records the call and answers the model `{ "status": "dispatched" }`. It then emits:

  ```text
  event: alia.host_action
  data: {"eventVersion":1,"toolCallId":"call_1","app":"homiio","name":"apply_search","input":{…}}
  ```

- **Outcomes.** The client executes the action and sends the result in the NEXT request's `host.outcomes`. An outcome is one of `applied | inline | rejected | stale | failed`. Alia stores the outcome as that tool call's result, so the model reads what actually happened.
- **Where they never appear.** Host tools never reach a nested `consultAgent` turn, a voice turn or a channel turn (Telegram, WhatsApp), and they are never authority over data.
- **Editor lane.** `body.tools`, the editor lane, is unchanged and separate.

## 3. Tool results and renderers

`event: alia.tool_result` is unchanged:

```json
{"eventVersion":1,"tool_call_id":"…","name":"oxy_homiio__searchListings","output":{…}}
```

A surface registers renderers by `<app>:<tool>`, which is parsed from `oxy_<app>__<tool>` or `self_<app>__<tool>`. The key is never parsed from free text.

## 4. Consulting another agent

`consultAgent` streams. Its frames replace the retired single `alia.agent` frame:

```text
event: alia.agent_start   {"eventVersion":1,"consultId":"…","agent":{"id","name","handle","color","character"},"task":"…"}
event: alia.agent_delta   {"eventVersion":1,"consultId":"…","content":"…"}
event: alia.agent_tool    {"eventVersion":1,"consultId":"…","phase":"call"|"result","toolCallId":"…","name":"…","input"?:{…},"output"?:{…}}
event: alia.agent_end     {"eventVersion":1,"consultId":"…","status":"completed"|"failed","content"?:"…","error"?:{"code":"…"}}
```

When it shows these frames, the SDK does the following:

- On `agent_start`, the consulted agent joins the participants header with Bloom's avatar flight, from its reply to the header.
- Its reply is drawn under its own identity.
- `agent_tool` results go through the same renderers as the lead's results.

The stored conversation keeps one assistant message per consulted agent, carrying `agentInfo`, with the id `<assistantMessageId>-agent-<n>`, where `n` (0-based) is the order of its `alia.agent_start` in the turn. A client names the message it drew live the same way.

## 5. Feature gates

`GET /v1/agents/:id/features` answers:

```json
{ "features": [{ "key": "attachments.documents", "state": "available" | "locked", "remaining": 3 }] }
```

Alia asks the publishing app, through the gate's `checkTool` and under the person's ticket. A turn that carries a gated part (a document or an image) is checked, and spent through `consumeTool` when the feature has one, BEFORE any credit is reserved.

A refusal ends the stream with:

```json
{"error":{"code":"feature_entitlement_required","feature":"attachments.documents","retryable":false}}
```

The SDK calls the surface's `onFeatureLocked(key)`, and the surface shows its own upsell.

Documents are a content part:

```json
{ "type": "file", "file": { "file_id": "<Oxy Files id>", "filename": "contrato.pdf", "mime": "application/pdf" } }
```

## 6. Conversations and sharing

The conversation endpoints:

- **`GET /v1/conversations?agentId=<id>`** lists the person's conversations with that agent.
- **`POST /v1/conversations/:id/share { "ttlHours": 1..168 }`** answers `{ "token", "expiresAt" }`.
- **`DELETE /v1/conversations/:id/share`** revokes the share.
- **`GET /v1/shared/:token`** needs no auth and is `noindex`. It answers `{ "title", "agent"?, "messages": [{ "role", "content", "agent"? }], "expiresAt" }`. That covers text, images and agent identity; tool outputs are never included, because they can hold the person's own data.

## 7. Welcome suggestions

`POST /suggestions/welcome` accepts `{ "agentId"?, "clientContext"? }`. With an agent, the suggestions are that agent's.
