# Changelog

All notable changes to the "Codea by Alia" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.9] - 2026-10-26

- Send acknowledged, authenticated Stop through the shared Alia server SDK before detaching a foreground generation.
- Give each HTTP tool continuation its own cancellation ID; a failed Stop remains visible and retryable without starting another generation.
- Keep account changes and view teardown as transport detachment. Already completed local tool actions are not undone.
- Require the explicit Stop API receiver before distributing this desktop build. Artifact creation does not publish a desktop release.

## [1.0.8] - 2026-10-25

### Fixed

- Use the shared Oxy session for chat, inline completions, catalogue requests and relay reconnects.
- Cancel work when the account changes; keep local and native chat history within its original account.
- Restore only from the shared device credential and clear it on sign-out.
- Keep workspace containment checks compatible with the browser extension host and load process-backed MCP tools lazily.
- Align the VS Code engine and typecheck floor to 1.93 for the existing terminal integration API.

## [1.0.0] - 2026-01-31

### Added
- Initial release of Codea by Alia extension
- AI-powered chat interface in VS Code sidebar
- Support for multiple Alia AI models:
  - Instant (0.5x credits)
  - Auto (1x credits)
  - Code (1.5x credits)
  - Pro Standard (3x credits)
  - Pro (5x credits)
- Inline code completions with AI-powered suggestions
- Native chat participant integration (`@codea` in VS Code chat)
- Streaming responses for real-time feedback
- Context-aware code assistance
- Git integration features:
  - AI-generated commit messages
  - Merge conflict resolution assistance
- Interactive walkthrough guide for new users
- Authentication system with Alia API
- Configurable settings:
  - API key management
  - Model selection
  - Token limits
  - Temperature control
  - Feature toggles for inline completions and chat participant
- Keyboard shortcut: `Ctrl+Shift+A` / `Cmd+Shift+A` to open chat
- Dual sidebar support (primary and secondary)
- Web extension support for browser-based VS Code

### Security
- Secure API key storage using VS Code's secret storage
- HTTPS-only communication with Alia API

---

## Version History

- **1.0.0** - Initial release with core AI coding assistant features

[1.0.0]: https://github.com/OxyHQ/codea-ai-extension/releases/tag/v1.0.0
