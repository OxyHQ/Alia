# Embedding an agent: the wire contract

Alia ADR 0020 §5–§7. This is the contract between Alia's API and every surface that
opens a conversation through `@alia.onl/sdk` (21.0.0 and later): Homiio's "Ask
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

- **Naming.** `app` matches `^[a-z][a-z0-9-]{0,31}$`; it is the chat's app, which also labels a conversation the turn starts (§6). A tool `name` matches `^[a-z][a-z0-9_]{0,47}$`. A request may declare at most 16 tools, and each `inputSchema` has an object root.
- **What the model sees.** The model sees each tool as `host_<app>__<name>`. Its description is prefixed with `[In the app on the person's screen]`.
- **Execution.** Executing a host tool on the server does nothing. Alia records the call and answers the model `{ "status": "dispatched" }`. It then emits:

  ```text
  event: alia.host_action
  data: {"eventVersion":1,"toolCallId":"call_1","app":"homiio","name":"apply_search","input":{…}}
  ```

- **Outcomes.** The client executes the action and sends the result in the NEXT request's `host.outcomes`. An outcome is one of `applied | inline | rejected | stale | failed`. Alia stores the outcome as that tool call's result, so the model reads what actually happened.
- **Awaited results.** A tool declared with `"awaitsResult": true` is answered within the SAME turn instead (below).
- **Where they never appear.** Host tools never reach a nested `consultAgent` turn, a voice turn or a channel turn (Telegram, WhatsApp), and they are never authority over data.
- **Editor lane.** `body.tools`, the editor lane, is unchanged and separate.

### Host tools that answer within the turn (`awaitsResult`)

Some host tools exist to READ what only the client has: a browser's "this tab's text" or "my open tabs". The model needs that answer in the turn that asked, not the next one. Such a tool is declared with `"awaitsResult": true` (any other value, `false` included, is refused with `invalid_host`; omit the field for a dispatched tool):

```json
{ "name": "read_tab", "description": "…", "inputSchema": { "type": "object" }, "awaitsResult": true }
```

- **When it is admitted.** Only on a streamed request (`"stream": true`) that carries a `turnId` ([explicit Stop](./explicit-chat-stop.md)) from a person's own session. Any other request declaring one — no `turnId`, not streamed, a delegated service, a channel or an app-only credential — is refused `400` with `code: "invalid_host"` and `param: "host"`, before anything is reserved.
- **The action.** When the model calls it, Alia records the call in PostgreSQL first, then emits the usual frame with two more fields, and waits:

  ```text
  event: alia.host_action
  data: {"eventVersion":1,"toolCallId":"call_1","app":"astro","name":"read_tab","input":{},"awaitsResult":true,"turnId":"<the request's turnId>"}
  ```

- **The answer.** The client performs it and answers at once:

  ```text
  POST /v1/chat/turns/:turnId/host-results
  { "toolCallId": "call_1", "outcome": "applied", "detail": "optional, ≤ 500 chars", "result": "a string or any JSON value" }
  ```

  It is authenticated exactly as Stop is: the same session and verified `X-Oxy-App-Assertion`, bound to the same actor, account and app surface that started the turn, and rate-limited per that authority (60 a minute). `outcome` is one of `applied | inline | rejected | stale | failed`; `result` is optional and at most 100,000 characters as JSON (`HOST_RESULT_MAX_CHARS`). Answers:

  | Status | `error.code` | When |
  |---|---|---|
  | `200` `{ "turnId", "toolCallId", "state": "answered" }` | — | recorded |
  | `400` | `invalid_turn` | `:turnId` is not a UUID v4 |
  | `400` | `invalid_host_result` (`param` names the field) | an unknown field, a missing `toolCallId`, an outcome outside the list, a `detail` over 500 characters |
  | `400` | `host_result_too_large` (`param: "result"`) | `result` over the bound |
  | `403` | `turn_control_unsupported` | a caller with no verifiable original actor |
  | `404` | `host_result_not_found` | a call this turn never awaited, another authority's turn, or a call no longer awaited (already read, timed out or stopped) |
  | `409` | `host_result_already_answered` | a second answer while the first is still unread |
  | `429` | `RATE_LIMIT_EXCEEDED` | over the limit, with `Retry-After` |
  | `503` | `turn_control_unavailable` | the control store could not be reached |

