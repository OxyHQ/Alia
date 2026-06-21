# Real-Time WebSocket Implementation

This document describes the real-time WebSocket implementation for the Alia Gateway Admin panel.

## Overview

The admin panel now uses WebSocket connections for real-time data updates instead of HTTP polling. This provides:

- **Sub-second latency**: Data updates appear instantly instead of waiting 10-60 seconds
- **Reduced server load**: No more constant polling requests
- **Better UX**: Live status indicators and instant feedback
- **Automatic reconnection**: Handles network issues gracefully with exponential backoff
- **Graceful degradation**: Falls back to HTTP polling if WebSocket is unavailable

## Architecture

### Client-Side Components

1. **WebSocket Client** ([lib/websocket/client.ts](./src/lib/websocket/client.ts))
   - Manages persistent WebSocket connection
   - Handles automatic reconnection with exponential backoff
   - Implements heartbeat/ping-pong to detect stale connections
   - Provides pub/sub pattern for message routing

2. **React Hooks** ([lib/websocket/hooks.ts](./src/lib/websocket/hooks.ts))
   - `useConnectionStatus()` - Track connection state
   - `useRealtimeHealth()` - Subscribe to provider health updates
   - `useRealtimeKeys()` - Subscribe to API keys updates
   - `useRealtimeModels()` - Subscribe to model config updates
   - `useRealtimeSend()` - Send messages to server
   - `useRealtimeReconnect()` - Manually trigger reconnection

3. **Provider Component** ([lib/websocket/provider.tsx](./src/lib/websocket/provider.tsx))
   - Initializes WebSocket connection on app mount
   - Cleans up connection on unmount
   - Makes connection available throughout app via Context

4. **Connection Status Indicator** ([components/ConnectionStatus.tsx](./src/components/ConnectionStatus.tsx))
   - Visual indicator in sidebar showing connection state
   - Shows: Live (green), Connecting (blue), Reconnecting (yellow), Offline (red)
   - Click to manually reconnect when offline

### Pages Updated

All pages now use real-time data:

- **Dashboard** ([pages/Dashboard.tsx](./src/pages/Dashboard.tsx)) - Real-time health and keys overview
- **Keys** ([pages/Keys.tsx](./src/pages/Keys.tsx)) - Live key status and metrics
- **Models** ([pages/Models.tsx](./src/pages/Models.tsx)) - Real-time model configurations
- **Monitoring** ([pages/Monitoring.tsx](./src/pages/Monitoring.tsx)) - Live health monitoring dashboard

### Hybrid Approach (Real-time + Fallback)

Each page uses a hybrid approach:

```typescript
// Real-time subscription (primary)
const { data: realtimeData, isConnected } = useRealtimeHealth();

// HTTP polling fallback (only when WebSocket disconnected)
const { data: polledData } = useQuery({
  queryKey: ['provider-health'],
  queryFn: () => apiClient.getAllProviderHealth(),
  refetchInterval: isConnected ? false : 30000, // Poll only if WS disconnected
  enabled: !isConnected, // Disable when WS connected
});

// Use real-time data if available, otherwise fall back
const data = realtimeData || polledData;
```

## Backend Requirements

The backend needs to implement a WebSocket server to enable real-time functionality.

### WebSocket Endpoint

**URL**: `ws://localhost:3001/internal/gateway/ws` (derived from `VITE_GATEWAY_API_URL`)

### Message Protocol

All messages are JSON-formatted with this structure:

```typescript
interface WebSocketMessage {
  type: string;          // Message type (subscribe, unsubscribe, ping, pong, error, update)
  channel?: string;      // Channel name for pub/sub
  data?: any;           // Message payload
  error?: string;       // Error message (if type === 'error')
}
```

### Client → Server Messages

#### 1. Subscribe to Channel
```json
{
  "type": "subscribe",
  "channel": "health:all"
}
```

Channels:
- `health:all` - All provider health updates
- `health:{provider}` - Health for specific provider (e.g., `health:openai`)
- `health:{provider}:{modelId}` - Health for specific model (e.g., `health:openai:gpt-4`)
- `keys:all` - All API keys updates
- `keys:{provider}` - Keys for specific provider
- `models:all` - All model configs
- `models:{provider}` - Models for specific provider

#### 2. Unsubscribe from Channel
```json
{
  "type": "unsubscribe",
  "channel": "health:all"
}
```

#### 3. Heartbeat (Ping)
```json
{
  "type": "ping"
}
```

### Server → Client Messages

#### 1. Pong Response
```json
{
  "type": "pong"
}
```

#### 2. Data Updates
```json
{
  "type": "health:update",
  "channel": "health:all",
  "data": {
    "data": [
      {
        "provider": "openai",
        "modelId": "gpt-4",
        "isHealthy": true,
        "successRate": 98.5,
        "averageLatencyMs": 1250,
        "totalRequests": 1523,
        "circuitState": "closed",
        "lastRequestAt": "2026-01-27T10:30:45.123Z"
      }
    ]
  }
}
```

