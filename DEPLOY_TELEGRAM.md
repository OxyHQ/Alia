# Deploy Telegram Bot to DigitalOcean

This guide covers deploying the Alia Telegram bot to DigitalOcean.

## Prerequisites

- DigitalOcean account
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your API server already deployed and running
- Git repository (GitHub, GitLab, etc.)

## Option 1: DigitalOcean App Platform (Recommended)

App Platform automatically manages deployments, scaling, and updates.

### Step 1: Prepare Your Repository

1. **Push your code to Git** (if not already):
   ```bash
   git add .
   git commit -m "Add telegram bot"
   git push
   ```

2. **Create `.dockerignore`** in `apps/telegram-bot/`:
   ```
   node_modules
   dist
   .env
   .env.local
   *.log
   .DS_Store
   ```

### Step 2: Deploy to App Platform

1. **Go to DigitalOcean Dashboard**
   - Navigate to App Platform
   - Click "Create App"

2. **Connect Your Repository**
   - Choose your Git provider (GitHub/GitLab)
   - Select your repository
   - Select branch (usually `main`)

3. **Configure the App**
   - **Source Directory**: `apps/telegram-bot`
   - **Autodeploy**: Enable (optional, deploys on git push)

4. **Configure Build Settings**
   - **Type**: Worker (not Web Service)
   - **Dockerfile Path**: `apps/telegram-bot/Dockerfile`
   - Or use **Buildpack** if you prefer:
     - Build Command: `npm install && npm run build`
     - Run Command: `node dist/index.js`

5. **Set Environment Variables**
   ```
   TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
   API_BASE_URL=https://your-api-domain.com
   ```

6. **Choose Plan**
   - Basic: $5/month (512 MB RAM, 1 vCPU)
   - Professional: $12/month (1 GB RAM, 1 vCPU)
   - Start with Basic, upgrade if needed

7. **Click "Create Resources"**

### Step 3: Monitor Deployment

- App Platform will build and deploy automatically
- Check logs in the dashboard
- Look for "Alia Telegram Bot is running!" message

### Step 4: Test

Send a message to your bot on Telegram!

---

## Option 2: DigitalOcean Droplet (More Control)

Use a Droplet if you need more control or want to run multiple services.

### Step 1: Create a Droplet

1. **Create Droplet**
   - Choose Ubuntu 22.04 LTS
   - Basic plan: $6/month (1 GB RAM)
   - Choose datacenter region close to users
   - Add SSH key

2. **SSH into droplet**:
   ```bash
   ssh root@your_droplet_ip
   ```

### Step 2: Install Node.js and PM2

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Verify installation
node --version  # Should show v20.x
npm --version

# Install PM2 globally
npm install -g pm2

# Install git
apt install -y git
```

### Step 3: Clone and Setup Bot

```bash
# Clone your repository
git clone https://github.com/yourusername/ai-api-server.git
cd ai-api-server

# Install dependencies
npm install

# Setup telegram bot
cd apps/telegram-bot
cp .env.example .env
nano .env
```

**Edit `.env` file**:
```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
API_BASE_URL=https://your-api-domain.com
```

Press `Ctrl+X`, then `Y`, then `Enter` to save.

### Step 4: Build and Start with PM2

```bash
# Build the bot
npm run build

# Start with PM2
pm2 start dist/index.js --name alia-telegram-bot

# Save PM2 process list
pm2 save

# Setup PM2 to start on boot
pm2 startup
# Copy and run the command it outputs
```

### Step 5: Monitor and Manage

```bash
# View logs
pm2 logs alia-telegram-bot

# Check status
pm2 status

# Restart bot
pm2 restart alia-telegram-bot

# Stop bot
pm2 stop alia-telegram-bot

# View resource usage
pm2 monit
```

### Step 6: Setup Auto-Deploy (Optional)

Create a deploy script:

```bash
# Create deploy script
nano ~/deploy-telegram-bot.sh
```

Add this content:
```bash
#!/bin/bash
cd /root/ai-api-server
git pull
cd apps/telegram-bot
npm install
npm run build
pm2 restart alia-telegram-bot
pm2 save
```

Make it executable:
```bash
chmod +x ~/deploy-telegram-bot.sh
```

Now you can deploy updates with:
```bash
~/deploy-telegram-bot.sh
```

---

## Option 3: Docker on Droplet

If you prefer Docker:

### Step 1: Install Docker

```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Install Docker Compose
apt install -y docker-compose
```

### Step 2: Create docker-compose.yml

In `apps/telegram-bot/`:

```yaml
version: '3.8'

