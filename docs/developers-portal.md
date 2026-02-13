# Alia AI Developers Portal

A comprehensive developer portal that allows users to create applications and generate API tokens to integrate Alia AI into their own applications.

## Features

### 1. App Management
- Create and manage multiple applications
- Track app status (active/inactive)
- Store app metadata (name, description, website URL)
- View app creation and update timestamps

### 2. API Key Management
- Generate secure API keys for each app
- Scope-based permissions:
  - `chat:read` - Read chat messages
  - `chat:write` - Send chat messages
  - `models:read` - List available models
  - `conversations:read` - Read conversations
  - `conversations:write` - Create/update conversations
  - `conversations:delete` - Delete conversations
  - `memory:read` - Read user memory/preferences
  - `memory:write` - Update user memory/preferences
- Set expiration dates for keys
- Revoke keys at any time
- Track last usage timestamp

### 3. Usage Analytics
- Real-time usage tracking
- Metrics tracked per app and per API key:
  - Total requests
  - Tokens consumed
  - Credits used
  - Success/error rates
  - Average response time
- Time-based filtering (24h, 7d, 30d, 90d)
- Daily usage breakdowns
- Top endpoints by usage

### 4. Security
- API keys prefixed with `alia_sk_` for easy identification
- Keys are hashed (SHA-256) before storage
- Only the key prefix is shown after creation
- Automatic usage logging with IP and user agent
- 90-day TTL on usage data

## Architecture

### Backend (API)

#### Database Models

**DeveloperApp** (`apps/api/src/models/developer-app.ts`)
```typescript
{
  userId: ObjectId          // Owner of the app
  name: string             // App name
  description?: string     // App description
  websiteUrl?: string      // App website
  redirectUrls: string[]   // OAuth redirect URLs
  icon?: string            // App icon URL
  isActive: boolean        // Active status
}
```

**DeveloperApiKey** (`apps/api/src/models/developer-api-key.ts`)
```typescript
{
  userId: ObjectId         // Key owner
  appId: ObjectId         // Associated app
  name: string            // Key name/label
  keyHash: string         // SHA-256 hash of the key
  keyPrefix: string       // First 16 chars for display
  scopes: string[]        // Permissions
  expiresAt?: Date        // Expiration date
  lastUsedAt?: Date       // Last usage timestamp
  isActive: boolean       // Active status
}
```

**ApiKeyUsage** (`apps/api/src/models/api-key-usage.ts`)
```typescript
{
  apiKeyId: ObjectId
  userId: ObjectId
  appId: ObjectId
  endpoint: string        // API endpoint called
  method: string          // HTTP method
  statusCode: number      // Response status
  tokensUsed?: number     // Tokens consumed
  creditsUsed?: number    // Credits consumed
  responseTime?: number   // Response time in ms
  userAgent?: string
  ipAddress?: string
  authType: 'api_key' | 'session' | 'internal'  // Auth method used
  serviceApp?: string     // Service app name (for internal auth)
  timestamp: Date
}
```

#### API Routes (`/developer`)

**Apps Management**
- `GET /developer/apps` - List all apps for the user
- `GET /developer/apps/:id` - Get a specific app
- `POST /developer/apps` - Create a new app
- `PATCH /developer/apps/:id` - Update an app
- `DELETE /developer/apps/:id` - Delete an app

**API Keys Management**
- `GET /developer/apps/:appId/keys` - List all keys for an app
- `POST /developer/apps/:appId/keys` - Create a new API key
- `PATCH /developer/apps/:appId/keys/:keyId` - Update a key
- `DELETE /developer/apps/:appId/keys/:keyId` - Delete a key

**Usage Analytics**
- `GET /developer/apps/:appId/usage?period=7d` - Get app usage stats
- `GET /developer/apps/:appId/keys/:keyId/usage?period=7d` - Get key usage stats
- `GET /developer/stats` - Get overall developer stats

#### Authentication Middleware

