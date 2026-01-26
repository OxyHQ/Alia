# Alia Cowork

Alia Cowork is a desktop AI assistant for Windows and macOS, built with Electron and React.

## Architecture

Alia Cowork uses **OpenAI SDK** directly to communicate with the Alia API backend. This is a simple, clean architecture:

```
Alia Cowork (OpenAI SDK)
    ↓
POST /v1/chat/completions (OpenAI format)
    ↓
Alia API Backend (converts internally using AI SDK)
    ↓
Google / Anthropic / OpenAI / Groq / etc.
    ↓
OpenAI-compatible SSE stream response
    ↓
OpenAI SDK processes chunks
    ↓
UI displays text + chain-of-thought
```

### Why OpenAI SDK?

- **Simple**: No custom provider code needed
- **Standard**: OpenAI format is the industry standard
- **Backend handles complexity**: Provider routing, AI SDK integration, and format conversion all happen server-side
- **Client stays thin**: Just OpenAI SDK + tool execution

### Backend API Compatibility

The Alia API backend:
1. Accepts OpenAI-format requests (`/v1/chat/completions`)
2. Internally uses AI SDK with official providers (Google, Anthropic, OpenAI, Groq, etc.)
3. Converts all responses to OpenAI-compatible SSE stream format
4. Extends OpenAI format with `delta.reasoning` for chain-of-thought visualization

## Features

- **Chat streaming** with real-time responses
- **Chain-of-thought visualization** (reasoning extracted from `delta.reasoning`)
- **Local tool execution** (file operations, commands, clipboard, etc.)
- **Multiple modes**: Ask, Edit, Plan, YOLO
- **Multi-provider support** (transparent - backend chooses provider)
- **Credit-based usage tracking**

## Development

```bash
# Install dependencies
npm install

# Start in development mode
npm run dev

# Build for production
npm run build

# Package for distribution
npm run package
```

## Configuration

The app uses `electron-store` for settings:

- **apiKey**: Your Alia API key
- **apiBaseUrl**: API endpoint (default: `https://api.alia.onl`)
- **model**: Alia model to use (e.g., `alia-v1-cowork`)
- **enableTools**: Enable/disable tool execution

## Tools

The app can execute tools locally in the Electron environment:

- `read_file` - Read file contents
- `write_file` - Create/overwrite files
- `edit_file` - Replace text in files
- `list_files` - List directory contents
- `search_files` - Search for text patterns
- `run_command` - Execute shell commands
- `open_application` - Open apps or files
- `open_url` - Open URLs in browser
- `clipboard_read` / `clipboard_write` - Access clipboard
- `get_system_info` - Get system information
- `screenshot` - Capture screen
- `set_mode` - Change operating mode

### Tool Execution Flow

1. User sends message to API with tools defined
2. API returns tool calls in OpenAI format
3. Cowork executes tools locally (file system, shell, etc.)
4. Results sent back to API as tool messages
5. API generates response based on tool results
6. Process repeats until no more tools needed

## Project Structure

```
apps/alia-cowork/
├── src/
│   ├── main/           # Electron main process
│   │   ├── index.ts    # App entry point
│   │   ├── chat.ts     # Chat provider (OpenAI SDK)
│   │   ├── tools.ts    # Tool executors
│   │   ├── auth.ts     # Authentication
│   │   └── windowState.ts
│   ├── preload/        # Preload scripts
│   │   └── index.ts
│   └── renderer/       # React UI
│       └── src/
├── dist/               # Build output
├── gulpfile.ts         # Build configuration
├── package.json
└── tsconfig.json
```

## Building

The build process uses Gulp with esbuild:

- **main**: Bundles main process (Node.js environment)
- **preload**: Bundles preload scripts
- **renderer**: Bundles React UI
- **css**: Processes Tailwind CSS

External dependencies (not bundled):
- `electron`
- `electron-store`
- `dotenv`
- `openai`

## Distribution

Use electron-builder to create installers:

```bash
npm run dist
```

This creates platform-specific installers in the `dist/` directory.

## OpenAI SDK Usage

Example of how chat streaming works:

```typescript
import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: 'your-alia-api-key',
  baseURL: 'https://api.alia.onl/v1'
})

const stream = await openai.chat.completions.create({
  model: 'alia-v1-cowork',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  tools: [...], // Tool definitions
  stream: true
})

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta

  // Handle content
  if (delta.content) {
    console.log(delta.content)
  }

  // Handle reasoning (chain-of-thought)
  if (delta.reasoning) {
    console.log('Thinking:', delta.reasoning)
  }

  // Handle tool calls
  if (delta.tool_calls) {
    // Execute tools locally
  }
}
```

## License

MIT
