# Codea by Alia

AI coding assistant for VS Code, powered by Alia.

## Features

- Chat with AI about your code
- Get help writing, debugging, and understanding code
- Streaming responses for real-time feedback

## Setup

1. Install the extension
2. Open VS Code Settings (Cmd/Ctrl + ,)
3. Search for "Codea"
4. Enter your Alia API key in `codea.apiKey`

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `codea.apiKey` | Your Alia API key (starts with `alia_sk_`) | - |
| `codea.apiBaseUrl` | API base URL | `https://api.alia.onl` |
| `codea.model` | Model to use | `alia-v1-codea` |

## Keyboard Shortcuts

- `Ctrl+Shift+A` / `Cmd+Shift+A` - Open Codea Chat

## Development

```bash
# Install dependencies
npm install

# Build extension
npm run build

# Watch mode
npm run watch

# Package as .vsix
npm run package
```

## License

MIT - Oxy
