# Changelog

## [1.0.2] - 2026-10-26

- Send acknowledged, authenticated Stop through the shared Alia server SDK before detaching a foreground generation.
- Give each HTTP tool continuation its own cancellation ID; a failed Stop remains visible and retryable without starting another generation.
- Keep account changes and view teardown as transport detachment. Already completed local tool actions are not undone.
- Require the explicit Stop API receiver before distributing this desktop build. Artifact creation does not publish a desktop release.

## [1.0.1] - 2026-10-25

- Use shared Oxy session transports for chat, catalogue, browser-agent inference, device registration and relay reconnects.
- Cancel previous-account work and discard late browser/tool results after an account change.
- Remove app-local bearer forwarding and the browser agent's placeholder API key.

These are package build versions. Distribution is separate from the npm release workflow.
