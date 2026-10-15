# Oxy application authority and retained boundaries

Alia obtains catalog registrations and capability tickets through the published
`OxyServer.agency` methods. Direct and automation execution authorization creation
and retirement already use the same SDK. The control-plane service credential
is distinct from the requester's bearer; only a short-lived capability ticket
reaches the product handler. SDK authority calls do not retry and use its bounded
deadline. The local duplicate catalog/ticket transports are removed.

These remaining callers are active contracts, not unreachable compatibility code:

| Boundary | Current callers and reason to retain |
| --- | --- |
| Agent capability-map lookup | `automation-coordination.ts` calls `getOxyAgentCapabilityMap`, which POSTs requester/owner/actor identifiers to Oxy. The published agency namespace has no equivalent capability-map method. Removing it would erase assigned resource/limit checks. |
| Generic app HTTP invocation | `tool-pipeline.ts` builds tools from registered catalogs; non-Mention apps still use each catalog's advertised HTTP invocation. No replacement handler/catalog binding has been demonstrated for those apps. |
| Mention internal MCP | Only the explicit Mention pilot uses shared MCP, exact catalog provenance and independent requester/ticket authority. Failure never falls back to generic HTTP. |
| Automation coordination | `structured-automation-creation.ts`, `automation-coordination.ts` and `automation-authority.ts` create and use standing authority for background tasks. This is not interchangeable with a direct chat request. |
| Alia product API | `/alia/chat` and `/v1/*` are permanent assistant APIs. Console-issued app-only machine-key admission is implemented with published core4.4.0 and adopted by Alia#666. The positive Console issuance/chat/revocation journey remains pending; see [machine chat contract](./machine-chat-contract.md). |

Mention's current catalog still advertises `/_oxy/capabilities/:tool`, alongside
the configured internal MCP route. Removing that receiver requires a coordinated
catalog/caller migration, not merely deleting the old-looking path. Likewise,
legacy SSE transports, persisted feed conversions and device cleanup guards
have independent client/data retirement conditions; no such evidence is created
by this change.

Original source census: Alia main `7adb4856c` and Mention main `58801dd91`.
The retained boundaries were rechecked at Alia `425adadb` and Mention `fbc6663a`
for [Oxy#1571](https://github.com/OxyHQ/oxy/issues/1571). These are source
reachability findings, not assertions about all production traffic or a new grant.

## What the model sees of an Oxy tool, and when Oxy refuses the owner's map

- **The input schema is the capability's own.** `oxy_<app>__<tool>` exposes the
  `inputSchema` the app published in the Oxy registry, unchanged
  (`jsonSchema(definition.inputSchema)`), and validates every call with the
  validator the apps themselves use (`jsonObjectSchemaToZod` from `@oxy.so/mcp`)
  before issuing a ticket. A Zod rebuild of the schema (the former
  `jsonSchemaToZod`) dropped `minimum`/`maximum`, `maxLength`, `pattern` and
  `additionalProperties: false`, so the model sent `limit: 500` or its own keys
  to Noted's `searchNotes` and the app answered `capability_input_schema_mismatch`.
  A tool whose schema the validator cannot compile is skipped (logged), not the
  app. The schema is the one thing the model reads about arguments; do not
  re-describe it in code.
- **An agent's owner-apps map can be refused.** `POST /capabilities/capability-map`
  answers `403 requester_lacks_grant_owner_authority` when the requester has no
  `account:act_as` over the grant owner. Oxy gives an account authority over
  itself only when it is a personal account (`effectiveAccessForAccount`,
  OxyHQServices `account.service.ts`), so a turn whose person is a non-personal
  or archived account asks a question Oxy can only refuse, however correct "the
  owner is the one present" is on Alia's side. The Oxy load degrades by identity:
  the agent's own `self_*` tools and every other source still load, the owner's
  apps are replaced by the single `oxy_apps__status` tool, whose answer is the
  typed `oxy_app_unavailable`, and Oxy's reason stays in the log. The requester
  remains the owner and only the owner (`ownerIsPresent` in `tool-pipeline.ts`);
  Alia does not substitute another account to get past the refusal.
