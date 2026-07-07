# Alia Canvas

A web-based visual workflow editor for the Alia platform — build AI-powered
automations on an interactive node canvas. Powered by Oxy.

## Development

```bash
# Start the Vite dev server (http://localhost:3002)
bun run dev

# Type-check and build for production (outputs to dist/)
bun run build

# Preview the production build locally
bun run preview
```

## Environment

| Variable              | Purpose                                        | Default                 |
| --------------------- | ---------------------------------------------- | ----------------------- |
| `VITE_API_URL`        | Alia workflow API base (workflows/execute)     | `http://localhost:3001` |
| `VITE_OXY_URL`        | Oxy API base used by `OxyProvider` for auth    | `https://api.oxy.so`    |
| `VITE_OXY_CLIENT_ID`  | Registered Oxy application client id           | built-in default        |

## Tech Stack

- [Vite](https://vite.dev) (rolldown-vite) — build tooling and dev server
- [React](https://react.dev) — UI library
- [TypeScript](https://www.typescriptlang.org) — type-safe JavaScript
- [@xyflow/react](https://reactflow.dev) — node-based canvas
- [@oxyhq/services](https://www.npmjs.com/package/@oxyhq/services) — device-first Oxy auth + SDK
- [@oxyhq/bloom](https://www.npmjs.com/package/@oxyhq/bloom) — shared UI theming
- [Tailwind CSS v4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com)