services:
  telegram-bot:
    build: .
    restart: unless-stopped
    environment:
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - API_BASE_URL=${API_BASE_URL}
    env_file:
      - .env
```

### Step 3: Deploy

```bash
cd apps/telegram-bot

# Build and start
docker-compose up -d

# View logs
docker-compose logs -f

# Restart
docker-compose restart

# Stop
docker-compose down
```

---

## Monitoring and Maintenance

### Check Bot Health

**App Platform**:
- Dashboard → Your App → Runtime Logs
- Set up alerts for crashes

**Droplet with PM2**:
```bash
pm2 status
pm2 logs alia-telegram-bot --lines 100
```

**Docker**:
```bash
docker-compose logs -f telegram-bot
```

### Common Issues

**Bot not responding**:
```bash
# Check if process is running
pm2 status  # For PM2
docker ps   # For Docker

# Check logs
pm2 logs alia-telegram-bot
docker-compose logs telegram-bot

# Restart
pm2 restart alia-telegram-bot
docker-compose restart
```

**Can't connect to API**:
- Verify `API_BASE_URL` is correct
- Check if API server is accessible
- Test: `curl https://your-api-domain.com/health`

**Out of memory**:
- Upgrade Droplet/App Platform plan
- Check for memory leaks in logs

### Updating the Bot

**App Platform**:
- Just push to Git, auto-deploys

**Droplet with PM2**:
```bash
cd /root/ai-api-server
git pull
cd apps/telegram-bot
npm install
npm run build
pm2 restart alia-telegram-bot
```

**Docker**:
```bash
cd apps/telegram-bot
git pull
docker-compose down
docker-compose up -d --build
```

---

## Security Best Practices

1. **Use Environment Variables**
   - Never commit `.env` to git
   - Use DigitalOcean's environment variable manager

2. **Enable Firewall** (Droplet only)
   ```bash
   ufw allow OpenSSH
   ufw enable
   ```

3. **Keep System Updated** (Droplet only)
   ```bash
   apt update && apt upgrade -y
   ```

4. **Use Non-root User** (Droplet only)
   ```bash
   adduser telegram-bot
   usermod -aG sudo telegram-bot
   su - telegram-bot
   ```

5. **Enable HTTPS for API**
   - Your API should use HTTPS
   - Get free SSL with Let's Encrypt

---

## Cost Comparison

| Option | Cost/Month | Pros | Cons |
|--------|-----------|------|------|
| **App Platform (Basic)** | $5 | Auto-scaling, Easy deploys, Managed | Less control |
| **Droplet (1GB)** | $6 | Full control, Multiple apps | Manual setup |
| **App Platform (Pro)** | $12 | Better resources, Auto-scaling | Higher cost |
| **Droplet (2GB)** | $12 | More resources, Full control | Manual management |

---

## Recommendation

**For most users**: Start with **DigitalOcean App Platform**
- Easiest to setup
- Automatic deployments
- Managed infrastructure
- Easy scaling

**Use Droplet if**:
- You want to run API + Bot on same server
- You need custom configurations
- You're comfortable with server management

---

## Quick Start: App Platform Deployment

1. **Create Dockerfile** (already created in `apps/telegram-bot/Dockerfile`)

2. **Push to Git**:
   ```bash
   git add apps/telegram-bot/Dockerfile
   git commit -m "Add Dockerfile for telegram bot"
   git push
   ```

3. **Create App on DigitalOcean**:
   - App Platform → Create App
   - Connect GitHub/GitLab
   - Source: `apps/telegram-bot`
   - Type: Worker
   - Set env vars:
     - `TELEGRAM_BOT_TOKEN`
     - `API_BASE_URL`

4. **Deploy and Test**

That's it! Your bot will be running 24/7.

---

## Need Help?

- **DigitalOcean Docs**: https://docs.digitalocean.com/products/app-platform/
- **PM2 Docs**: https://pm2.keymetrics.io/docs/usage/quick-start/
- **Telegram Bot API**: https://core.telegram.org/bots/api

## Next Steps

After deployment:
- [ ] Test bot with a message
- [ ] Check logs for errors
- [ ] Set up monitoring/alerts
- [ ] Configure auto-deploy (if using Droplet)
- [ ] Add health check endpoint (optional)