- **What the model reads.** `{ "status": <outcome>, "detail"?, "result"? }` as that call's result, bounded like any tool result. The stored conversation keeps the same result for the call, so a reloaded conversation shows what the tool returned. Such a call never needs a later `host.outcomes` entry.
- **The deadline.** The turn waits at most 45 seconds (`HOST_RESULT_WAIT_MS`), well inside its 80-second limit; the inactivity watchdog is held while it waits, as for any running tool. Unanswered, the model reads `{ "status": "stale", "detail": "The app did not answer in time." }`. Stop (or the turn's end) ends the wait at once.
- **Across replicas.** The answer can land on any replica. PostgreSQL is the only store (`chat_host_results`, keyed by turn id and tool call id): the replica whose turn waits reads every answer its process waits for in one batch every 250 ms, as Stop's observer does, and deletes each row in the statement that reads it. A row whose wait ended unanswered is deleted then; one left by a crashed replica is removed by the expiry sweep after 24 hours.
- **The person's content.** What the client sends (a page's text) is the person's own. It is held only until the waiting turn reads it, never logged (the route logs the outcome and the result's size, never its content), and goes to the model like any tool result.

#### Rollout

The API receiver ships first: migration `0109_chat_host_results` (pre-deploy, additive), the route and the waiter. Only after every API replica runs it may a host declare `awaitsResult`: an older API's strict schema refuses the unknown field with `invalid_host`, and an older replica would not know the route. `@alia.onl/sdk` 22.2.0 sends `awaitsResult` only for a tool that declares it, so existing hosts send the same bytes and are unaffected by the order. The SDK answers through the authenticated API layer with the app assertion, at most once per tool call, reports a failed answer to `AliaHostTools.onUndelivered` and never retries it; a result over the bound is answered as `failed` instead.

### Personalization off for one turn

`"personalization": false` on `POST /v1/chat/completions` (and `/alia/chat`, the same handler) turns personalization off for that turn: Alia reads no memory profile of the person and recalls no memories, an agent reads none of its own memory of them, the model is offered no memory tools (`saveUserMemory`, `updateUserMemory`, `forgetUserMemory`, `updateUserPreferences`, `updateUserContext`, an agent's `memory` and `searchThread`), and nothing is learned from the turn (writing style, proactive suggestions). The conversation is stored as usual. Absent or `true` changes nothing; any other value is refused `400` with `param: "personalization"`. The SDK sends it from `AliaTurnRequest.personalization` (`host.turnRequest()`), only when `false`.

## 3. Tool results and renderers

`event: alia.tool_result` is unchanged:

```json
{"eventVersion":1,"tool_call_id":"…","name":"oxy_homiio__searchListings","output":{…}}
```

A surface registers renderers by `<app>:<tool>`, which is parsed from `oxy_<app>__<tool>` or `self_<app>__<tool>`. The key is never parsed from free text. `parseCatalogueTool` and `toolRendererKey` read it, from the pure `@alia.onl/sdk/tools` entry as well as the main one, so a host that draws a conversation itself can tell its catalogue's results apart without loading React Native.

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

The app's two tools are called with no input, on the binding the agent's `oxy_*` tools use for the person present (the verified original requester's account, without app grants or ceilings):

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
- **What the model receives.** An image file is an image. A text file (`text/*`, JSON, XML) is its text. A Word, PowerPoint or Excel file (`.docx`, `.pptx`, `.xlsx`, their templates and macro-enabled siblings; not the legacy binary `.doc`, `.ppt`, `.xls`) is its text, for every model:
  - Word: the body's paragraphs and tables in order, a table row per line with its cells separated by ` | `.
  - PowerPoint: `Slide N` and the slide's text in presentation order, then its speaker notes under `Notes:`.
  - Excel: `Sheet: <name>` and the sheet's rows as CSV, with the values the file stores (a formula's last result, numbers as stored, so a date is its serial number).

  A PDF is the file itself for a model whose catalogue entry takes `file` input, and its text, extracted by Alia, for any other model, a power level included. A PDF with no text (a scan) gives that other model its first pages as PNG images instead, after a line naming them (`pages 1-3 of 12`), so the model reads the scan with its own vision. Any other type is the file itself for a model that takes files, and refused otherwise.
- **Scanned pages need Oxy to serve images.** Oxy's inference edge does not serve image input yet (`unsupported_modality`), and Alia fits every request to Oxy's 126,976-byte controlled-input budget, which counts an image's base64 like text (`lib/inference/request-budget.ts`). Until Oxy serves and meters images, a turn carrying scanned pages fails with one of those typed errors (`context_length_exceeded` for any page larger than the room left), exactly as a turn with an image attachment does; it is never answered as if the scan had been read.
- **Limits.** At most 10 distinct files in a request, history included, 20 MiB each, and 100,000 characters of text per document. An Office file may inflate at most 64 MiB of XML. A scan contributes at most its first 8 pages, each at most 1,280 px on its long side, grey when the scan is grey, and at most 480 KiB of PNG in all, so that it fits Oxy's 768 KiB request; the pages past that are left out and the line says which pages the model has.
- **Refusals.** The turn is refused, before anything is reserved, with `invalid_file_part`, `too_many_files`, `file_unavailable`, `file_too_large`, `file_type_unsupported` or `file_session_required` (HTTP 400). A turn about a document Alia could not read is never answered.
- **What is stored.** The conversation keeps the part as the client sent it. The file's bytes, text and page images are never stored; what was read is kept in memory for ten minutes, per person and file, because the client resends the history every turn.

## 6. Conversations and sharing

The conversation endpoints:

- **`GET /v1/conversations?agentId=<id>&app=<slug>`** lists the person's conversations, narrowed to one agent, one app or both. Without either it lists all of them, which is what the Alia app shows.
- **`POST /v1/conversations/:id/share { "ttlHours": 1..168 }`** answers `{ "token", "expiresAt" }`.
- **`DELETE /v1/conversations/:id/share`** revokes the share.
- **The link is Alia's.** Every app shares `https://alia.onl/shared/<token>` (the SDK's `aliaSharedConversationUrl`, and `url` on what `useShareConversation().share` returns), a public page of the Alia web app that draws the conversation with the SDK's `AliaSharedConversation` and answers `X-Robots-Tag: noindex`. An app keeps no shared page of its own; one that minted links to its own address before redirects them there.
- **`GET /v1/shared/:token`** needs no auth and is `noindex`. It answers `{ "title", "agent"?, "messages": [{ "role", "content", "agent"?, "artifacts"? }], "expiresAt" }`. That covers text, images, agent identity and the conversation's canvas artifacts; no other tool output is included, because it can hold the person's own data (`lib/shared-conversation.ts` is an allow-list).
- **Artifacts are shared with the chat (owner, 2026-10-27).** A shared conversation shows the reports, decks, dashboards, charts and tables Alia drew in it, because the artifact is usually what the person is sharing. An assistant message carries them as `artifacts: [{ "id", "type", "title", "data" }]`: only the `canvas` tool's finished result, one entry per call in call order, `id` being the tool call. Never the call's arguments, a refused call (`{ error }`), or any other tool's result — `generateFile`, email, files, Oxy apps (`oxy_*`), connected apps and MCP servers, page text or host tools (`host_*`). They live behind the same token, expiry and revocation as the words: a revoked or expired link answers the same `404` with nothing in it. `AliaSharedConversation` draws each artifact inline under its reply (there is no canvas panel on the shared page). This replaces the rule of 2026-10-16 that a link never carried any tool output.

