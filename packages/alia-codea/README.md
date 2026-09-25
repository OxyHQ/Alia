# Codea by Alia

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/oxy.alia-codea?style=flat&label=VS%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=oxy.alia-codea)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/oxy.alia-codea?style=flat&label=Installs)](https://marketplace.visualstudio.com/items?itemName=oxy.alia-codea)
[![Visual Studio Marketplace Rating](https://img.shields.io/visual-studio-marketplace/r/oxy.alia-codea?style=flat&label=Rating)](https://marketplace.visualstudio.com/items?itemName=oxy.alia-codea)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI coding assistant for Visual Studio Code, powered by [Alia](https://alia.onl).

## Runtime Integration

Codea uses the same unified chat runtime as app and Cowork:

- Endpoint: `POST /alia/chat` (one handler with `POST /v1/chat/completions`)
- Model IDs: real `publisher/model` ids listed by `GET /catalogue`. With no model
  chosen, the request omits `model` and Alia uses its default model
- Streaming events: standardized named events with `eventVersion: 1`
- The `/codea` API router is gone; the extension signs in with Oxy and uses the unified runtime above

## Features

✨ **Intelligent Code Assistance**
- Chat with AI about your code in real-time
- Get help writing, debugging, and understanding code
- Context-aware suggestions based on your current work
- Streaming responses for immediate feedback

🚀 **Multiple AI Models**
- Pick any model from the live Alia catalogue, grouped by publisher
- Leave it on **Default** and Alia uses its own default model

🎯 **Seamless Integration**
- Works directly in VS Code sidebar
- Inline code completions with AI-powered suggestions
- Native chat participant (`@codea` in VS Code chat)
- Git integration for commit messages and merge conflicts

## Getting Started

### Prerequisites

You need an Oxy account. Codea signs in with Oxy in the browser; there are no Alia API keys to create or paste.

### Installation

1. Install the extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=oxy.alia-codea)
2. Run **Codea: Sign In** from the Command Palette and finish signing in with Oxy in the browser

### Quick Start

Press `Ctrl+Shift+A` (or `Cmd+Shift+A` on Mac) to open Codea Chat and start coding with AI assistance!

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `codea.apiBaseUrl` | API base URL | `https://api.alia.onl` |
| `codea.model` | Model id (`publisher/model`) from the Alia catalogue; empty uses the server's default model | `""` (server default) |
| `codea.maxTokens` | Maximum tokens in response | `4096` |
| `codea.temperature` | Temperature for response generation (0-2) | `0.7` |
| `codea.enableInlineCompletions` | Enable inline code completions | `true` |
| `codea.enableChatParticipant` | Enable native chat participant | `true` |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+A` / `Cmd+Shift+A` | Open Codea Chat |

## Commands

Access these commands via the Command Palette (`Cmd/Ctrl + Shift + P`):

- **Codea: Getting Started** - Open the walkthrough guide
- **Codea: Sign In** - Sign in to your Alia account
- **Codea: Refresh Token** - Refresh your authentication token
- **Codea: Generate Commit Message** - AI-generated commit messages
- **Codea: Resolve Merge Conflicts** - Get help resolving merge conflicts

## Privacy & Security

- Your code is sent to Alia's servers for processing
- Your Oxy session is stored in VS Code's secret storage
- See [Alia's Privacy Policy](https://alia.onl/privacy) for details

## Support

- **Issues & Feature Requests**: [GitHub Issues](https://github.com/OxyHQ/codea-ai-extension/issues)
- **Documentation**: [Alia Documentation](https://docs.alia.onl)
- **General Support**: [oxy.so/support](https://oxy.so/support)

## Development

```bash
# Install dependencies
npm install

# Build extension
npm run build

# Watch mode for development
npm run watch

# Build webview in watch mode
npm run watch:webview

# Package as .vsix
npm run package
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history and release notes.

## License

MIT - [The Oxy Foundation, Inc.](https://oxy.so)

---

**Made with ❤️ by [Oxy](https://oxy.so)**
