# Explicit Stop for foreground chat

This API receiver prepares authenticated turn cancellation for the subsequent
UI SDK 22.1 and server SDK 1.3 release. Those producers ship only after all API
replicas are verified on the receiver. Closing a sheet, losing the HTTP
connection, switching accounts, or unmounting a view still detaches the reader;
these events do not cancel durable work. The **Stop** button sends a separate
control request and closes its stream only after acknowledgement.

## Wire and authority

`POST /v1/chat/completions` accepts optional `turnId`, a UUID v4 generated before
asynchronous preparation. Reuse it for transport retries of that same turn;
create a new id for an intentional new generation. Existing callers that omit it
retain their previous behavior.

`POST /v1/chat/turns/:turnId/cancel` takes JSON `{ conversationId?: string }` and
the same authentication and verified `X-Oxy-App-Assertion` as admission. Use the
conversation id known when constructing the original request, including its
absence for a new conversation. The prepared server SDK exposes typed `turnId` and `cancelTurn()` using its existing
transport. The prepared UI SDK runtime exports `createChatTurnControl`
and `AliaChatTurnControl` for hosts with their own Stop control; the shared chat
UI uses this same implementation. `stop()` acknowledges remote cancellation;
`finish()` releases the linked transport. Aborting the stream alone is detach.

Human control is bound to the verified original actor, effective account and
application surface. App-only control is bound to the exact verified application,
credential and environment. Sharing a billing owner grants no cancellation
rights. Delegated service/channel callers with no verifiable original actor
receive `turn_control_unsupported` when supplying a turn id; their existing
requests without one are unchanged. No opaque requester context is decoded.

An early Stop records a tombstone, preventing later admission of that turn.
Duplicate Stops are idempotent; a different authority or initial conversation
gets 404. A duplicate admission gets 409 and cannot start another provider call.
After the finalization CAS, Stop returns `finishing` or the terminal state: it
cannot undo an answer already committed. The SDK never sends an old turn's Stop
under a newly selected account, including while preparing its surface proof.

## Execution and recovery

PostgreSQL is the sole control authority. Every process reads its active ids in
one batch every 250 ms. A failed or hung control check aborts the local operation
within a 2-second check deadline; database statements have a shorter timeout.
The existing 80-second HTTP execution limit remains. Observers are removed when
the operation finishes. The existing expiry worker deletes control rows after
24 hours; this is a bounded retry window, not permanent execution history.

Explicit cancellation reaches the existing AbortSignal chain through the main
provider loop and all four research model stages. Foreground linked-agent turns
use their existing coordinator failure path. Stop does not reverse completed
tool actions or cancel separately created background tasks; those retain their
own task controls. Ordinary transport disconnect continues in the background.

Each controlled hosted inference attempt records its idempotency key before
HTTP dispatch. An interruption before response metadata can therefore recover
usage through Core 7.5's existing Oxy generation-record endpoint. Alia verifies
application, effective account, environment, terminal receipt and measured token
units. A provider-reported empty cancelled/failed/partial record can establish
zero usage; an estimated or missing record cannot. A 404 never means zero.

The existing immutable `credit_operations` ledger and captured price book remain
the financial authority. Dispatch intents and one-to-one retry metadata add no
second balance. The captured price book and pricing formula are unchanged. The shared token
projection now includes disjoint cache/reasoning units in normal and recovered
input/output totals, fixing their previous omission. Controlled research
uses its measured helper receipts on success as well as interruption; the legacy
no-turn-id research path keeps its existing policy. Recovery
sums the disjoint input/cache and output/reasoning units from measured attempts
and uses the existing final served-model pricing rule;
its terminal CAS permits only one settlement even with two workers. Known
pre-dispatch aborts can release their reservation. Unknown dispatch outcomes
cannot.

The leader's worker checks at most five due operations every 30 seconds, with a
5-second lookup deadline per operation and exponential retry delay capped at five
minutes. An owner crash leaves a durable recovery request due after two minutes.
After 32 unsuccessful attempts the operation remains admitted for review and
automatic retries stop; no usage or refund is invented. A crash after recording
an intent but before dispatch can leave a persistent 404 in this review state.
Terminal scheduling metadata is disabled, including after a crash between the
financial commit and queue cleanup; intents and financial history are retained.

A bounded operator inspection can identify unresolved work without exposing
prompts or credentials:

```sql
SELECT r.operation_id, r.attempts, r.next_attempt_at, o.status
FROM credit_reconciliations r
JOIN credit_operations o ON o.id = r.operation_id
WHERE o.status = 'admitted' AND r.attempts >= 32
ORDER BY o.captured_at
LIMIT 100;
```

Review the original caller's authoritative Oxy records before re-enabling a
retry. Do not modify immutable financial amounts, replay generation, or refund
on missing metadata.

## Rollout and evidence

Deploy the additive migration and API receiver before publishing/adopting UI SDK
22.1 or server SDK 1.3 in product apps. The API uses published Core 7.5.0; no local tarball paths
belong in manifests. During rolling deployment, wait until every API replica has
the receiver before shipping the new Stop producer.

Automated coverage includes real PostgreSQL admission races and financial CAS,
a real Bun HTTP fixture with two independent replica observers and the published
Oxy transport, SDK HTTP acknowledgement/account-switch behavior, and research
signal propagation. The Bun fixture supplies trusted test principal projections;
it does not claim to exercise production sign-in or the full chat UI. Live
provider cancellation and partial usage settlement require a bounded retest after
the reviewed source is deployed. No new production generation is part of these
local tests.


### Desktop adoption

Codea's webview Stop and native chat panel Stop, and Cowork's Stop, use the
server SDK lifecycle helper over their existing Oxy linked transport. Each HTTP
request in a local tool loop has a fresh cancellation ID; stopping between local
tools prevents further rounds and does not undo an action that already ran.
A failed acknowledgement is reported without claiming the generation stopped.
Account changes, view teardown and Codea inline-suggestion invalidation only
detach. Typing a character is not treated as an explicit chat Stop command.

These consumers do not calculate or refund credits. The receiver's measured
reconciliation remains authoritative, and their HTTP fixtures establish request
identity, acknowledgement and account fencing rather than live financial
settlement. Codea 1.0.9 and Cowork 1.0.2 require the receiver rollout and server
SDK 1.3 release before distribution; see the separate desktop artifact steps in
[deployment](./deployment.md#codea-and-cowork-desktop-artifacts).
