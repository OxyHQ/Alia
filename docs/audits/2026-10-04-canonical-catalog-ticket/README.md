# Canonical catalog and ticket authority

Source `3c8728129`, based on Alia main `7adb4856c`, removes two duplicate local
control-plane requests. All app catalog discovery and ticket issuance now use
published `OxyServer.agency`. The exact Mention MCP binding remains required;
other apps retain their advertised product HTTP invocation and agent capability
maps retain their separate active contract.

An owned loopback authority/product fixture uses the actual installed SDK. It
verifies one canonical catalog GET and ticket POST, separate service/requester/
capability credentials, and 401/403/503 without replay or app effects. A failed
ticket retires only the already-created approval. Non-loopback requests are
refused by the test transport. The same fixture against the baseline fails the
canonical method assertion; this characterizes the removed local transport,
not a previously observed security bypass.

Validation: 43 focal controls in four suites, 2,037 full API tests in 193 suites,
one existing skipped suite/test, canonical API build and typecheck pass. Three
initial test-only lint warnings were removed; final focused controls and strict
zero-warning lint pass. The full suite predates only those non-semantic fixture
changes. Core 4.2.0's 581 installed members match the root-verified public archive.
Manifests and lockfile are unchanged. No grants, product routes or live runtime
were changed.

[Proof](./proof.json) preserves logs and hashes. The compact
[remaining-boundary census](../../oxy-capability-boundaries.md) identifies real
callers that cannot be deleted as unreachable code.