**JWT Authentication** (`authenticateToken`)
- Validates Bearer JWT tokens (including service tokens)
- Used for user-facing endpoints
- Service tokens (type: 'service') are recognized automatically — sets `req.serviceApp`

**API Key Authentication** (`authenticateApiKey`)
- Validates Bearer API keys (format: `alia_sk_...`)
- Checks key validity, expiration, and scopes
- Logs usage automatically
- Updates last used timestamp

**Service Token Authentication** (`oxyServiceAuth`)
- Only allows Oxy service tokens (rejects user JWTs and API keys)
- Used for internal-only endpoints (`/internal/trigger`)
- Sets `req.serviceApp` with `{ appId, appName }`
- User delegation via `X-Oxy-User-Id` header

**Hybrid Authentication** (`authenticateTokenOrApiKey`)
- Accepts both JWT tokens and API keys
- Applied to `/v1/*` endpoints for backward compatibility
- Automatically detects token type

**Scope Validation** (`requireScope`)
- Middleware factory for scope-based authorization
- Example: `requireScope('chat:write')`

#### Internal Trigger Endpoint

**`POST /internal/trigger`** — Autonomous AI processing for internal services.

Auth: Service tokens only (via `oxyServiceAuth`). No credits charged.

```bash
curl -X POST https://api.alia.onl/internal/trigger \
  -H "Authorization: Bearer <service-token>" \
  -H "X-Oxy-User-Id: <userId>" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "email.received",
    "data": { "subject": "Meeting at 3pm", "from": "boss@company.com" },
    "instructions": "Notify user if urgent"
  }'
```

Response:
```json
{
  "event": "email.received",
  "response": "I notified the user via Telegram about the meeting.",
  "toolCalls": [{ "tool": "sendTelegramMessage", "args": { "message": "..." } }],
  "usage": { "promptTokens": 150, "completionTokens": 80, "totalTokens": 230 },
  "responseTime": 1200
}
```

Available tools: `sendTelegramMessage`, `saveUserMemory`, `updateUserPreferences`, `updateUserContext`, `getCurrentDate`, `scrapeURL`, `googleSearch`.

### Frontend (Mobile App)

#### Pages

**Main Portal** (`app/(developers)/index.tsx`)
- Dashboard with overview statistics
- Quick access to create apps
- List of user's apps
- Quick links to documentation and examples

**Create App** (`app/(developers)/apps/new.tsx`)
- Form to create a new application
- Fields: name, description, website URL

**App Detail** (`app/(developers)/apps/[id].tsx`)
- App information and metadata
- API key management (create, list, delete)
- Link to usage statistics
- Delete app (danger zone)

**Usage Statistics** (`app/(developers)/apps/[id]/usage.tsx`)
- Overview metrics (requests, tokens, success rate, avg response time)
- Time period selector (24h, 7d, 30d, 90d)
- Daily usage breakdown
- Top endpoints by usage

**Documentation** (`app/(developers)/documentation.tsx`)
- Quick start guide
- Authentication examples
- API endpoint documentation
- Base URL reference

**Examples** (`app/(developers)/examples.tsx`)
- Code samples in JavaScript, Python, and cURL
- Integration patterns
- Best practices

#### State Management

**DeveloperStore** (`lib/stores/developer-store.ts`)
- Zustand store with AsyncStorage persistence
- Manages apps, API keys, and usage stats
- Loading states and error handling
- Actions for CRUD operations

#### Navigation

Added "Developers" link to sidebar navigation with Code icon.

## Usage

### For End Users

1. **Create an App**
   - Navigate to Developers → Create New App
   - Fill in app name and optional details
   - Click "Create App"

2. **Generate API Key**
   - Open your app from the Developers portal
   - Click "New Key"
   - Enter a name (e.g., "Production", "Development")
   - Select scopes/permissions
   - Click "Create"
   - **Important:** Copy the API key immediately - you won't see it again!

