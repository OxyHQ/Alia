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

- **Framework**: Vite + React 18
- **Language**: TypeScript
- **UI Components**: shadcn/ui (Radix UI primitives)
- **Styling**: Tailwind CSS
- **Data Fetching**: TanStack Query (React Query)
- **Charts**: Recharts
- **Routing**: React Router v7
- **Icons**: Lucide React

## Setup

### Prerequisites

- Node.js 18+
- npm or yarn
- Running \`alia-providers\` service

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
VITE_PROVIDERS_API_URL=http://localhost:3002
VITE_SERVICE_SECRET=your-secret-key
\`\`\`

**Production:**
\`\`\`env
VITE_PROVIDERS_API_URL=https://api.providers.alia.onl
VITE_SERVICE_SECRET=your-production-secret-key
\`\`\`

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

The admin panel communicates with the providers API service. Ensure both services are deployed and the admin panel's `VITE_PROVIDERS_API_URL` environment variable points to the correct API domain.

### Building for Production

1. Set production environment variables in `.env`
2. Build the application: `npm run build`
3. Deploy the `dist/` folder to your hosting service
4. Ensure the admin panel is behind proper authentication/VPN

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

Real-time monitoring with auto-refresh every 10 seconds showing provider health, latency, and key rotation status.

## License

MIT
