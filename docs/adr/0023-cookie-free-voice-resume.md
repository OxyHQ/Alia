# 23. Voice reconnects through its owner without browser cookies

Status: accepted for implementation; deployment and cookie removal remain separate gates.
Date: 2026-10-26.

This amends ADR 0017's ALB cookie affinity requirement. The ecosystem's zero-cookie
contract also applies to infrastructure cookies. A real Mention acceptance test
observed `AWSALBCORS` on `api.alia.onl`; the target group's duration-based affinity
also attaches `AWSALB`/`AWSALBCORS` to ordinary HTTP responses.

A live WebSocket already stays on its serving task. Only reconnection needs
routing. The call and its Kaana connection remain in that task's memory: we do
not serialize speech, credentials, replay buffers, tool state or provider sockets.

## Routing and authority

Before exposing `session.accepted`, the owner publishes an ephemeral Redis mapping
from the existing `vs_` id to the verified account, its private container IPv4,
an opaque process generation, and a hard expiry. A 45-second lease renews every
10 seconds, only while the original value still owns the key. Expired/replaced
leases are never recreated by renewal. Call completion removes only its own
value. The hard deadline is 31 minutes; none of this extends the call's 30-minute
maximum or its existing 30-second disconnected resume window.

The directory is server-owned under the existing shared Redis trust boundary.
No client endpoint can write a route, address or generation: a newly opened call
registers its server-generated session id with the verified account and the
current container's metadata. The opaque generation prevents accidental reuse
of a task IP; it is **not cryptographic receiver authentication** and does not
protect against a compromised Redis writer. This change does not expand that
trust boundary into a new mutual-authentication or per-hop ECS lookup protocol.

An entry is routing metadata, not authority. A reconnect first passes the existing
shared Oxy session verification. A different account cannot resolve the entry.
The public URL and all public auth/session frames stay unchanged. A task that
does not hold the call makes one private WebSocket hop to the recorded owner.

The destination comes only from the server-owned directory. The owner discovers
its own `awsvpc` address from the fixed ECS v4 metadata endpoint; peers admit only
the deployment's exact VPC CIDR and the API's configured listening port. No client
URL, arbitrary private address/port, DNS redirect or cookie participates.

The private fixed `/internal/voice/relay` upgrade rejects forwarded public traffic,
foreign network addresses and a Host other than its own private listener. Its
bounded initial greeting contains only an opaque generation. The connector checks
that generation before sending any bearer, protecting against stale addresses
reassigned to another process. The peer then verifies the exact Alia API workload
through shared Oxy live introspection, followed by the original person's auth and
resume through the normal voice handler. Verification consumes no grant or spend.
This handler can only resume a local call: it cannot start a call or relay again.

Owner loss, an expired directory entry, a different account, a refused workload,
or an unavailable replay buffer produces the existing `resume-unavailable`.
No second admission, provider connection, reservation or settlement is created.
Frame sizes, pending bytes and handshake time are bounded. Closing either side
closes the relay; the owner applies its existing disconnect grace period.

## Delivery

1. Provision the exact VPC configuration and private peer ingress on the actual
   Alia port **3001**. The older shared port-3000 rule does not permit this hop.
   Keep ALB affinity enabled in this preparation phase.
2. Deploy routing-capable Alia and the separately implemented Kaana peer routing;
   verify exact running images and a two-task resume with the same account and
   one admission/settlement. Current Alia-to-Kaana reconnects must also work.
3. Drain pre-directory owners/calls, or prove every remaining live owner registered
   its session. The conservative bound is 30 minutes plus resume grace for Alia
   and Kaana's maximum session duration plus its grace, after the last old owner.
4. Only then remove both products' ALB cookie affinity through reviewed Terraform.
   Verify ordinary HTTP and browser/native reconnects without `Set-Cookie` or
   retained cookies. A green local test does not establish this production state.

Rollback before cookie removal may use the old image. After removal, the rollback
floor is the compatible relay image for each service; an older process cannot
reliably resume a call routed to another task. Historical task definitions are
not certified rollback targets merely because they still exist.

Real-wire two-node tests cover account isolation, replay/audio, owner generation
changes, unavailable owners, invalid peer workloads, and forwarded public ingress.
The directory's lease ownership and expiration are exercised against real Redis.
