# Changelog

All notable changes to Clarity are documented here.

## [2026-03-07]

### Added

- Unified autonomy runtime for all chat surfaces (`/clarity/search` and `/v1/chat/completions`).
- Context graph persistence with new models:
  - `ContextNode`
  - `ContextEdge`
  - `ContextSource`
  - `RetrievalStrategy`
  - `LearningRule`
  - `RollbackRecord`
- Intent-oriented recall and planning (`meeting_prep`, `inbox_digest`, `project_status`, `task_followup`, `monitoring`, `research`, `general`).
- Governance engine with risk levels `R0` to `R3`.
- Real approval lifecycle (`threat -> approval request -> decision -> execution`).
- Standardized named SSE events with `eventVersion`.
- Oxy event idempotency log (`OxyServiceEventLog`) and autonomous session bootstrap.

### Changed

- Trigger engine is now the single scheduled execution path.
- App trigger UI now uses `/triggers` endpoints directly.
- Chat runtime now emits plan preview, approval, and agent-session events consistently.

### Removed

- Legacy `automations` routes, model, and scheduler.
- Public direct model-resolution and usage-report routes:
  - `/v1/resolve-model`
  - `/v1/report-usage`
  - `/codea/resolve-model`
  - `/codea/report-usage`
- Legacy chat compatibility route under `/v1/codea/chat/completions`.

## [2026-02-11]

### Initial

- Initial public release of Clarity app + API + multi-surface clients.
