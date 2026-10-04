# Canonical requester authority transport

Source `0dcbade0e`, based on current main `3904331b4`. Alia now creates and retires both direct and automation authorizations through published `OxyServer.agency`. The old app-local POST/DELETE implementation and transport selector are removed. Requester bearer, coordinator identity, autonomy, resource, expiration and limits remain explicit. The SDK enforces a five-second deadline and disables retries; retirement still treats an absent authorization as already retired.

The owned loopback fixture uses the actual installed SDK, not the repository's verifier stub. It verifies direct/automation bodies, requester/service bearer separation, 401/403/503 without replay, encoded retirement IDs, missing-row retirement and refusal of mixed terms. Four focal suites passed 42 tests. The API full suite passed 2,030 tests in 192 suites with one existing omission; typecheck, focused lint and API build passed. The initial full run failed eight FFmpeg tests because dependency install scripts had been omitted. Running the dependency's canonical install script supplied the binary; the full run then passed. Those setup logs are preserved.

## Callers and boundaries retained

- `automation-authority.ts` provisions named automations for agents and standing tasks. It uses the same SDK union as direct authorization; it is not obsolete functionality. Partial-provision cleanup remains tested.
- `tools/oxy-services.ts` creates short-lived direct authorizations for chat/task tool runs and preserves acknowledged MCP results when retirement fails. The MCP retirement regression suite remains green.
- Generic catalog lookup, capability-map lookup and ticket issuance still have active callers from `tool-pipeline.ts`, `system-prompt-builder.ts`, `structured-automation-creation.ts` and `automation-coordination.ts`. Only Mention has the reviewed exact internal MCP catalog binding. No generic HTTP invocation is deleted before another app's equivalent canonical catalog/handler exists.
- Mention main `83459d4a9` still publishes `/_oxy/capabilities/:tool` in its catalog. The receiver is mounted; replacing its catalog requires a new exact catalog binding and coordinated rollout, not a reachability assumption. Mention's call to Oxy `/_oxy/capabilities/profiles/recommendations` is a different app capability.
- Alia `/alia/chat` and `/v1/*` are permanent product routes. They are not generic-inference endpoints to retire under this cleanup. Raw Console application-key support is a separate unresolved product contract, not implemented here.

No SDK sources, package versions, lockfiles, workload identity, grants or live configuration changed. This evidence does not claim production invocation or removal of every remaining capability compatibility boundary. Hashes and raw local test results are in [proof.json](proof.json).
