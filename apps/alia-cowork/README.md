# Alia Cowork

Desktop assistant (Electron + React) for autonomous work and local tool execution.

## Runtime Contract

Cowork connects to the same unified backend runtime used by app and Codea:

- `POST /v1/chat/completions`
- Streaming named events with `eventVersion: 1`

Supported named events:

- `alia.reasoning`
- `alia.tool_result`
- `alia.plan_preview`
- `alia.approval_request`
- `alia.approval_result`
- `alia.research_progress`
- `alia.model_switch`
- `alia.agent_session`
- `alia.title`

## Features

- Streaming chat
- Local tool execution
- Ask/Edit/Plan/YOLO modes
- Credit-aware usage
- Cross-session conversation history

## Local Tools

- `read_file`
- `write_file`
- `edit_file`
- `list_files`
- `search_files`
- `run_command`
- `open_application`
- `open_url`
- `clipboard_read` / `clipboard_write`
- `get_system_info`
- `screenshot`
- `set_mode`

## Development

```bash
npm install
npm run dev
```

Build/package:

```bash
npm run build
npm run package
```

## Configuration

Stored in local app settings:

- `apiKey`
- `apiBaseUrl`
- `model`
- `enableTools`

## Notes

- Cowork does not require provider-specific client logic.
- Public responses expose only Alia model identifiers.