3. **Use the API Key**
   ```bash
   curl -X POST https://api.alia.onl/v1/chat/completions \
     -H "Authorization: Bearer alia_sk_your_api_key_here" \
     -H "Content-Type: application/json" \
     -d '{
       "messages": [
         {"role": "user", "content": "Hello, Alia!"}
       ]
     }'
   ```

4. **Monitor Usage**
   - View real-time usage statistics in the app detail page
   - Track requests, tokens, and response times
   - Identify top endpoints
   - Monitor success/error rates

### For Developers

#### Testing API Key Authentication

```javascript
// Using fetch
const response = await fetch('https://api.alia.onl/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer alia_sk_your_key_here',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    messages: [
      { role: 'user', content: 'Hello!' }
    ]
  })
});
```

#### Available Endpoints

All `/v1/*` endpoints support API key authentication:

- `POST /v1/chat/completions` - Send chat messages
- `GET /v1/models` - List available models

#### Scopes Required

| Endpoint | Required Scope |
|----------|---------------|
| `/v1/chat/completions` | `chat:write` |
| `/v1/models` | `models:read` |

## Security Considerations

1. **Key Storage**
   - Keys are hashed with SHA-256 before database storage
   - Only the key prefix (first 16 chars) is stored in plaintext for display
   - Keys are only shown in full once during creation

2. **Key Format**
   - All API keys follow the format: `alia_sk_` + 43 random URL-safe base64 characters
   - Total length: ~51 characters
   - Easily identifiable and prevents accidental exposure

3. **Usage Tracking**
   - All API key requests are logged with:
     - Endpoint, method, status code
     - Tokens and credits used
     - Response time
     - User agent and IP address
   - Usage data automatically expires after 90 days

4. **Expiration**
   - Keys can optionally have expiration dates
   - Expired keys are automatically rejected
   - No automatic cleanup - expired keys remain in database for audit

5. **Revocation**
   - Keys can be revoked instantly by setting `isActive: false` or deleting
   - Deleting a key also deletes all associated usage data

## Database Indexes

For optimal performance, the following indexes are created:

**DeveloperApp**
- `{ userId: 1, isActive: 1 }` - User app lookups

**DeveloperApiKey**
- `{ keyHash: 1 }` - Unique, for key validation
- `{ userId: 1, isActive: 1 }` - User key listings
- `{ appId: 1, isActive: 1 }` - App key listings

**ApiKeyUsage**
- `{ apiKeyId: 1, timestamp: -1 }` - Key usage queries
- `{ userId: 1, timestamp: -1 }` - User usage queries
- `{ appId: 1, timestamp: -1 }` - App usage queries
- `{ timestamp: 1 }` - TTL index (90 days)

## Future Enhancements

Potential additions to the developers portal:

1. **OAuth 2.0 Support**
   - Authorization code flow
   - Client credentials flow
   - Redirect URI validation

2. **Rate Limiting**
   - Per-app rate limits
   - Per-key rate limits
   - Tiered pricing based on usage

3. **Webhooks**
   - Event notifications
   - Webhook signature validation
   - Retry logic

4. **SDK Generation**
   - Auto-generated client libraries
   - Code snippets in multiple languages
   - Interactive API explorer

5. **Team Management**
   - Share apps with team members
   - Role-based permissions
   - Audit logs

6. **Billing Integration**
   - Usage-based pricing
   - Credit system
   - Payment processing

## Troubleshooting

### API Key Not Working

1. Check if the key is active
2. Verify the key hasn't expired
3. Ensure the app is active
4. Check if you have the required scopes
5. Verify you're using the correct Authorization header format

### Usage Stats Not Updating

1. Usage data is logged asynchronously after response
2. Allow a few seconds for stats to appear
3. Check if the API key authentication succeeded (200-299 status codes log usage)

### Creating API Key Fails

1. Verify the app exists and belongs to you
2. Check that you're authenticated
3. Ensure all required fields are provided
4. Check app is active

## License

This feature is part of the Alia AI platform.
