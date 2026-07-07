# OxyHQ Authentication & Packages Guide (Alia)

> **Model:** device-first, **zero-cookie**. There is **one** frontend SDK — `@oxyhq/services` (`OxyProvider` + `useAuth`/`useOxy`) — for **web AND native**. The old web-only `@oxyhq/auth` / `WebOxyProvider` package and cross-domain SSO/FedCM were removed ecosystem-wide (2026-07). The canonical, always-current reference lives in the OxyHQServices repo: `docs/architecture/oxy-auth-platform.md`, `docs/SESSION-ARCHITECTURE.md`, `docs/auth/device-session.md`.

## Which package?

| Where | Package | What you mount / import |
|-------|---------|-------------------------|
| **Frontend — web** (Vite) | `@oxyhq/services` | `OxyProvider` + `useAuth()`/`useOxy()`. Bundle the React-Native graph in Vite with `rolldown-vite` + `vite-plugin-react-native-web` (see `packages/alia-console`, `packages/alia-gateway-admin`, `packages/alia-canvas`). |
| **Frontend — native** (Expo/RN) | `@oxyhq/services` | Same `OxyProvider` + `useAuth()`/`useOxy()`. |
| **Backend** (Node/Express) | `@oxyhq/core/server` | `createOxyAuthMiddleware`, `createOptionalOxyAuth`, `requireOxyAuth`, `getRequiredOxyUserId`, `authSocket`. Never mount a frontend provider on the server. |

`@oxyhq/core` provides the platform-agnostic client (`OxyServices`, `createLinkedClient`) and is a dependency of `@oxyhq/services`; import core types directly from `@oxyhq/core` and API contracts from `@oxyhq/contracts`.

## Session model (device-first, zero-cookie)

The transport is a first-party `{ deviceId, deviceSecret }` persisted **per origin** (web `localStorage`, native SecureStore). The SDK cold boot mints a short access token by presenting them to `POST /session/device/token` — no cookie, no refresh-token family, no `#oxy_boot` bootstrap, no FedCM, no `/sso` bounce. The `DeviceSession` document is the server-side session authority. Apps never implement local session restore; the SDK owns it.

## Frontend setup (web, Vite)

```typescript
// src/App.tsx
import { OxyProvider, useAuth } from '@oxyhq/services';

function App() {
  return (
    <OxyProvider baseURL="https://api.alia.onl" clientId={import.meta.env.VITE_OXY_CLIENT_ID}>
      <Routes />
    </OxyProvider>
  );
}

// anywhere inside the provider
const { user, isAuthenticated, isLoading, signIn, signOut, oxyServices } = useAuth();
// signIn() with no args opens the in-app SDK sign-in dialog.
```

Vite config: use `rolldown-vite` + `vite-plugin-react-native-web` (+ the `react-native-screens` shim) so the RN graph bundles for the browser — copy `packages/alia-gateway-admin/vite.config.ts`.

## Backend setup (Express)

```typescript
import { OxyServices } from '@oxyhq/core';
import { createOxyAuthMiddleware, getRequiredOxyUserId } from '@oxyhq/core/server';

const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
app.use('/api/protected', createOxyAuthMiddleware(oxy));
// inside a handler: const userId = getRequiredOxyUserId(req);
```

## Environment variables

```bash
# Web (Vite)
VITE_OXY_CLIENT_ID=oxy_dk_...
VITE_API_URL=https://api.alia.onl

# Native (Expo)
EXPO_PUBLIC_OXY_CLIENT_ID=oxy_dk_...
```

## Don't

- **Don't** import `@oxyhq/auth` / `WebOxyProvider` — the package is retired; use `@oxyhq/services` `OxyProvider` on web and native alike.
- **Don't** mount a frontend provider on the backend — use `@oxyhq/core/server` middleware there.
- **Don't** hand-roll session restore, cookies, refresh tokens, or SSO redirects — the SDK's device-first cold boot owns it.

## Troubleshooting

- **"useAuth/useOxy must be used within OxyProvider"** — the hook is called outside the `<OxyProvider>` tree; hoist the provider to the app root.
- **Web build fails resolving `react-native-*` / `codegenNativeComponent`** — the Vite app is missing `vite-plugin-react-native-web` or the `react-native-screens` shim; mirror `packages/alia-gateway-admin`. (Next.js/Turbopack cannot bundle the RN graph — Alia web apps are Vite.)
