# Quick Deploy: Telegram Bot to DigitalOcean

## Fastest Way: App Platform (5 minutes)

### 1. Push to Git
```bash
git add .
git commit -m "Add telegram bot"
git push
```

### 2. Create App on DigitalOcean

1. Go to https://cloud.digitalocean.com/apps
2. Click **"Create App"**
3. **Connect GitHub/GitLab** → Select your repo
4. **Source Directory**: `apps/telegram-bot`
5. **Resource Type**: Change from "Web Service" to **"Worker"**
6. **Environment Variables**:
   ```
   TELEGRAM_BOT_TOKEN = your_token_from_botfather
   API_BASE_URL = https://your-api-domain.com
   ```
7. **Plan**: Basic ($5/month)
8. Click **"Create Resources"**

### 3. Wait & Test

- Wait 3-5 minutes for deployment
- Check logs in dashboard
- Send a message to your bot!

Done! 🎉

---

## Alternative: Droplet with PM2

If you prefer more control:

### 1. Create Droplet
- Ubuntu 22.04
- Basic $6/month
- Add SSH key

### 2. SSH and Setup
```bash
# SSH into droplet
ssh root@your_droplet_ip

# Install Node.js and PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git
npm install -g pm2

# Clone repo
git clone https://github.com/yourusername/ai-api-server.git
cd ai-api-server/apps/telegram-bot

# Setup environment
cp .env.example .env
nano .env  # Add your TELEGRAM_BOT_TOKEN and API_BASE_URL

# Build and run
npm install
npm run build
pm2 start dist/index.js --name alia-telegram-bot
pm2 save
pm2 startup  # Run the command it outputs
```

### 3. Done!

Check status:
```bash
pm2 status
pm2 logs alia-telegram-bot
```

---

## Environment Variables You Need

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz  # From @BotFather
API_BASE_URL=https://api.alia.com  # Your API server URL
```

## Troubleshooting

**Bot not starting?**
```bash
# Check logs
pm2 logs alia-telegram-bot  # PM2
# or in App Platform: Dashboard → Runtime Logs
```

**Can't connect to API?**
- Make sure API_BASE_URL is correct
- Test: `curl https://your-api-url.com/health`

**Bot token error?**
- Get new token from @BotFather
- Make sure no extra spaces in .env

## Update the Bot

**App Platform**: Just `git push` (auto-deploys)

**Droplet**:
```bash
cd /root/ai-api-server
git pull
cd apps/telegram-bot
npm install && npm run build
pm2 restart alia-telegram-bot
```

## Cost

- **App Platform Worker**: $5/month
- **Droplet (1GB)**: $6/month

Choose App Platform for easiest deployment!