### The app a conversation started in

A conversation records the Oxy app it started in (`app` on every conversation, `null` for Alia's own surfaces), so an embedding app can list only its own — Mercaria's "Keep shopping", Homiio's chats — while the Alia app keeps showing all of them.

- **Who sets it.** The embedding app names itself once, on the chat (the SDK's `app` prop). Every turn carries it as `host.app` (with `tools: []` when the app declares no host tools), and `POST /v1/conversations/new` and `POST /v1/conversations` carry it as `app`. It is written ONCE, when that request creates the conversation; a later request naming another app never relabels it.
- **What it is.** A slug, `^[a-z][a-z0-9-]{0,31}$` — the same name the app's host tools carry. Anything else is refused with 400, on writes and on `?app=`.
- **What it is not: authority.** The label is the embedding client's own declaration, not the verified app assertion (`X-Oxy-App-Assertion`, ADR 0021). It only narrows the person's own list, so a client that mislabels a conversation mislabels it for the one person who could already read, rename and delete it. The assertion names an Oxy application id rather than a slug, and a native build carries one only once its platform attestation is configured; a label that existed only where an assertion verified would leave the same app's conversations unlabelled on its phones. No reach, gate, tool or bill reads the label, and none may: which app a request comes from is proven by the assertion alone.
- **Listing.** An app that wants only its own conversations asks for them: `useConversations({ app: 'mercaria' })`. The one list the SDK draws itself, the sheet's recent conversations under its greeting, is the sheet's app's: Mercaria's sheet offers Mercaria's, Alia's own sheet offers any.

## 7. Welcome suggestions

`POST /suggestions/welcome` accepts `{ "agentId"?, "clientContext"? }`. With an agent, the suggestions are that agent's.

- **With `agentId`.** The answer is the agent's starters, in the shape of the other suggestions (`suggestionId` is `agent:<agentId>:<n>`). An agent the caller cannot reach is a 404.
- **Without `agentId`.** The answer is Alia's welcome pool, with the suggestions whose tags or category `clientContext` mentions first. `clientContext` is the text the embedding app says the person is looking at; only its first 4 KB is read.