```json
{
  "type": "keys:update",
  "channel": "keys:all",
  "data": {
    "data": [
      {
        "_id": "key123",
        "name": "OpenAI Production",
        "provider": "openai",
        "keyPrefix": "sk-proj-****",
        "isActive": true,
        "isArchived": false,
        "isPaid": true,
        "currentPriority": 1,
        "originalPriority": 1,
        "successCount": 450,
        "totalRequests": 500,
        "totalFailures": 50,
        "consecutiveFailures": 0
      }
    ]
  }
}
```

```json
{
  "type": "models:update",
  "channel": "models:all",
  "data": {
    "data": [
      {
        "provider": "openai",
        "modelId": "gpt-4",
        "displayName": "GPT-4",
        "pricing": {
          "inputCostPerMillion": 30,
          "outputCostPerMillion": 60
        },
        "capabilities": {
          "maxInputTokens": 128000,
          "maxOutputTokens": 16384,
          "supportsStreaming": true,
          "supportsTools": true,
          "supportsVision": true,
          "supportsJsonMode": true,
          "supportsPdf": false,
          "urlContext": false,
          "thinkingLevel": "NONE"
        }
      }
    ]
  }
}
```

#### 3. Error Messages
```json
{
  "type": "error",
  "error": "Invalid channel: health:invalid"
}
```

### Implementation Notes

1. **Broadcast on Data Changes**
   - When health check completes → broadcast to `health:*` channels
   - When key is created/updated/deleted → broadcast to `keys:*` channels
   - When model is created/updated/deleted → broadcast to `models:*` channels
   - When circuit breaker state changes → broadcast to `health:*` channels
   - When key rotation occurs → broadcast to `keys:*` channels

2. **Channel Filtering**
   - Clients subscribe to specific channels
   - Server only sends updates matching subscribed channels
   - Use Redis pub/sub if scaling to multiple server instances

3. **Authentication**
   - WebSocket connection should validate same auth headers as HTTP API
   - Check `X-Service-Name`, `X-Timestamp`, `X-Signature` headers during handshake
   - Close connection if authentication fails

4. **Heartbeat**
   - Client sends ping every 30 seconds
   - Server should respond with pong within 5 seconds
   - Client reconnects if no pong received

5. **Connection Limits**
   - Consider limiting concurrent WebSocket connections per client
   - Implement rate limiting for subscribe/unsubscribe messages

## Configuration

### Environment Variables

- `VITE_GATEWAY_API_URL` - Base HTTP URL (e.g., `http://localhost:3001/internal/gateway`)
  - WebSocket URL is automatically derived by replacing `http` with `ws` and appending `/ws`

## Testing

### Manual Testing

1. **Start the app**: `npm run dev`
2. **Check connection status**: Look for green "Live" badge in sidebar
3. **Test reconnection**: Stop backend, observe "Reconnecting" state, restart backend
4. **Verify real-time updates**: Make changes via API and see instant updates in UI

### Backend Testing

If the WebSocket server is not yet implemented:

1. Connection will fail and show "Offline" badge
2. App automatically falls back to HTTP polling (30-60 second intervals)
3. All functionality still works, just not real-time

## Performance Benefits

### Before (HTTP Polling)
- Dashboard: 2 requests every 30-60 seconds = ~3-4 requests/minute
- Monitoring: 2 requests every 10 seconds = ~12 requests/minute
- Keys: 1 request every 30 seconds = ~2 requests/minute
- Models: 2 requests every 60 seconds = ~2 requests/minute
- **Total: ~19-20 requests/minute per user**

### After (WebSocket)
- 1 WebSocket connection per user
- Data pushed only when changes occur
- Heartbeat ping every 30 seconds = ~2 messages/minute
- **Total: ~2-10 messages/minute depending on data change frequency**

### Latency Improvement
- **Before**: 10-60 seconds to see updates (depending on page)
- **After**: Sub-second updates (typically < 100ms)

## Future Enhancements

1. **Optimistic Updates**: Update UI immediately on mutations, reconcile with server response
2. **Conflict Resolution**: Handle concurrent edits from multiple users
3. **Activity Feed**: Show live activity log of all changes
4. **Multi-User Awareness**: Show who else is viewing/editing
5. **Detailed Request Telemetry**: Stream individual request logs in real-time
6. **Alerts & Notifications**: Push critical alerts via WebSocket

## Troubleshooting

### Connection Fails Immediately
- Check `VITE_GATEWAY_API_URL` is set correctly
- Verify backend WebSocket server is running on `/ws` endpoint
- Check browser console for WebSocket errors

### Constant Reconnecting
- Backend may not be responding to ping messages
- Check for firewall/proxy blocking WebSocket connections
- Verify backend implements pong response

### Data Not Updating
- Check browser console for subscription messages
- Verify backend is broadcasting updates on correct channels
- Check data format matches expected structure

### High Memory Usage
- Check for WebSocket message handler leaks
- Verify components properly unsubscribe on unmount
- Monitor browser DevTools → Performance → Memory

## Dependencies

### Production
- Native WebSocket API (built into browsers)
- React hooks for state management

### Development
- `@radix-ui/react-tooltip` - Tooltip component for connection status

No additional WebSocket client libraries required - uses browser's native WebSocket API.
