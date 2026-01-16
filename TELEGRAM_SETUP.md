# Telegram Bot Quick Setup Guide

This guide will help you quickly set up the Alia Telegram bot with simplified authentication.

## Quick Start (5 minutes)

### 1. Get Your Bot Token

1. Open Telegram and find [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Follow prompts to create your bot
4. Copy the HTTP API token

### 2. Configure the Bot

```bash
cd apps/telegram-bot
cp .env.example .env
```

Edit `.env`:
```env
TELEGRAM_BOT_TOKEN=paste_your_token_here
MONGODB_URI=mongodb://localhost:27017/alia
API_BASE_URL=http://localhost:3001
```

### 3. Configure the API Server

Edit `apps/api/.env`:
```env
# Add this to your existing .env file
APP_URL=http://localhost:3000  # or your app's URL
```

### 4. Install and Run

```bash
# From project root
npm install

# Start API server (in one terminal)
npm run dev:api

# Start Telegram bot (in another terminal)
npm run dev:telegram
```

### 5. Test It

1. Find your bot in Telegram (search for the username you created)
2. Send any message (e.g., "Hello")
3. Bot will send you an authentication link
4. Click the link (opens your app)
5. Sign in on the app
6. Return to Telegram and chat!

## Authentication Flow

### User Experience

1. **User sends first message** to the bot (any message)
2. **Bot responds** with authentication link
3. **User clicks link** → Opens app/web
4. **User signs in** (or is already logged in)
5. **App confirms** linkage with API
6. **User returns** to Telegram
7. **Bot recognizes user** and can access their memory, preferences, etc.

### Technical Flow

```
┌─────────┐          ┌──────────────┐          ┌─────────┐          ┌─────────┐
│ User    │          │ Telegram Bot │          │ API     │          │ App/Web │
└────┬────┘          └──────┬───────┘          └────┬────┘          └────┬────┘
     │                      │                       │                     │
     │───"Hello"───────────>│                       │                     │
     │                      │                       │                     │
     │                      │──Create auth token───>│                     │
     │                      │<─Token: ABC123────────│                     │
     │                      │                       │                     │
     │<──Auth link──────────│                       │                     │
     │   (click to app)     │                       │                     │
     │                      │                       │                     │
     │──────────────────────────────────────────────────Open app────────>│
     │                      │                       │                     │
     │<─────────────────────────────────────────────────Login screen──────│
     │                      │                       │                     │
     │──────────────────────────────────────────────────Credentials──────>│
     │                      │                       │                     │
     │                      │                       │<──Login & Link──────│
     │                      │                       │   (token + JWT)     │
     │                      │                       │                     │
     │                      │                       │──Success───────────>│
     │                      │                       │                     │
     │<─────────────────────────────────────────────────"Linked!"─────────│
     │                      │                       │                     │
     │──Return to Telegram──────────────────────────────────────────────>│
     │                      │                       │                     │
     │───"How are you?"────>│                       │                     │
     │                      │──Chat (with JWT)─────>│                     │
     │                      │<──Response────────────│                     │
     │<──AI response────────│                       │                     │
```

## API Endpoints for App Integration

Your app needs to handle these endpoints:

### 1. Authentication Route
```
GET /telegram-auth?token=ABC123
```

When a user clicks the Telegram auth link, they'll be redirected to this route in your app.

**What your app should do:**
1. Extract the `token` parameter
2. Check if user is logged in
   - If yes: Call API to link account
   - If no: Show login screen, then link after login
3. Call `POST /telegram/link` with token and JWT
4. Show success message
5. User can return to Telegram

### 2. Verify Token (Optional)
```
GET /api/telegram/check-token/:token
```

Response:
```json
{
  "valid": true,
  "expiresAt": "2024-01-01T12:00:00.000Z"
}
```

### 3. Link Account
```
POST /api/telegram/link
```

Body:
```json
{
  "authToken": "ABC123",
  "sessionToken": "user-jwt-token"
}
```

Response:
```json
{
  "success": true,
  "message": "Account linked successfully"
}
```

## Example App Implementation

### React/Next.js Example

```typescript
// pages/telegram-auth.tsx or app/telegram-auth/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function TelegramAuth() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [status, setStatus] = useState('checking');

  useEffect(() => {
    async function linkAccount() {
      if (!token) {
        setStatus('error');
        return;
      }

      try {
        // Get user's JWT token (from your auth system)
        const sessionToken = localStorage.getItem('authToken');

        if (!sessionToken) {
          // User not logged in - redirect to login with return URL
          router.push(`/login?returnTo=/telegram-auth?token=${token}`);
          return;
        }

        // Link the Telegram account
        const response = await fetch('/api/telegram/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authToken: token, sessionToken }),
        });

        if (response.ok) {
          setStatus('success');
        } else {
          setStatus('error');
        }
      } catch (error) {
        console.error('Link error:', error);
        setStatus('error');
      }
    }

    linkAccount();
  }, [token, router]);

  return (
    <div style={{ textAlign: 'center', padding: '2rem' }}>
      {status === 'checking' && <p>Linking your Telegram account...</p>}
      {status === 'success' && (
        <>
          <h1>✅ Success!</h1>
          <p>Your Telegram account has been linked.</p>
          <p>You can now return to Telegram and start chatting with Alia!</p>
        </>
      )}
      {status === 'error' && (
        <>
          <h1>❌ Error</h1>
          <p>Failed to link your account. Please try again.</p>
        </>
      )}
    </div>
  );
}
```

### React Native Example

```typescript
// screens/TelegramAuthScreen.tsx
import React, { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { useRoute } from '@react-navigation/native';

export default function TelegramAuthScreen() {
  const route = useRoute();
  const token = route.params?.token;
  const [status, setStatus] = useState('checking');

  useEffect(() => {
    async function linkAccount() {
      if (!token) {
        setStatus('error');
        return;
      }

      try {
        // Get user's JWT token (from your auth context/storage)
        const sessionToken = await AsyncStorage.getItem('authToken');

        if (!sessionToken) {
          // Navigate to login screen
          navigation.navigate('Login', { returnTo: 'TelegramAuth', token });
          return;
        }

        // Link the Telegram account
        const response = await fetch('http://localhost:3001/telegram/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authToken: token, sessionToken }),
        });

        if (response.ok) {
          setStatus('success');
        } else {
          setStatus('error');
        }
      } catch (error) {
        console.error('Link error:', error);
        setStatus('error');
      }
    }

    linkAccount();
  }, [token]);

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      {status === 'checking' && <Text>Linking your Telegram account...</Text>}
      {status === 'success' && (
        <>
          <Text style={{ fontSize: 24 }}>✅ Success!</Text>
          <Text>Your Telegram account has been linked.</Text>
          <Text>Return to Telegram and start chatting!</Text>
        </>
      )}
      {status === 'error' && (
        <>
          <Text style={{ fontSize: 24 }}>❌ Error</Text>
          <Text>Failed to link account. Please try again.</Text>
        </>
      )}
    </View>
  );
}
```

## Available Commands

| Command | Description |
|---------|-------------|
| `/start` | Get authentication link |
| `/status` | Check account status and credits |
| `/logout` | Disconnect account |
| `/new` | Start a new conversation |
| `/history` | View conversation history |
| `/help` | Show help message |

## Troubleshooting

### Bot doesn't respond
- Check if bot is running: `ps aux | grep node`
- Verify bot token is correct
- Check MongoDB connection
- Ensure API server is running

### Can't authenticate
- Verify APP_URL is set correctly in `apps/api/.env`
- Check that your app has the `/telegram-auth` route
- Ensure token hasn't expired (15 min limit)

### Messages not working
- Check user is authenticated: `/status`
- Verify API server can reach AI providers
- Check user has credits

### App doesn't receive redirect
- Make sure APP_URL environment variable is set
- Check that the URL scheme is supported (https:// or your app's custom scheme)
- Verify redirect endpoint exists in your app

## Production Deployment

1. **Set production URLs:**
   ```env
   APP_URL=https://app.alia.com
   ```

2. **Build the bot:**
   ```bash
   npm run build:telegram
   ```

3. **Run with PM2:**
   ```bash
   pm2 start dist/index.js --name alia-telegram-bot
   pm2 save
   ```

## Security Notes

- ✅ Auth codes expire in 15 minutes
- ✅ Tokens are single-use
- ✅ JWT tokens validate on each request
- ✅ User input is sanitized
- ⚠️ Never commit `.env` files
- ⚠️ Use HTTPS in production

## Next Steps

- [ ] Get bot token from BotFather
- [ ] Configure `.env` file
- [ ] Add `/telegram-auth` route to your app
- [ ] Implement token linking in your app
- [ ] Start API server
- [ ] Start Telegram bot
- [ ] Test with a message

For detailed documentation, see [apps/telegram-bot/README.md](apps/telegram-bot/README.md)
