# App-only Console machine chat candidate

Source `69e0d85a8`, based on Alia main `b2bc57f45`. Typed machine credentials opt into the two shared chat routes only. Closed body options and an empty tool turn prevent user/product authority; the request-scoped canonical bearer selects the caller payer in Oxy. Session and delegated requester lanes remain separate.

Local evidence: 112 cases in 8 suites, API types/build and lint with zero warnings. Current-main auth is frozen centrally: the same desired HTTP fixture preserves 7 failures / 3 passes before this change and passes 10 entry cases afterward. The core fixture is source-built and unpublished; all 585 installed files match its tarball, with no local dependency or lock references. This is not published-core adoption, current-head registry CI success, or a production claim.

The coordinated Oxy API scope migration/resource endpoint and root-owned core release must precede an exact Alia registry/lock update and deployment. [proof.json](proof.json) identifies both sources and the central Oxy evidence hash. Generic service-access issues and personal tools are outside this contract.
