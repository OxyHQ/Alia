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
| Alia product API | `/alia/chat` and `/v1/*` are permanent assistant APIs. Console-issued machine-key admission is a separate implementation owned by the follow-up; this transport cleanup does not claim it. |

Mention's current catalog still advertises `/_oxy/capabilities/:tool`, alongside
the configured internal MCP route. Removing that receiver requires a coordinated
catalog/caller migration, not merely deleting the old-looking path. Likewise,
legacy SSE transports, persisted feed conversions and device cleanup guards
have independent client/data retirement conditions; no such evidence is created
by this change.

Source census: Alia main `7adb4856c` and Mention main `58801dd91`. These are source
reachability findings, not assertions about all production traffic or a new grant.
