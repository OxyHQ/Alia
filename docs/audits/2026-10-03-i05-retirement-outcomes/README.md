# Internal MCP outcome and temporary-approval retirement

A successful Mention MCP result used to be replaced by `oxy_app_unavailable`
when the subsequent DELETE of its temporary approval failed. The HTTP fixture
reproduced this after one acknowledged effect. A second fixture committed an
effect and destroyed its response, reproducing an actually unknown outcome.
The initial run had 12 passing and 2 failing tests; no duplicate financial effect
or production failure is claimed.

Successful MCP calls whose retirement succeeds retain the existing domain-result
shape. If retirement fails after an acknowledged result, the tool returns an
explicit envelope: `status: succeeded`, the unchanged domain body in `result`,
`operation: { id, runId, tool }`, and `retirement: { status: pending, retryTool }`.
The agent must report the recognized result and retry only retirement, never
interpret that envelope as a failed domain operation. Current consumers pass
these tool results through the AI tool protocol; no public HTTP DTO is changed.

`oxy_mention__retireApproval` accepts only an operation ID in this toolset's
private retirement map. That map contains the exact temporary authorization
created by this run, without bearer/ticket storage. The tool uses the original
requester context and invokes only canonical DELETE. It cannot mint authority,
issue tickets, call MCP, accept an arbitrary authorization ID/URL, or fall back
to the legacy HTTP domain route. Repeated retirement failures preserve the
recognized result; successful retirement does not reexecute the domain action.
An operation repeated while this record exists is returned without execution;
a changed payload under the same operation identity is rejected. The identity
includes run, resource/tool and tool-call ID (or input when no call ID exists).

Ticket refusal before dispatch remains `not_executed` / `oxy_app_unavailable`.
A transport failure after dispatch remains `unknown` / `oxy_app_result_unknown`,
including after successful retirement. MCP-declared errors remain unsuccessful.
Standing approvals are never revoked by this cleanup; an outcome without a
temporary approval reports retirement `not_required`. Catalogue provenance,
requester bearer/ticket separation and the Mention-only opt-in remain intact.

The map lives for this toolset only. It is not a durable scheduler or a claim of
recovery after process loss. Temporary approval expiry remains the existing two
minutes; no extension or new standing grant is introduced. Unknown outcomes
still require reconciliation before a new domain operation, and this change
does not manufacture evidence resolving an unknown response.

Validation: installed candidate MCP and SDK over actual loopback HTTP, explicit
synthetic remote authority/effect storage; no provider or production mutations.
The focused tests cover known success, repeated cleanup failures, cleanup-only
retry, foreign-run/unknown-ID refusal, conflicting input, prior ticket refusal
and a response lost after an effect. The suite checks zero legacy fallback and
no bearer leakage in logs. Full API passed 2022 tests with one existing omitted
test/file; package lint has zero errors and 413 existing warnings, while both
changed source files pass `--max-warnings=0`. Types/build pass. Full validation
preceded only the final response-label clarification for standing authority;
final focals cover the final source. Candidate dependencies remain the historical
1b505 tarballs, not final registry adoption. The removed unused type import fixes
the specific CI lint error reported on PR662; that prior failed CI is not relabelled.
