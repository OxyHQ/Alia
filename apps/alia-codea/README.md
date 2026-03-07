# Codea by Alia

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/oxy.alia-codea?style=flat&label=VS%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=oxy.alia-codea)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/oxy.alia-codea?style=flat&label=Installs)](https://marketplace.visualstudio.com/items?itemName=oxy.alia-codea)
[![Visual Studio Marketplace Rating](https://img.shields.io/visual-studio-marketplace/r/oxy.alia-codea?style=flat&label=Rating)](https://marketplace.visualstudio.com/items?itemName=oxy.alia-codea)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI coding assistant for Visual Studio Code, powered by [Alia](https://alia.onl).

## Runtime Integration

Codea uses the same unified chat runtime as app and Cowork:

- Endpoint: `POST /v1/chat/completions`
- Model IDs: Alia IDs only (`alia-v1-codea`, `alia-v1-pro`, etc.)
- Streaming events: standardized named events with `eventVersion: 1`
- Removed endpoints (`/codea/resolve-model`, `/codea/report-usage`) are no longer used by clients

## Features

✨ **Intelligent Code Assistance**
- Chat with AI about your code in real-time
- Get help writing, debugging, and understanding code
- Context-aware suggestions based on your current work
- Streaming responses for immediate feedback

🚀 **Multiple AI Models**
- **Alia Lite** - Fast responses for quick questions (0.5x credits)
- **Alia V1** - Balanced performance for everyday coding (1x credits)
- **Alia V1 Codea** - Optimized specifically for code tasks (1.5x credits)
- **Alia V1 Pro** - High-quality responses for complex problems (3x credits)
- **Alia V1 Pro Max** - Best available model for critical tasks (5x credits)

🎯 **Seamless Integration**
- Works directly in VS Code sidebar
- Inline code completions with AI-powered suggestions
- Native chat participant (`@codea` in VS Code chat)
- Git integration for commit messages and merge conflicts

## Getting Started

### Prerequisites

You'll need an Alia API key to use this extension. Get yours at [alia.onl](https://alia.onl).

### Installation

1. Install the extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=oxy.alia-codea)
2. Open VS Code Settings (`Cmd/Ctrl + ,`)
3. Search for "Codea"
4. Enter your Alia API key in `codea.apiKey` (it should start with `alia_sk_`)

### Quick Start

Press `Ctrl+Shift+A` (or `Cmd+Shift+A` on Mac) to open Codea Chat and start coding with AI assistance!

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `codea.apiKey` | Your Alia API key (starts with `alia_sk_`) | - |
| `codea.apiBaseUrl` | API base URL | `https://api.alia.onl` |
| `codea.model` | Model to use for completions | `alia-v1-codea` |
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
- API keys are stored securely in VS Code's secret storage
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

MIT - [The Oxy Collective, Inc.](https://oxy.so)

---

**Made with ❤️ by [Oxy](https://oxy.so)**
