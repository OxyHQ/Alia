# Codea by Alia - Feature Documentation

## Hybrid Architecture

Codea by Alia uses a **hybrid architecture** to provide the best of both worlds:

### 1. 🔮 Inline Completions (AI-Powered)
**Native Codea Studio Code integration** - Ghost text appears as you type with intelligent AI suggestions.

- **Provider**: `AliaInlineCompletionProvider`
- **Activation**: Automatic when enabled in settings
- **Trigger**: As you type in any file
- **Configuration**: `codea.enableInlineCompletions`

**How it works:**
- Monitors your cursor position and context
- Sends code context to Alia API
- Displays suggestions as ghost text
- Press `Tab` to accept, `Esc` to dismiss

### 2. 💬 Native Chat Participant
**Integrated into Codea Studio Code's native chat panel** - Use `@codea` in the chat.

- **Provider**: `AliaChatParticipant`
- **Activation**: Requires VS Code 1.90+
- **Trigger**: Type `@codea` in VS Code chat panel
- **Configuration**: `codea.enableChatParticipant`

**How it works:**
- Open chat: `Ctrl+Alt+I` (or Cmd+Option+I on Mac)
- Type `@codea` followed by your question
- Get streaming responses directly in Codea Studio Code
- Full conversation history support

### 3. 🎨 Custom Sidebar (shadcn/ui)
**Beautiful custom webview** with modern UI components.

- **Provider**: `CodeaChatViewProvider`
- **Location**: Secondary sidebar (right side) or Activity Bar
- **UI Framework**: React + Vite + shadcn/ui
- **Theme**: Radix Nova with Tailwind CSS v4

**Features:**
- Custom chat interface with advanced formatting
- Session management (new conversation, clear history)
- Code syntax highlighting with react-markdown
- Responsive, accessible design

## Configuration

All settings are available in Codea Studio Code settings (`Ctrl+,` → Search "Codea"):

### Required Settings

```json
{
  "codea.apiKey": "alia_sk_your_key_here",
  "codea.apiBaseUrl": "https://api.alia.onl"
}
```

### Model Selection

```json
{
  "codea.model": "alia-v1-codea"
}
```

**Available Models:**
- `alia-lite` - Fast responses (0.5x credits)
- `alia-v1` - Balanced performance (1x credits)
- `alia-v1-codea` - Optimized for code (1.5x credits) **[Recommended]**
- `alia-v1-pro` - High quality (3x credits)
- `alia-v1-pro-max` - Best available (5x credits)

### Feature Toggles

```json
{
  "codea.enableInlineCompletions": true,
  "codea.enableChatParticipant": true
}
```

### Generation Settings

```json
{
  "codea.maxTokens": 4096,
  "codea.temperature": 0.7
}
```

## Usage Examples

### Inline Completions

1. Start typing in any file
2. Wait for ghost text to appear
3. Press `Tab` to accept
4. Keep coding!

**Example:**
```typescript
function calculateFibonacci(n) {
  // Start typing...
  if (n <= 1) return n;  // ← Ghost text appears here
}
```

### Native Chat

1. Open Codea Studio Code chat: `Ctrl+Alt+I`
2. Type: `@codea explain this function`
3. Get instant help

**Example prompts:**
- `@codea refactor this code to use async/await`
- `@codea find bugs in the selected code`
- `@codea write unit tests for this function`

### Custom Sidebar

1. Click Codea icon in Activity Bar
2. Or press `Ctrl+Shift+A`
3. Use the beautiful chat interface

## Architecture Benefits

### Why Hybrid?

| Feature | Native APIs | Custom Webview |
|---------|-------------|----------------|
| Inline completions | ✅ Perfect integration | ❌ Not possible |
| Quick chat | ✅ Native feel | ⚠️ Separate window |
| Advanced UI | ❌ Limited customization | ✅ Full control |
| shadcn/ui | ❌ Not available | ✅ Full library |
| Performance | ✅ Optimized | ⚠️ Slightly slower |

**The hybrid approach gives you:**
- ✅ AI-powered inline completions
- ✅ Native chat integration
- ✅ Beautiful custom UI where it matters
- ✅ Best user experience possible

## Technical Details

### File Structure

```
src/
├── extension.ts                 # Main entry point
├── inlineCompletionProvider.ts  # Inline completions (ghost text)
├── chatParticipant.ts          # Native chat participant
├── chatProvider.ts             # Custom webview provider
└── tools.ts                    # Utility functions

webview-ui/                     # React app for custom UI
├── src/
│   ├── components/             # shadcn/ui components
│   ├── App.tsx                 # Main chat interface
│   └── index.css               # Tailwind styles
└── package.json
```

### API Integration

All providers use the Alia API:
- **Endpoint**: `https://api.alia.onl/v1/chat/completions`
- **Authentication**: Bearer token (API key)
- **Streaming**: Supported for chat responses
- **Models**: Multiple model options

### Browser Support

The extension includes both Node.js and browser builds:
- **Desktop**: `dist/extension.js` (Node.js)
- **Web**: `dist/browser/extension.js` (Browser)

This enables the extension to work in:
- Codea Studio Code Desktop
- Codea Studio Code Web
- GitHub Codespaces
- Gitpod

## Troubleshooting

### Inline completions not showing

1. Check `codea.enableInlineCompletions` is `true`
2. Verify API key is set correctly
3. Look for errors in Output panel: View → Output → "Codea by Alia"

### Chat participant not available

1. Ensure Codea Studio Code version is 1.90 or later
2. Check `codea.enableChatParticipant` is `true`
3. Try reloading window: `Ctrl+Shift+P` → "Reload Window"

### Webview not loading

1. Check if files are built: `npm run build`
2. Clear webview cache: Reload window
3. Check console for errors: Help → Toggle Developer Tools

## Development

### Building

```bash
# Build everything
npm run build

# Watch mode (extension)
npm run watch

# Watch mode (webview)
npm run watch:webview
```

### Testing

1. Press `F5` to launch Extension Development Host
2. Test inline completions by typing in a file
3. Test chat by opening chat panel and typing `@codea`
4. Test webview by clicking Codea icon

### Packaging

```bash
npm run package
```

This creates `alia-codea-1.0.0.vsix` ready for distribution.

## Contributing

Contributions are welcome! Areas for improvement:

- [ ] Add debouncing for inline completions
- [ ] Implement multi-line completions
- [ ] Add telemetry (opt-in)
- [ ] Improve error handling
- [ ] Add more configuration options
- [ ] Create more shadcn/ui components

## License

MIT License - See LICENSE file for details
