# Alia Telegram Bot

A Telegram bot that allows users to chat with Alia AI assistant directly from Telegram with user authentication and conversation management.

## Features

- **Secure Authentication**: Users authenticate via web link or direct login command
- **Seamless Chat**: Natural conversation flow with Alia AI
- **Conversation Management**: Start new conversations and view history
- **Account Status**: Check credits and account information
- **Real-time Streaming**: Progressive message updates as AI responds

## Prerequisites

- Node.js 18+ and npm
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- Running Alia API server (apps/api)

**Note**: The bot communicates entirely through the API server. It doesn't need direct database access.

## Setup

### 1. Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the instructions
3. Choose a name for your bot (e.g., "Alia AI")
4. Choose a username (must end in 'bot', e.g., "alia_ai_bot")
5. Copy the HTTP API token provided by BotFather

### 2. Configure Environment Variables

```bash
cd apps/telegram-bot
cp .env.example .env
```

Edit `.env` and add your configuration:

```env
# Telegram Bot Token from BotFather
TELEGRAM_BOT_TOKEN=your_bot_token_here

# API Server URL (Required)
API_BASE_URL=http://localhost:3001
```

### 3. Install Dependencies

**Important**: This bot is part of a monorepo. Install dependencies from the root:

```bash
cd /path/to/ai-api-server
npm install
```

### 4. Start the Bot

Make sure the API server is running first, then start the bot:

```bash
# From monorepo root
npm run dev:telegram

# Or from telegram-bot directory
npm run dev
```

## Usage

### User Flow

1. **Start the bot**: User sends `/start` to the bot
2. **Get auth link**: Bot provides a unique authentication link
3. **Sign in**: User clicks link, opens Alia app/web, and signs in
4. **Return to Telegram**: After signing in, account is linked
5. **Chat**: User can now chat with Alia directly in Telegram with full memory and context

### Available Commands

- `/start` - Initialize bot and get authentication link
- `/status` - View account status and credits
- `/logout` - Disconnect Telegram account
- `/new` - Start a new conversation
- `/history` - View recent conversations
- `/help` - Show help message

### Example Conversation

```
User: /start
Bot: 👋 Hi! To chat with me, please authenticate your Alia account.

Click the link below to sign in:
https://alia.onl/telegram-auth?token=A1B2C3

This link will expire in 15 minutes.

[User clicks link, signs in on alia.onl, returns to Telegram]

User: Hello, who are you?
Bot: I'm Alia, your AI assistant! I'm here to help you with questions,
tasks, creative writing, coding, and much more. How can I assist you today?
```

## Architecture

### Components

- **Bot Service** (`src/index.ts`): Main bot initialization and command routing
- **Auth Handlers** (`src/handlers/auth.ts`): Authentication flow management
- **Chat Handlers** (`src/handlers/chat.ts`): Message handling and AI interaction
- **Command Handlers** (`src/handlers/commands.ts`): Bot command processing
- **API Client** (`src/services/api-client.ts`): Communication with Alia API

**Note**: The bot doesn't directly access MongoDB. All data is managed through the API server.

### Authentication Flow

```
┌─────────┐          ┌──────────────┐          ┌─────────┐
│ Telegram│          │ Telegram Bot │          │ API     │
│ User    │          │              │          │ Server  │
└────┬────┘          └──────┬───────┘          └────┬────┘
     │                      │                       │
     │──────/start─────────>│                       │
     │                      │                       │
     │<──Auth Code & Link───│                       │
     │                      │                       │
     │────Click Link───────────────────────────────>│
     │                      │                       │
     │<──────────────Web Login Form─────────────────│
     │                      │                       │
     │──Email + Password───────────────────────────>│
     │                      │                       │
     │                      │<──Link Accounts───────│
     │                      │                       │
     │<──Authenticated─────>│                       │
     │                      │                       │
     │────Chat Message─────>│                       │
     │                      │                       │
     │                      │──Forward to AI───────>│
     │                      │                       │
     │                      │<──Stream Response─────│
     │                      │                       │
     │<──AI Response────────│                       │
```

### Data Model

