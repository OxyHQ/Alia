# Deployment Guide

This guide covers deploying Alia AI to production, specifically for DigitalOcean App Platform.

## Table of Contents

- [Prerequisites](#prerequisites)
- [DigitalOcean Setup](#digitalocean-setup)
- [Environment Variables](#environment-variables)
- [Deployment Process](#deployment-process)
- [Post-Deployment Verification](#post-deployment-verification)
- [LiveKit Server Setup](#livekit-server-setup)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- DigitalOcean account with App Platform enabled
- MongoDB database (Atlas, DigitalOcean, or self-hosted)
- API keys for LLM providers (OpenAI, Anthropic, Google)
- Oxy authentication service configured
- Domain name (optional, but recommended)

## DigitalOcean Setup

### App Platform Configuration

1. **Create App** from your GitHub repository
2. **Configure Build Settings**:
   - Build Command: `npm run build`
   - Run Command: `npm run start:api` (for API)

### Resource Allocation

**Recommended for Production:**
- **API Server**: Basic (512 MB RAM, 1 vCPU)
- **Database**: Managed MongoDB or external Atlas cluster
- **Scaling**: Enable auto-scaling based on traffic

## Environment Variables

### Required Variables

Add these in DigitalOcean App Platform → Settings → Environment Variables:

#### API Server (`apps/api`)

```bash
# Server Configuration
API_PORT=8080                                    # DigitalOcean uses 8080
NODE_ENV=production
WEB_URL=https://your-app-domain.com

# Database
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/alia?retryWrites=true&w=majority

# Oxy Authentication
OXY_API_URL=https://api.oxy.so                   # Or your Oxy server URL

# LLM Provider API Keys
OPENAI_API_KEY=sk-...                            # OpenAI key
ANTHROPIC_API_KEY=sk-ant-...                     # Anthropic key
GOOGLE_API_KEY=...                               # Google AI key

# Google Search (Optional)
GOOGLE_SEARCH_API_KEY=...                        # For web search functionality
GOOGLE_SEARCH_ENGINE_ID=...                      # Custom search engine ID

# Telegram Integration
TELEGRAM_BOT_SECRET=<generate-with-openssl>      # See below for generation
TELEGRAM_BOT_TOKEN=<your-telegram-bot-token>     # From @BotFather

# Stripe (for subscriptions)
STRIPE_SECRET_KEY=sk_live_...                    # Stripe secret key
STRIPE_WEBHOOK_SECRET=whsec_...                  # Stripe webhook secret
STRIPE_PRO_PRICE_ID=price_...                    # Pro plan price ID
STRIPE_BUSINESS_PRICE_ID=price_...               # Business plan price ID

# LiveKit Voice (Self-hosted)
LIVEKIT_URL=ws://your-livekit-server:7880      # LiveKit server WebSocket URL
LIVEKIT_API_KEY=your-api-key                    # LiveKit API key
LIVEKIT_API_SECRET=your-api-secret              # LiveKit API secret

# Channel Gateway Bot Secrets
DISCORD_BOT_TOKEN=your-discord-bot-token        # Discord bot token
DISCORD_BOT_SECRET=<generate-with-openssl>      # Discord bot webhook secret
DISCORD_PUBLIC_KEY=your-discord-public-key      # Discord application public key
WHATSAPP_ACCESS_TOKEN=your-whatsapp-token       # Meta Business API token
WHATSAPP_PHONE_NUMBER_ID=your-phone-id          # WhatsApp phone number ID
WHATSAPP_WEBHOOK_SECRET=<generate>              # WhatsApp webhook verify token
SLACK_BOT_TOKEN=xoxb-your-slack-token           # Slack bot token
SLACK_SIGNING_SECRET=your-signing-secret        # Slack signing secret
SIGNAL_CLI_URL=http://signal-cli:8080           # Signal CLI REST API URL
SIGNAL_BOT_NUMBER=+1234567890                   # Signal bot phone number
```

#### Frontend App (`apps/app`)

```bash
# API Configuration
EXPO_PUBLIC_API_URL=https://api.your-domain.com

# Environment
EXPO_PUBLIC_ENV=production
```

### Generating Secrets

**TELEGRAM_BOT_SECRET:**
```bash
openssl rand -hex 32
```

This creates a secure random string. Use the **same value** in:
1. Your DigitalOcean environment variables
2. Your Telegram bot configuration

## Deployment Process

### Method 1: Automatic Deployment (Recommended)

1. **Push to GitHub**:
   ```bash
   git add .
   git commit -m "feat: memory improvements and export/import"
   git push origin main
   ```

2. **DigitalOcean Auto-Deploy**:
   - If enabled, deployment starts automatically
   - Monitor progress in DigitalOcean dashboard
   - Check build logs for errors

### Method 2: Manual Deployment

1. **Build Locally**:
   ```bash
   npm run build
   ```

2. **Deploy via DigitalOcean CLI** (doctl):
   ```bash
   doctl apps create-deployment <app-id>
   ```

### Deployment Checklist

Before deploying, verify:

- [ ] All environment variables are set
- [ ] `MONGODB_URI` is correct and accessible
- [ ] LLM API keys are valid
- [ ] `TELEGRAM_BOT_SECRET` is configured
- [ ] LiveKit server is deployed and accessible (if using voice mode)
- [ ] Channel bot tokens are configured (for each enabled channel)
- [ ] Build completes successfully locally
- [ ] Tests pass (if applicable)

## Post-Deployment Verification

### 1. Health Check

```bash
curl https://api.your-domain.com/api/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2024-01-24T00:00:00.000Z"
}
```

### 2. Test Memory Functionality

**Via API:**
```bash
# Get memory (should create empty profile)
curl -H "x-session-id: YOUR_SESSION_ID" \
  https://api.your-domain.com/api/memory

# Add a test memory
curl -X POST https://api.your-domain.com/api/memory/add \
  -H "x-session-id: YOUR_SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "test_key",
    "value": "test_value",
    "category": "preference"
  }'
```

**Via Chat:**
1. Open your app
2. Tell Alia: "Remember that my favorite color is blue"
3. Check Memory settings - you should see the new memory

### 3. Test Export/Import

```bash
# Export preview
curl -H "x-session-id: YOUR_SESSION_ID" \
  https://api.your-domain.com/api/memory/export/preview

# Export as JSON
curl -H "x-session-id: YOUR_SESSION_ID" \
  https://api.your-domain.com/api/memory/export/json \
  -o memories.json
```

### 4. Check Logs

In DigitalOcean dashboard:
- Go to your app → Runtime Logs
- Look for any errors or warnings
- Verify MongoDB connection is successful

**Expected log entries:**
```
✅ [API] Server listening on port 8080
✅ [DB] Connected to MongoDB
✅ [Memory] Created indexes successfully
```

### 5. Monitor Performance

Check DigitalOcean metrics for:
- Response times (should be < 500ms for most requests)
- Memory usage (should be stable)
- CPU usage (spikes during AI requests are normal)
- Error rate (should be minimal)

## LiveKit Server Setup

For voice mode, deploy a self-hosted LiveKit server on DigitalOcean:

### Option 1: Docker (Single Node)
1. Create a compute-optimized droplet (minimum 2 vCPU, 4GB RAM)
2. Open UDP ports 7880-7881 and 50000-60000
3. Run LiveKit:
   ```bash
   docker run -d --network host \
     -e LIVEKIT_KEYS="your-api-key: your-api-secret" \
     livekit/livekit-server
   ```

### Option 2: Kubernetes (DOKS)
1. Add LiveKit Helm chart:
   ```bash
   helm repo add livekit https://helm.livekit.io
   helm install livekit livekit/livekit-server \
     --set keys.your-api-key=your-api-secret
   ```

### Generating LiveKit Keys
```bash
# Install livekit-cli
brew install livekit-cli  # or download from GitHub

# Generate API key pair
livekit-cli generate-keys
```

## Troubleshooting

### Issue: "Bot configuration error"

**Cause**: Missing `TELEGRAM_BOT_SECRET` environment variable

**Solution**:
1. Generate secret: `openssl rand -hex 32`
2. Add to DigitalOcean environment variables
3. Add same value to Telegram bot configuration
4. Redeploy

### Issue: Memory not saving

**Symptoms**: AI doesn't remember information after restart

**Causes & Solutions**:

1. **MongoDB connection issue**:
   ```bash
   # Check logs for connection errors
   # Verify MONGODB_URI is correct
   # Test connection locally
   ```

2. **Indexes not created**:
   ```bash
   # Check logs for index creation errors
   # Verify MongoDB user has proper permissions
   ```

3. **AI tools not loaded**:
   ```bash
   # Check that saveUserMemoryTool is exported in tools/index.ts
   # Verify it's registered in routes/chat.ts
   ```

### Issue: Import fails with "file too large"

**Cause**: File exceeds 5MB limit

**Solution**:
- Split the import into multiple smaller files
- Or remove unnecessary data from export
- Contact support to increase limit if needed

### Issue: Memory limit error for free users

**Expected behavior**: Free users are limited to 100 memories

**Solution**:
- User should export existing memories
- Delete old memories to free space
- Or upgrade to Pro (1,000) or Business (unlimited) plan

### Issue: Export download doesn't work

**Cause**: CORS or Content-Disposition headers issue

**Solution**:
1. Check API logs for errors
2. Verify `Content-Disposition` header is set correctly
3. Check browser console for CORS errors
4. Ensure WEB_URL environment variable matches your domain

### Issue: High memory usage

**Symptoms**: App crashes or restarts frequently

**Causes & Solutions**:

1. **Too many cached conversations**:
   ```bash
   # Implement conversation cleanup job
   # Clear old conversations from MongoDB
   ```

2. **Memory leaks in streaming**:
   ```bash
   # Check for unclosed streams
   # Verify cleanup in chat endpoint
   ```

3. **Large memory exports**:
   ```bash
   # Implement pagination for large exports
   # Add memory limits per export
   ```

**Immediate fix**: Restart app in DigitalOcean dashboard

## Database Backups

### Automated Backups (MongoDB Atlas)

If using Atlas:
- Enable automated backups in cluster settings
- Set backup frequency (daily recommended)
- Configure retention period (7-30 days)

### Manual Backup

```bash
# Using mongodump
mongodump --uri="mongodb+srv://user:pass@cluster.mongodb.net/alia" --out=./backup

# Restore if needed
mongorestore --uri="mongodb+srv://user:pass@cluster.mongodb.net/alia" ./backup
```

### Memory Export Backups

Users should regularly export their memories:
1. Go to Memory settings
2. Click "Export" → Choose JSON
3. Download and save the file
4. Store securely (contains personal data)

## Scaling Considerations

### When to Scale

Scale up if:
- Response times consistently > 1 second
- CPU usage consistently > 80%
- Memory usage consistently > 80%
- Error rate > 1%

### Scaling Options

**Vertical Scaling** (DigitalOcean):
- Upgrade to larger droplet size
- More RAM and CPU cores

**Horizontal Scaling**:
- Enable multiple containers
- Configure load balancer
- Ensure stateless API (store sessions in Redis)

**Database Scaling**:
- Upgrade MongoDB cluster size
- Enable read replicas
- Implement caching (Redis)

## Security Best Practices

### Environment Variables
- Never commit `.env` files to git
- Use DigitalOcean's encrypted environment variables
- Rotate API keys regularly
- Use different keys for dev/staging/production

### Database Security
- Use strong MongoDB passwords
- Whitelist only necessary IP addresses
- Enable encryption at rest (MongoDB Atlas)
- Use SSL/TLS for connections

### API Security
- Implement rate limiting
- Use HTTPS only (enforce in production)
- Validate all inputs
- Sanitize outputs to prevent XSS

### Monitoring
- Set up alerts for:
  - High error rates
  - Response time degradation
  - Memory/CPU spikes
  - Database connection failures

## Rollback Process

If deployment fails or introduces critical bugs:

### Quick Rollback (DigitalOcean)

1. Go to your app in DigitalOcean dashboard
2. Navigate to "Deployments" tab
3. Find the last working deployment
4. Click "Redeploy"

### Manual Rollback (Git)

```bash
# Find the last working commit
git log --oneline

# Revert to that commit
git revert <commit-hash>

# Or reset (more aggressive)
git reset --hard <commit-hash>
git push --force

# DigitalOcean will auto-deploy the reverted code
```

## Performance Optimization

### API Response Times

**Target**: < 500ms for most requests (excluding AI streaming)

**Optimizations**:
- Use MongoDB indexes (already implemented)
- Enable API response caching (Redis)
- Compress responses (gzip)
- Optimize memory queries with pagination

### Database Performance

- Ensure indexes are created (check on first deploy)
- Monitor slow queries in MongoDB Atlas
- Consider read replicas for high traffic
- Implement connection pooling

### Frontend Performance

- Use CDN for static assets
- Implement lazy loading for routes
- Cache API responses (5-minute TTL for memory)
- Use Expo's performance monitoring

## Monitoring & Logging

### DigitalOcean Metrics

Monitor in dashboard:
- Request rate
- Response time (p50, p95, p99)
- Error rate
- CPU and memory usage

### Custom Logging

Add structured logging to track:
```typescript
console.log('[Memory] Saved:', {
  userId: req.user.id,
  key: key,
  timestamp: new Date().toISOString()
});
```

### Error Tracking

Consider integrating:
- Sentry for error tracking
- LogRocket for session replay
- DataDog for APM

## Maintenance

### Regular Tasks

**Weekly**:
- Review error logs
- Check memory usage trends
- Monitor API response times

**Monthly**:
- Review and rotate API keys
- Update dependencies
- Review and optimize database indexes
- Check backup integrity

**Quarterly**:
- Security audit
- Performance review
- Cost optimization
- Capacity planning

---

## Support

For deployment issues:
- Check logs in DigitalOcean dashboard
- Review this troubleshooting guide
- Consult [memory-system.md](memory-system.md) for API details
- Open issue on GitHub for persistent problems

---

**Last Updated:** February 13, 2026
