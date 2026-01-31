# Changelog

All notable changes to the "Codea by Alia" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-01-31

### Added
- Initial release of Codea by Alia extension
- AI-powered chat interface in VS Code sidebar
- Support for multiple Alia AI models:
  - Alia Lite (0.5x credits)
  - Alia V1 (1x credits)
  - Alia V1 Codea (1.5x credits)
  - Alia V1 Pro (3x credits)
  - Alia V1 Pro Max (5x credits)
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
