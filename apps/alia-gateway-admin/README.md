# Alia Gateway Admin Panel

Modern admin panel for managing the Alia Gateway module (internal to the main API). Built with Vite, React, TypeScript, and shadcn/ui.

## Architecture

The providers module lives inside the main API at `apps/api/src/internal/gateway/`. It is **not** a separate microservice. The admin panel connects to `http://localhost:3001/internal/gateway` (or the configured `VITE_GATEWAY_API_URL`).

```
Admin Panel (this app)
  └─→ Main API (apps/api, port 3001)
       └─→ /internal/gateway/*   ← providers module
```

## Features

- **Dashboard**: Overview of provider health, key statistics, and system metrics
- **API Keys Management**: Full CRUD operations for provider API keys with:
  - Priority-based rotation system
  - Automatic key rotation on failure
  - Free/Paid tier separation
  - Rate limit configuration
  - Key activation/deactivation
  - AES-256-GCM encryption at rest

- **Models Management**: Configure provider models and Alia virtual models:
  - Provider model configurations (pricing, capabilities, limits)
  - Model capabilities (vision, tools, JSON mode, PDF, etc.)
  - Thinking level configuration

- **Plans Management**: Full CRUD for subscription plans (Alia & Codea):
  - Plan identity (planId, name, product)
  - Pricing (credits/month, monthly/annual price in cents, currency)
  - Display config (subtitle i18n key, creditsLabel, sortOrder, isFeatured, isFree)
  - Nested feature groups with categorized items (label + description)
  - Stripe price ID mapping for monthly/annual billing
  - Changes reflected in subscribe screens without code deploys

- **Real-time Monitoring**: Live monitoring with auto-refresh:
  - Provider health metrics
  - Success rate tracking
  - Latency monitoring
  - Circuit breaker states
  - Key priority rotation visualization
  - Interactive charts and graphs

## Tech Stack

- **Framework**: Vite + React 19
- **Language**: TypeScript
- **UI Components**: shadcn/ui (Radix UI primitives)
- **Styling**: Tailwind CSS v4
- **Data Fetching**: TanStack Query (React Query)
- **Real-time**: WebSocket with automatic fallback to HTTP polling
- **Authentication**: OxyHQ Auth (cross-domain SSO via `@oxyhq/auth`)
- **Charts**: Recharts
- **Routing**: React Router v7
- **Icons**: Lucide React

## Authentication

The admin panel uses **OxyHQ's cross-domain SSO** for authentication with strict authorization.

### How it works

1. **Frontend**: Uses `WebOxyProvider` and `useAuth` from `@oxyhq/auth`
2. **Login Flow**: Click "Sign in with Oxy" -> redirects to auth.oxy.so -> FedCM/popup/redirect -> returns with session
3. **Authorization Check**: Only username `nate` is allowed admin access
4. **Backend Validation**: Every API request includes a Bearer token validated by the API's auth middleware

### Code

**Frontend** ([src/App.tsx](src/App.tsx)):
```typescript
import { WebOxyProvider, useAuth } from '@oxyhq/auth';

const { user, isAuthenticated, isLoading } = useAuth();
const isAuthorized = user?.username?.toLowerCase() === 'nate';
```

**Backend** (apps/api [src/internal/gateway/middleware/auth.ts](../api/src/internal/gateway/middleware/auth.ts)):
```typescript
// Accepts both HMAC (service-to-service) and Bearer token (admin panel)
// Bearer tokens are validated against OxyHQ and checked for admin username
```

## Real-time Updates

The admin panel uses **WebSocket connections** for live data updates with automatic fallback to HTTP polling.

See [REALTIME.md](REALTIME.md) for full WebSocket protocol documentation.

## Setup

### Prerequisites

- Node.js 18+
- npm or yarn
- Running main API service (`apps/api` on port 3001)
- OxyHQ account (username must be "nate" for admin access)

### Installation

```bash
npm install
cp .env.example .env
```

### Environment Variables

**Development:**
```env
VITE_GATEWAY_API_URL=http://localhost:3001/internal/gateway
VITE_OAUTH_CLIENT_ID=your-oxyauth-client-id
VITE_OAUTH_AUTHORITY=https://auth.oxy.com
VITE_OAUTH_REDIRECT_URI=http://localhost:5173/auth/callback
VITE_OAUTH_SCOPE=openid profile email
```

**Production:**
```env
VITE_GATEWAY_API_URL=https://api.alia.onl/internal/gateway
```

### Development

```bash
npm run dev
# Open browser at http://localhost:5173
```

### Production Build

```bash
npm run build
npm run preview
```

## Deployment

### Production Domains

- **Admin Panel**: `https://gateway.alia.onl`
- **API (providers endpoint)**: `https://api.alia.onl/internal/gateway`

The admin panel communicates with the providers module inside the main API. Ensure the API is deployed and the `VITE_GATEWAY_API_URL` environment variable points to the correct endpoint.

### Deployment Notes

- **No VPN needed**: Authentication is handled by OxyHQ SSO
- **Static hosting**: The `dist/` folder can be served by any static file server (Nginx, Vercel, Netlify, etc.)
- **Environment variables**: Must be set at build time (compiled into the bundle)
- **CORS**: The API allows requests from the admin panel domain

## License

MIT
