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

- `greeting` is the agent's tagline, the one line its owner writes in the editor.
- `starters` are the owner's, set with `PATCH /agents/:id` (`starters`, at most 6).
- `features` lists every Alia feature an owner can gate (§5) and whether this agent gates it.
- Missing, private, and not confirmable because Oxy could not be asked are all the same
  404. The system prompt is never in the answer.

### Which app the conversation is in (ADR 0021)

An Oxy application may confine its own agent to its own app (Oxy ADR 0044). Every
request the SDK sends that can open an agent — the REST routes above and in §6, the chat
stream, the voice socket — carries the host's Oxy-signed app assertion as
`X-Oxy-App-Assertion` (Oxy ADR 0045; `@alia.onl/sdk` 19.1.0 and later). On the voice
socket it is `appAssertion` in the `auth` frame. Alia verifies it against Oxy's JWKS,
bound to the request's own person and session, and `canReachAgent` refuses a confined
agent unless the assertion names one of its applications. Without a valid assertion
there is no app: every unconfined agent opens as before, and no confined one does.

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
event: alia.agent_end     {"eventVersion":1,"consultId":"…","status":"completed"|"failed","content"?:"…","error"?:{"code":"…","feature"?:"…"}}
```

When it shows these frames, the SDK does the following:

- On `agent_start`, the consulted agent joins the participants header with Bloom's avatar flight, from its reply to the header.
- Its reply is drawn under its own identity.
- `agent_tool` results go through the same renderers as the lead's results.

The stored conversation keeps one assistant message per consulted agent, carrying `agentInfo`, with the id `<assistantMessageId>-agent-<n>`, where `n` (0-based) is the order of its `alia.agent_start` in the turn. A client names the message it drew live the same way.

## 5. Feature gates

An agent's owner can put these Alia features behind a feature an app declares in its capability catalogue (`agents.feature_gates`, `{ "<key>": { "app", "feature" } }`, checked against the app's live catalogue when it is saved):

| Key | What a turn uses |
|---|---|
| `attachments.documents` | a `file` part in any user message |
| `attachments.images` | an `image_url` part in any user message |
| `deep_research` | the request's `deepResearch: true` |
| `power_level.pro`, `power_level.ultra` | the request's `model` naming that level |

Only `pro` and `ultra` can be gated, because they are the levels a turn reaches only by naming them. `auto`, which every request that names nothing runs on, climbs on its own through `instant`, `medium`, `high` and `xhigh` but never chooses `pro` or `ultra`. A gate on `auto` would gate the agent itself (that is `access`), and a gate on a level `auto` reaches would be walked around by not choosing a level. The other level keys are refused with a 400.

Two rules keep these gates from being walked around:

- **An exact model.** On an agent that gates a power level, a request naming a hosted model exactly (`publisher/model`) is refused with `400 power_level_required` (`param: "model"`). Alia does not know an exact model's level, so allowing it would bypass the gate. A model on the person's own device (`local/…`) is not gated.
- **The deep research tool.** An agent that gates `deep_research` never offers the model the `deepResearch` tool. The gate is checked and spent before credits are reserved, and a tool call happens after, so on such an agent deep research is the request flag alone.

A power level the agent's OWNER pinned (its `modelId`, used when it is consulted) is the owner's configuration, not the person's choice, and is not gated.

`GET /v1/agents/:id/features` answers:

```json
{ "features": [{ "key": "attachments.documents", "state": "available" | "locked", "remaining": 3 }] }
```

Alia asks the publishing app, through the gate's `checkTool` and under the person's ticket. A turn that uses a gated feature is checked, and spent through `consumeTool` when the feature has one, BEFORE any credit is reserved.

The app's two tools are called with no input, on the binding the agent's `oxy_*` tools use for the person present (the owner's levels, or the owner's ceilings for anybody else):

- `checkTool` answers `{ "available": boolean, "remaining"?: integer }`.
- `consumeTool` answers `{ "consumed": boolean, "remaining"?: integer }`, idempotently under the `Idempotency-Key` Alia sends.

On a turn, the order is fixed: check, then read the documents, then spend each gated use, then reserve credits. Each use is spent once:

- A part is spent under `sha256(turnId + partHash)`, where `turnId` is the id of the user message that carries it. A retried turn, and the same message resent as history, spend nothing new. The history's parts are gated too, because the history is the client's to send.
- `deep_research` and `power_level.*` belong to this turn only. They are spent under `sha256(turnId + key)`, where `turnId` is the id of the last user message, so a retry spends nothing new and the next turn spends again.

A refusal ends the stream with the feature's key:

```json
{"error":{"code":"feature_entitlement_required","feature":"attachments.documents","retryable":false}}
```

`param` names what to change: `messages` for an attachment, `deepResearch`, or `model` for a power level.

The same body is the JSON answer (HTTP 403) when the stream is not open. An app that could not answer, or answered something else, is `feature_check_unavailable` (`retryable: true`, HTTP 503), never read as either verdict. `GET /v1/agents/:id/features` answers 503 with that code for the same reason.

The SDK calls the surface's `onFeatureLocked(key)`, and the surface shows its own upsell.

**A consultation applies the CONSULTED agent's gates.** When Alia (or any agent) consults an agent with `consultAgent` (§4), the consulted agent's gates are checked, and spent, against every attachment the outer turn carries, on the person's lane, before the nested turn reserves anything. The nested turn receives no parts, but the lead can hand it any of them as text, and Alia cannot tell which it will. The spend key is the attachment's own, so an attachment already spent for the same app feature is not spent again. A refusal does not end the outer turn: the consultation ends with `alia.agent_end` `{ "status": "failed", "error": { "code": "feature_entitlement_required", "feature": "attachments.documents" } }`, the lead is told the person needs the upgrade, and the surface can show its upsell. Gated parts are not refused outright in a consultation, because that would lock out a person who IS entitled; the gate sells the feature, it does not forbid the path. The consulted agent's own deep research and power level are its owner's configuration, so they are not gated there.

Documents are a content part:

```json
{ "type": "file", "file": { "file_id": "<Oxy Files id>", "filename": "contrato.pdf", "mime": "application/pdf" } }
```

These are the rules for documents:

- **Where the file lives.** The client uploads it to the person's own Oxy account (`oxy.assets.upload`) and sends its id. Alia reads it with the person's own session, so a file the person cannot read is refused. `filename` and `mime` are hints: Oxy's record of the file decides.
- **What the model receives.** An image file is an image. A text file (`text/*`, JSON, XML) is its text. A PDF is the file itself for a model whose catalogue entry takes `file` input, and its text, extracted by Alia, for any other model, a power level included. Any other type is the file itself for a model that takes files, and refused otherwise.
- **Limits.** At most 10 distinct files in a request, history included, 20 MiB each, and 100,000 characters of text per document.
- **Refusals.** The turn is refused, before anything is reserved, with `invalid_file_part`, `too_many_files`, `file_unavailable`, `file_too_large`, `file_type_unsupported` or `file_session_required` (HTTP 400). A turn about a document Alia could not read is never answered.
- **What is stored.** The conversation keeps the part as the client sent it. The file's bytes and text are never stored.

## 6. Conversations and sharing

The conversation endpoints:

- **`GET /v1/conversations?agentId=<id>`** lists the person's conversations with that agent.
- **`POST /v1/conversations/:id/share { "ttlHours": 1..168 }`** answers `{ "token", "expiresAt" }`.
- **`DELETE /v1/conversations/:id/share`** revokes the share.
- **`GET /v1/shared/:token`** needs no auth and is `noindex`. It answers `{ "title", "agent"?, "messages": [{ "role", "content", "agent"? }], "expiresAt" }`. That covers text, images and agent identity; tool outputs are never included, because they can hold the person's own data.

The sharing rules:

- **One link per conversation.** Sharing again replaces the link, and the previous token stops working. Deleting the conversation revokes its link.
- **The token is shown once.** Alia stores only its SHA-256, so a lost token is replaced by sharing again.
- **What a reader sees.** `content` is a string, or parts of `{ "type": "text" }` and `{ "type": "image_url" }`. Documents, reasoning, tool calls and their results, and the system prompt are left out. `agent` is the conversation's agent: `{ "id", "name", "handle", "color", "character" }`.
- **Failures.** An unknown, expired or revoked token is the same 404. A link is limited to 60 reads a minute (429 with `Retry-After`).

## 7. Welcome suggestions

`POST /suggestions/welcome` accepts `{ "agentId"?, "clientContext"? }`. With an agent, the suggestions are that agent's.

- **With `agentId`.** The answer is the agent's starters, in the shape of the other suggestions (`suggestionId` is `agent:<agentId>:<n>`). An agent the caller cannot reach is a 404.
- **Without `agentId`.** The answer is Alia's welcome pool, with the suggestions whose tags or category `clientContext` mentions first. `clientContext` is the text the embedding app says the person is looking at; only its first 4 KB is read.