**TelegramUser Collection:**
```typescript
{
  telegramId: string;        // Telegram user ID
  userId: ObjectId;          // Reference to API User
  chatId: string;            // Telegram chat ID
  username?: string;         // Telegram username
  firstName?: string;        // User's first name
  lastName?: string;         // User's last name
  authToken?: string;        // Temporary auth code
  authTokenExpiry?: Date;    // Auth code expiration
  sessionToken?: string;     // API JWT token
  conversationId?: string;   // Current conversation
  isAuthenticated: boolean;  // Auth status
  linkedAt?: Date;           // When account was linked
  createdAt: Date;
  updatedAt: Date;
}
```

## API Integration

The bot communicates with the main API server through:

- `/auth/login` - User authentication
- `/auth/me` - Token verification
- `/alia/chat` - Chat streaming
- `/conversations` - Conversation management
- `/credits` - Credit information
- `/telegram/verify` - Web authentication page
- `/telegram/link` - Account linking endpoint

## Development

### Run in Development Mode

```bash
npm run dev
```

This uses `tsx watch` for hot reloading during development.

### Build for Production

```bash
npm run build
```

### Start Production Server

```bash
npm start
```

## Deployment

### DigitalOcean App Platform (Recommended)

**App Platform Configuration:**

1. **Source Directory**: `.` (build from root for monorepo support)
2. **Build Command**: `npm install && npm run build:telegram`
3. **Run Command**: `npm run start:telegram`
4. **Resource Type**: Worker
5. **Environment Variables**:
   - `TELEGRAM_BOT_TOKEN`: Your bot token from BotFather
   - `API_BASE_URL`: Your API server URL (e.g., `https://api.alia.com`)

**IMPORTANT: API Server Environment Variables**

Your API server also needs this environment variable for telegram authentication to work:
- `APP_URL`: Your app URL (e.g., `https://alia.onl`)

This is used to generate the authentication redirect link that users click.

**Why build from root?** This is an npm workspaces monorepo, so dependencies must be installed from the root directory.

### Using PM2 on VPS

```bash
# From monorepo root
npm install
npm run build:telegram
pm2 start apps/telegram-bot/dist/index.js --name alia-telegram-bot
pm2 save
pm2 startup
```

## Security Considerations

1. **Never commit `.env` file** - Keep bot token secret
2. **Use HTTPS for webhook** (if implementing webhook mode)
3. **Validate user input** - All inputs are sanitized
4. **Token expiration** - Auth codes expire after 15 minutes
5. **Rate limiting** - Inherits rate limits from API server

## Production Deployment

### Deploy to DigitalOcean

See detailed guides:
- **[Quick Deploy Guide](./DEPLOY_QUICK.md)** - 5-minute deployment to App Platform
- **[Full Deployment Guide](../../DEPLOY_TELEGRAM.md)** - Complete guide with all options

**Recommended**: Use DigitalOcean App Platform ($5/month)
1. Push code to Git
2. Create Worker app on App Platform
3. Set environment variables
4. Deploy!

### Deploy to Other Platforms

The bot can run anywhere Node.js is supported:
- **Heroku**: Use worker dyno
- **Railway**: Deploy from Git (monorepo support)
- **Render**: Use background worker
- **AWS**: EC2 or ECS
- **Azure**: Container Instances
- **VPS**: Any provider with Node.js support (use PM2)

## Troubleshooting

### Bot doesn't respond

- Check if bot is running: `ps aux | grep node` or check platform logs
- Verify bot token is correct
- Ensure API server is running
- Test API: `curl https://your-api-url.com/health`

### Authentication fails

- Verify API_BASE_URL is correct (should be your API server URL)
- Check APP_URL is set in API server `.env`
- Ensure `/telegram` routes are registered in API server
- Check auth token hasn't expired (15 min limit)
- Verify `/telegram-auth` screen exists in your app

### Messages not reaching Alia

- Check user is authenticated: Send `/status` command
- Verify API server can reach AI providers
- Ensure user has credits
- Check API server logs for errors

### Connection errors

- Verify API_BASE_URL is accessible
- Test: `curl https://your-api-url.com/telegram/users/test`
- Check firewall settings if using VPS
- Ensure HTTPS is working (for production)

## Contributing

1. Create a feature branch
2. Make your changes
3. Test thoroughly with a test bot
4. Submit a pull request

## License

MIT

## Support

For issues and questions:
- GitHub Issues: [Your repo URL]
- Email: [Your support email]
