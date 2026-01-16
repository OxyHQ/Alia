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

From the monorepo root:

```bash
npm install
```

Or directly in the telegram-bot directory:

```bash
cd apps/telegram-bot
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
2. **Authenticate**: User receives an auth code and link to authenticate
3. **Login**: User clicks the link and enters email/password
4. **Chat**: User can now chat with Alia directly in Telegram

### Available Commands

- `/start` - Initialize bot and get authentication instructions
- `/login <email> <password>` - Direct login (alternative to web auth)
- `/status` - View account status and credits
- `/logout` - Disconnect Telegram account
- `/new` - Start a new conversation
- `/history` - View recent conversations
- `/help` - Show help message

### Example Conversation

```
User: /start
Bot: 👋 Welcome to Alia AI!

To start chatting, you need to authenticate your account.

🔐 Authentication Code: A1B2C3

Please click the link below to authenticate:
http://localhost:3001/telegram/verify?token=A1B2C3

Or use the command:
/login <email> <password>

This code will expire in 15 minutes.

User: /login user@example.com mypassword
Bot: ✅ Successfully authenticated!

Welcome User! You can now start chatting with me.

Just send me a message and I'll respond!

User: Hello, who are you?
Bot: I'm Alia, your AI assistant! I'm here to help you with questions,
tasks, creative writing, coding, and much more. How can I assist you today?
```

## Architecture

### Components

- **Bot Service** (`src/index.ts`): Main bot initialization and command routing
- **Auth Handlers** (`src/handlers/auth.ts`): Authentication flow management
- **Chat Handlers** (`src/handlers/chat.ts`): Message handling and AI interaction
- **API Client** (`src/services/api-client.ts`): Communication with Alia API
- **Database** (`src/services/db.ts`): MongoDB connection management
- **Models** (`src/models/telegram-user.ts`): User data persistence

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

### Environment Setup

1. Set production environment variables:
   - `TELEGRAM_BOT_TOKEN`: Your production bot token
   - `MONGODB_URI`: Production MongoDB connection string
   - `API_BASE_URL`: Production API server URL

2. Build the project:
   ```bash
   npm run build
   ```

3. Start the bot:
   ```bash
   npm start
   ```

### Using PM2 (Recommended)

```bash
pm2 start dist/index.js --name alia-telegram-bot
pm2 save
pm2 startup
```

### Docker Deployment

Create a `Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
CMD ["node", "dist/index.js"]
```

Build and run:

```bash
docker build -t alia-telegram-bot .
docker run -d --env-file .env alia-telegram-bot
```

## Security Considerations

1. **Never commit `.env` file** - Keep bot token secret
2. **Use HTTPS for webhook** (if implementing webhook mode)
3. **Validate user input** - All inputs are sanitized
4. **Token expiration** - Auth codes expire after 15 minutes
5. **Rate limiting** - Inherits rate limits from API server

## Troubleshooting

### Bot doesn't respond

- Check if bot is running: `ps aux | grep node`
- Verify bot token is correct
- Check MongoDB connection
- Ensure API server is running

### Authentication fails

- Verify API_BASE_URL is correct
- Check MongoDB has TelegramUser collection
- Ensure /telegram routes are registered in API server
- Check auth token hasn't expired (15 min limit)

### Messages not reaching Alia

- Verify sessionToken is valid
- Check API server logs
- Ensure user has credits
- Test API endpoint directly

### Database connection errors

- Verify MONGODB_URI is correct
- Check MongoDB is running
- Ensure network connectivity

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
