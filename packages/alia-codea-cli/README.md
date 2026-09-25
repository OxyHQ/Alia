# Codea CLI

AI coding assistant for your terminal by Alia.

```
   ██████╗ ██████╗ ██████╗ ███████╗ █████╗
  ██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗
  ██║     ██║   ██║██║  ██║█████╗  ███████║
  ██║     ██║   ██║██║  ██║██╔══╝  ██╔══██║
  ╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║
   ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝
```

## Installation

```bash
npm install -g @alia-codea/cli
```

## Quick Start

1. Login with your Alia API key:
```bash
codea login
```

2. Start coding:
```bash
codea
```

## Features

- **Interactive Chat**: Natural language conversations with your AI coding assistant
- **File Operations**: Read, write, and edit files directly
- **Command Execution**: Run shell commands, build, test, and more
- **Codebase Context**: Automatically understands your project structure
- **Session Management**: Save and resume conversations
- **Multiple Models**: Switch between Codea, Codea Pro, and Codea Thinking

## Commands

### Start Interactive Session
```bash
codea              # Start a new chat session
codea chat         # Same as above
```

### Run Single Prompt
```bash
codea run "fix the bug in auth.ts"
codea r "add unit tests for the User class" -y  # Auto-approve changes
```

### Session Management
```bash
codea sessions     # List recent sessions
codea resume       # Resume a previous session
codea resume 1     # Resume session #1
```

### Configuration
```bash
codea login        # Configure API key
```

## Slash Commands (in chat)

| Command    | Description                |
|------------|----------------------------|
| `/help`    | Show available commands    |
| `/clear`   | Clear conversation         |
| `/model`   | List or switch models      |
| `/context` | Show current context       |
| `/save`    | Save conversation          |
| `/exit`    | Exit Codea                 |

## Models

Codea uses the real models in the live Alia catalogue (ids like
`publisher/model`). With no choice, Alia answers with its default model.

```bash
codea --model publisher/model   # or any text that matches one model
# or in chat:
/model                  # list models: featured first, then by publisher
/model <id or name>     # switch
/model default          # back to the server's default model
```

## Tools

Codea can:
- **read_file**: Read file contents
- **write_file**: Create or overwrite files
- **edit_file**: Make targeted edits
- **list_files**: Explore directories
- **search_files**: Search code patterns
- **run_command**: Execute shell commands

## Examples

```bash
# Start coding
codea

# In chat:
❯ explain this codebase
❯ fix the TypeScript errors
❯ add authentication to the API
❯ write tests for the User model
❯ run npm test and fix any failures
```

## Configuration

Config is stored in `~/.config/alia-codea-cli/config.json`. `defaultModel` is a
`publisher/model` id from the catalogue, or empty for the server's default:

```json
{
  "apiKey": "your-api-key",
  "apiBaseUrl": "https://api.alia.onl",
  "defaultModel": ""
}
```

## License

MIT - Created by [Alia](https://alia.onl)
