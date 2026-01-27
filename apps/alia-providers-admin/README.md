# Alia Providers Admin Panel

Modern admin panel for managing the Alia Providers microservice. Built with Vite, React, TypeScript, and shadcn/ui.

## Features

- **Dashboard**: Overview of provider health, key statistics, and system metrics
- **API Keys Management**: Full CRUD operations for provider API keys with:
  - Priority-based rotation system
  - Automatic key rotation on failure
  - Free/Paid tier separation
  - Rate limit configuration
  - Key activation/deactivation

- **Models Management**: Configure provider models and Alia virtual models:
  - Provider model configurations (pricing, capabilities, limits)
  - Model capabilities (vision, tools, JSON mode, PDF, etc.)
  - Thinking level configuration

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
- **Authentication**: OxyHQ Services (cross-domain SSO)
- **Charts**: Recharts
- **Routing**: React Router v7
- **Icons**: Lucide React

## Clean Web-Only Architecture

This admin panel uses **@oxyhq/services/web** - a clean, professional web-only module with **ZERO React Native dependencies**.

### Why /web?

The `@oxyhq/services` package supports multiple platforms (Expo, React Native, Node.js, and Web). Instead of pulling in React Native dependencies and using react-native-web aliases, we use the dedicated `/web` entry point that only includes web-compatible code.

This approach is:
- ✅ **Professional**: No react-native aliases or workarounds in Vite config
- ✅ **Clean**: Zero React Native dependencies in the bundle
- ✅ **Fast**: Smaller bundle size, faster builds
- ✅ **Simple**: No polyfills, shims, or special configuration needed

### Configuration

**package.json:**
```json
{
  "dependencies": {
    "@oxyhq/services": "file:../../../../OxyHQServices/packages/services"
  }
}
```

**vite.config.ts:**
```typescript
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
```

That's it! Ultra-clean configuration:
- No react-native aliases
- No global polyfills
- No special esbuild options
- No exclusions or workarounds
- Just standard Vite + React

## Authentication

The admin panel uses **OxyHQ's cross-domain SSO** for authentication with strict authorization.

### How it works

1. **Frontend**: Uses `WebOxyProvider` and `useAuth` from `@oxyhq/services`
2. **Login Flow**: Click "Sign in with Oxy" → redirects to auth.oxy.so → FedCM/popup/redirect → returns with session
3. **Authorization Check**: Only username `nate` is allowed admin access
4. **Backend Validation**: Every API request validates the Oxy token and checks username

### Code

**Frontend** ([src/lib/auth/context.tsx](src/lib/auth/context.tsx)):
```typescript
import { WebOxyProvider, useAuth as useOxyAuth } from '@oxyhq/services/web';

// Check if user is authorized (only "nate" allowed)
const checkAuthorization = (user: User | null): boolean => {
  if (!user) return false;
  return user.username.toLowerCase() === 'nate';
};
```

**Backend** (alia-providers [src/middleware/auth.ts](../alia-providers/src/middleware/auth.ts)):
```typescript
import { OxyServices } from '@oxyhq/services/core';

const oxyServices = new OxyServices({ baseURL: 'https://api.oxy.so' });
const user = await oxyServices.getCurrentUser();

if (user.username.toLowerCase() !== 'nate') {
  return res.status(403).json({ error: 'Access denied' });
}
```

Unauthorized users are automatically signed out after 3 seconds with an error message.

## Real-time Updates

The admin panel uses **WebSocket connections** for live data updates with automatic fallback to HTTP polling.

### Architecture

- **WebSocket Client** ([src/lib/websocket/client.ts](src/lib/websocket/client.ts)): Handles connections, reconnection, heartbeat, and pub/sub channels
- **React Hooks** ([src/lib/websocket/hooks.ts](src/lib/websocket/hooks.ts)): Easy-to-use hooks like `useRealtimeHealth()`, `useRealtimeKeys()`
- **Hybrid Approach**: WebSocket when connected, HTTP polling when disconnected

### Usage Example

```typescript
import { useRealtimeHealth } from '@/lib/websocket/hooks';
import { useQuery } from '@tanstack/react-query';

function MonitoringPage() {
  // WebSocket subscription
  const { data: realtimeData, isConnected } = useRealtimeHealth();

  // HTTP polling fallback (only enabled when WebSocket disconnected)
  const { data: httpData } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: !isConnected ? 10000 : false,
    enabled: !isConnected,
  });

  // Use WebSocket data if available, otherwise HTTP data
  const healthData = realtimeData ?? httpData;
}
```

### WebSocket Features

- **Automatic Reconnection**: Exponential backoff on connection loss
- **Heartbeat**: Detects stale connections and reconnects
- **Channel Subscriptions**: Subscribe to specific data channels (health, keys, models)
- **Status Tracking**: Always know connection state

## Setup

### Prerequisites

- Node.js 18+
- npm or yarn
- Running \`alia-providers\` service
- OxyHQ account (username must be "nate" for admin access)

### Installation

\`\`\`bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
\`\`\`

### Environment Variables

Create a \`.env\` file in the root:

**Development:**
\`\`\`env
# API endpoint for alia-providers service
VITE_API_URL=http://localhost:3002

# WebSocket endpoint (optional, defaults to ws://localhost:3002)
VITE_WS_URL=ws://localhost:3002
\`\`\`

**Production:**
\`\`\`env
VITE_API_URL=https://api.providers.alia.onl
VITE_WS_URL=wss://api.providers.alia.onl
\`\`\`

**Note**: No service secret needed in the frontend! Authentication is handled by OxyHQ tokens.

### Development

\`\`\`bash
# Start development server
npm run dev

# Open browser at http://localhost:5173
\`\`\`

### Production Build

\`\`\`bash
# Build for production
npm run build

# Preview production build
npm run preview
\`\`\`

## Deployment

### Production Domains

- **Admin Panel**: `https://providers.alia.onl`
- **API Service**: `https://api.providers.alia.onl`

The admin panel communicates with the providers API service. Ensure both services are deployed and the admin panel's `VITE_API_URL` environment variable points to the correct API domain.

### Building for Production

1. Set production environment variables in `.env`
2. Install dependencies: `npm install`
3. Build the application: `npm run build`
   - TypeScript compilation happens first (`tsc -b`)
   - Vite bundles and optimizes the code
   - Clean, fast builds with zero React Native dependencies
4. Deploy the `dist/` folder to your hosting service
5. **Authentication**: Login is required - only OxyHQ username "nate" has access

### Deployment Notes

- **No VPN needed**: Authentication is handled by OxyHQ SSO
- **Static hosting**: The `dist/` folder can be served by any static file server (Nginx, Vercel, Netlify, etc.)
- **Environment variables**: Must be set at build time (they're compiled into the bundle)
- **CORS**: Ensure the API service allows requests from the admin panel domain

## Usage

### Dashboard

The main dashboard provides an overview of:
- Total API keys (active, archived)
- Provider health status
- Average success rate
- Failing keys count
- Recent provider health metrics
- Recent API key activity

### Keys Management

Manage provider API keys with full CRUD operations. Features include:
- Free keys are always tried first
- Failed keys automatically move to end of queue
- Successful requests restore original priority
- Archive after 100 total failures

### Models Management

Configure provider models and their capabilities, pricing, and limits.

### Monitoring

Real-time monitoring powered by WebSocket connections (with automatic fallback to HTTP polling). Shows live updates of:
- Provider health and circuit breaker status
- Request latency and success rates
- Key rotation status and priority queues
- Connection status indicator (Live/Reconnecting/Offline)

## License

MIT
