# Telegram Bot Quick Setup Guide

This guide will help you quickly set up the Alia Telegram bot.

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

### 3. Install and Run

```bash
# From project root
npm install

# Start API server (in one terminal)
npm run dev:api

# Start Telegram bot (in another terminal)
npm run dev:telegram
```

### 4. Test It

1. Find your bot in Telegram (search for the username you created)
2. Send `/start`
3. Follow authentication instructions
4. Start chatting!

## How Users Authenticate

### Option 1: Web Authentication (Recommended)

1. User sends `/start` to bot
2. Bot sends auth code and web link
3. User clicks link and enters email/password
4. Account is linked automatically
5. User returns to Telegram and starts chatting

### Option 2: Direct Login

```
/login your@email.com yourpassword
```

**Note:** This is less secure as credentials are visible in chat. Web authentication is recommended.

## Available Commands

| Command | Description |
|---------|-------------|
| `/start` | Start bot and get auth instructions |
| `/login <email> <password>` | Direct login |
| `/status` | Check account status and credits |
| `/logout` | Disconnect account |
| `/new` | Start new conversation |
| `/history` | View conversation history |
| `/help` | Show help message |

## Architecture Overview

```
User in Telegram
       ↓
  Telegram Bot (apps/telegram-bot)
       ↓
  API Server (apps/api)
       ↓
  Alia AI (OpenAI, Claude, etc.)
```

## Files Created

```
apps/telegram-bot/
├── src/
│   ├── index.ts                    # Bot entry point
│   ├── handlers/
│   │   ├── auth.ts                 # /start, /login, /logout, /status
│   │   ├── chat.ts                 # Message handling & AI chat
│   │   └── commands.ts             # /help command
│   ├── services/
│   │   ├── api-client.ts           # API communication
│   │   └── db.ts                   # MongoDB connection
│   └── models/
│       └── telegram-user.ts        # TelegramUser model
├── package.json
├── tsconfig.json
├── .env.example
└── README.md

apps/api/src/routes/
└── telegram.ts                     # Web auth endpoints
```

## API Endpoints Added

- `GET /telegram/verify?token=XXX` - Web authentication page
- `POST /telegram/link` - Link Telegram account to user

## Database Collections

### TelegramUser
Stores the mapping between Telegram users and API users:
- `telegramId` - Telegram user ID
- `userId` - API user ID (reference)
- `sessionToken` - JWT token for API calls
- `conversationId` - Current conversation
- `isAuthenticated` - Auth status

## Troubleshooting

### Bot doesn't respond
```bash
# Check if bot is running
ps aux | grep node

# Check logs
npm run dev:telegram
```

### Can't authenticate
- Make sure API server is running on port 3001
- Check MongoDB is running
- Verify bot token is correct

### Messages not working
- Check user is authenticated: `/status`
- Verify API server can reach AI providers
- Check user has credits

## Production Deployment

1. **Build the bot:**
   ```bash
   cd apps/telegram-bot
   npm run build
   ```

2. **Set production env vars:**
   ```env
   TELEGRAM_BOT_TOKEN=your_production_token
   MONGODB_URI=mongodb://your_production_db
   API_BASE_URL=https://your-api-domain.com
   ```

3. **Run with PM2:**
   ```bash
   pm2 start dist/index.js --name alia-telegram-bot
   pm2 save
   ```

## Security Notes

- ✅ Auth codes expire in 15 minutes
- ✅ Passwords are hashed with bcrypt
- ✅ JWT tokens used for API authentication
- ✅ User input is validated
- ⚠️ Never commit `.env` files
- ⚠️ Use HTTPS in production

## Next Steps

- [ ] Get bot token from BotFather
- [ ] Configure `.env` file
- [ ] Install dependencies
- [ ] Start API server
- [ ] Start Telegram bot
- [ ] Test with `/start` command

For detailed documentation, see [apps/telegram-bot/README.md](apps/telegram-bot/README.md)
