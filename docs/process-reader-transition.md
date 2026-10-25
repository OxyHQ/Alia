# Completed-source process transition and release prerequisite

Phase C source removes the finite A/A2/B readers, process secrets and API-first
deployment barriers. **Source preparation is not a live retirement receipt.**
Do not merge or deploy C until operations verifies the exact B API and integrations
images, healthy desired counts, zero old tasks, successful task reconciliation,
and workload-only HTTP/socket/event canaries. SSM deletion follows C's runtime
readback and the corresponding infra change; this release only removes references.

The sequence was additive readers A, enriched legacy provider metadata A2, then
workload producers B. B's gateway and frontend waited for the exact API release,
its arm64 digest and old-task drain. Those barriers are deleted now because both
B processes emit the final protocol. C must never deploy directly over A or A2.

## Final contract

- API-to-integrations calls require the exact live Alia API workload and canonical
  Alia audience. Account context is read only after that verification. The gateway
  checks connection/session rows and replaces client-supplied body owners.
- Integrations-to-API calls require the exact live integrations workload. The API
  resolves the actual bot provider identity or personal connected-session row.
  No raw account header, local channel context or workload creates a user session.
- Private Oxy tools require the live requester/session or durable task rooted in
  the original requester. Reconciliation validates existing stored proofs; it
  never creates authority from an account ID. Missing roots renew during a normal
  authenticated visit. Keep inspecting the unresolved-link counts.
- Both HTTP and socket readers reject the former process secrets, including when
  the previous secret value and provider/account metadata are correct.
- External Telegram webhook signatures and external OAuth credentials remain
  independently verified. Connector encryption keys are not process identity and
  remain in use.

The product-event receiver keeps shared live service verification, exact catalog
publisher ownership and deduplication. Its bounded old-workload acceptance is the
central Oxy fleet transition, not an Alia shared-secret fallback. That separate
fleet bridge is retired centrally after all product producers have migrated.

Run API process-reader HTTP tests, gateway HTTP/socket/ownership tests, complete
package suites, types and deployment-script checks before release. SDK22 consumers
wait for registry publication and verified B runtime; publication alone is not a
runtime readiness receipt.
