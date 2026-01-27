# Deploying Alia Providers API to DigitalOcean App Platform

This guide covers deploying the Alia Providers API service as a **Web Service** on DigitalOcean.

## Prerequisites

- DigitalOcean account
- GitHub repository
- MongoDB database (DigitalOcean Managed DB or MongoDB Atlas)
- Domain configured (api.providers.alia.onl)

## Service Type: Web Service

The providers API is deployed as a **Web Service** (NOT static site) because:
- It's a Node.js/Express backend API
- Needs to run continuously to handle requests
- Connects to MongoDB
- Provides REST API endpoints

## Deployment Steps

### Option 1: Using the Web UI

1. **Create a New App**
   - Go to DigitalOcean App Platform
   - Click "Create App"
   - Connect your GitHub repository
   - Select the repository and branch

2. **Configure the Web Service**
   - **Type**: Web Service
   - **Source Directory**: `/apps/alia-providers`
   - **Build Command**:
     ```bash
     npm install && npm run build
     ```
   - **Run Command**:
     ```bash
     npm start
     ```
   - **HTTP Port**: `3002` (or use `8080` for DigitalOcean default)
   - **Health Check Path**: `/health`
   - **Node Version**: Select latest Node.js (18 or higher)

3. **Set Environment Variables**

   Add these as **Runtime** variables:

   ```env
   # Server
   NODE_ENV=production
   PORT=3002

   # MongoDB Connection (REQUIRED - Set as encrypted secret)
   MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/alia

   # Service Authentication (REQUIRED - Set as encrypted secret)
   SERVICE_SECRET=your-32-char-secret-key

   # Allowed Services
   ALLOWED_SERVICES=alia-api,alia-admin

   # CORS Configuration
   ALLOWED_ORIGINS=https://providers.alia.onl,https://api.alia.onl

   # Key Encryption (REQUIRED - Set as encrypted secret)
   ENCRYPTION_KEY=your-32-byte-hex-key

   # Monitoring
   ENABLE_HEALTH_MONITOR=true
   HEALTH_CHECK_INTERVAL_MS=300000

   # Rate Limiting Defaults
   DEFAULT_RPM=60
   DEFAULT_TPM=100000

   # Logging
   LOG_LEVEL=info
   ```

   **IMPORTANT**: Mark these as encrypted secrets:
   - `MONGODB_URI`
   - `SERVICE_SECRET`
   - `ENCRYPTION_KEY`

4. **Configure Instance Size**
   - Start with: **Basic (512 MB RAM / $5/month)**
   - Scale up if needed based on traffic

5. **Configure Domain**
   - Add custom domain: `api.providers.alia.onl`
   - DigitalOcean will handle SSL/TLS automatically
   - Update your DNS to point to the app

6. **Deploy**
   - Review settings
   - Click "Create Resources"
   - Wait for the build and deployment

### Option 2: Using App Spec (YAML)

The service includes a `.do/app.yaml` configuration file.

1. **Install doctl**
   ```bash
   # macOS
   brew install doctl

   # Linux
   wget https://github.com/digitalocean/doctl/releases/download/v1.99.0/doctl-1.99.0-linux-amd64.tar.gz
   tar xf ~/doctl-1.99.0-linux-amd64.tar.gz
   sudo mv ~/doctl /usr/local/bin
   ```

2. **Authenticate**
   ```bash
   doctl auth init
   ```

3. **Update app.yaml**
   Edit `.do/app.yaml` and update:
   - `repo`: Your GitHub username/repo
   - Secrets will be set separately in the dashboard

4. **Create the App**
   ```bash
   cd apps/alia-providers
   doctl apps create --spec .do/app.yaml
   ```

5. **Set Secrets via Dashboard**
   - Go to DigitalOcean App Platform
   - Select your app
   - Go to Settings → Environment Variables
   - Add encrypted secrets: `MONGODB_URI`, `SERVICE_SECRET`, `ENCRYPTION_KEY`

## MongoDB Setup

### Option A: DigitalOcean Managed MongoDB

1. **Create MongoDB Cluster**
   - Go to Databases → Create
   - Select MongoDB
   - Choose plan (starts at $15/month)
   - Same region as your app (nyc3)

2. **Connect to Your App**
   - Get connection string from database dashboard
   - Add to app as `MONGODB_URI` environment variable
   - DigitalOcean handles networking automatically

3. **Update app.yaml** (if using managed DB)
   ```yaml
   databases:
     - name: alia-db
       engine: MONGODB
       version: "6"
       size: db-s-1vcpu-1gb
   ```

### Option B: MongoDB Atlas

1. **Create MongoDB Atlas cluster** (free tier available)
2. **Whitelist DigitalOcean IPs**
   - Get your app's egress IPs from DigitalOcean
   - Add to Atlas network access
3. **Get connection string**
   - Copy MongoDB connection string
   - Set as `MONGODB_URI` in app environment variables

## Port Configuration

DigitalOcean App Platform can use any port, but typically:
- **Internal Port**: `3002` (what your app listens on)
- **External Port**: `443` (HTTPS) - handled by DigitalOcean

Update [src/index.ts](src/index.ts) if you need to change the port:
```typescript
const PORT = process.env.PORT || 3002;
```

## Monorepo Considerations

This project uses a monorepo structure:

1. **Source Directory**: Must be set to `/apps/alia-providers`
2. **Build Command**: `npm install && npm run build`
3. **Run Command**: `npm start`
4. **Dependencies**: All in the service's `package.json`

## Migration Scripts

Before deploying, you should run migration scripts to populate MongoDB with initial data:

```bash
# Locally, with production MongoDB connection
MONGODB_URI=your-prod-mongodb npm run migrate:keys
MONGODB_URI=your-prod-mongodb npm run migrate:models
```

Or add a post-deploy hook:
```yaml
jobs:
  - name: migrate
    kind: POST_DEPLOY
    run_command: npm run migrate:keys && npm run migrate:models
```

## Troubleshooting

### Build fails with "Cannot find module"

**Cause**: Dependencies not installed

**Solution**: Ensure build command is:
```bash
npm install && npm run build
```

### Service crashes on startup

**Cause**: Missing environment variables or MongoDB connection fails

**Solution**:
1. Check logs: `doctl apps logs <app-id>`
2. Verify all required env vars are set:
   - `MONGODB_URI`
   - `SERVICE_SECRET`
   - `ENCRYPTION_KEY`
3. Test MongoDB connection separately

### CORS errors from admin panel

**Cause**: Admin panel domain not in ALLOWED_ORIGINS

**Solution**: Update `ALLOWED_ORIGINS`:
```env
ALLOWED_ORIGINS=https://providers.alia.onl,https://api.alia.onl
```

### Health check failing

**Cause**: Health endpoint not responding

**Solution**:
1. Check `/health` endpoint returns 200
2. Verify `http_port` matches your app's PORT
3. Check health check path is `/health`

### MongoDB connection timeout

**Cause**: MongoDB not accessible from DigitalOcean

**Solution**:
- For Atlas: Whitelist DigitalOcean IPs
- For Managed DB: Ensure both in same VPC/region
- Check connection string format and credentials

## Post-Deployment

1. **Verify Deployment**
   ```bash
   curl https://api.providers.alia.onl/health
   ```

   Expected response:
   ```json
   {
     "success": true,
     "service": "alia-providers",
     "status": "healthy",
     "timestamp": "2026-01-27T...",
     "uptime": 123.45
   }
   ```

2. **Test Endpoints**
   ```bash
   # List keys (requires auth)
   curl -H "X-Service-Name: test" \
        -H "X-Timestamp: $(date +%s)000" \
        -H "X-Signature: test" \
        https://api.providers.alia.onl/v1/keys
   ```

3. **Connect Admin Panel**
   - Update admin panel's `VITE_PROVIDERS_API_URL`
   - Redeploy admin panel
   - Test CRUD operations

4. **Monitor**
   - Set up alerts in DigitalOcean dashboard
   - Monitor error rates and response times
   - Check MongoDB connection metrics

## Scaling

### Vertical Scaling (More Resources)

Upgrade instance size:
- Basic: $5/month (512 MB RAM)
- Professional: $12/month (1 GB RAM)
- Professional: $24/month (2 GB RAM)

### Horizontal Scaling (More Instances)

Increase instance count in app.yaml:
```yaml
instance_count: 2  # Run 2 instances
```

Load balancing is automatic.

### Auto-Scaling

DigitalOcean doesn't support auto-scaling on App Platform. Use multiple fixed instances instead.

## Cost Estimation

**Monthly costs**:
- Web Service (Basic): $5/month (512 MB RAM)
- MongoDB (Managed): $15/month or Atlas Free Tier
- Bandwidth: 100GB included, then $0.01/GB

**Recommended for production**:
- Web Service (Professional): $12/month (1 GB RAM)
- MongoDB (Atlas M10): $57/month or DigitalOcean Managed: $15/month
- **Total**: ~$27-70/month

## Continuous Deployment

By default, the app auto-deploys on push to main:

```yaml
github:
  deploy_on_push: true
  branch: main
```

Every commit to main triggers a new build and deployment (zero-downtime rolling update).

## Security Checklist

- [ ] All secrets are encrypted in DigitalOcean
- [ ] MongoDB uses SSL/TLS connection
- [ ] CORS is properly configured
- [ ] HMAC secret is strong (32+ characters)
- [ ] Encryption key is random 32-byte hex
- [ ] API is behind HTTPS (DigitalOcean provides SSL)
- [ ] Rate limiting is configured
- [ ] Admin panel requires additional auth (VPN/OAuth)
- [ ] Environment is set to `production`
- [ ] Logging level is appropriate (`info` or `warn`)

## Monitoring & Alerts

Set up monitoring for:
- **Health endpoint**: `/health` should return 200
- **Error rate**: Monitor 5xx responses
- **Response time**: Alert if >2 seconds
- **MongoDB connection**: Monitor connection pool
- **Memory usage**: Alert if >80%
- **CPU usage**: Alert if >80%

Configure in DigitalOcean:
- App Platform → Insights → Alerts
- Set up email/Slack notifications

## Logs

View logs:
```bash
# Real-time logs
doctl apps logs <app-id> --follow

# Recent logs
doctl apps logs <app-id> --tail 100
```

Or via DigitalOcean dashboard: App Platform → Runtime Logs

## Backup Strategy

1. **MongoDB Backups**
   - DigitalOcean Managed DB: Automatic daily backups
   - MongoDB Atlas: Automatic continuous backups

2. **Configuration Backup**
   - Keep app.yaml in Git
   - Document all environment variables

3. **Code Backup**
   - Git repository (already backed up)
   - Tag releases for rollback capability

## Rollback

To rollback to a previous deployment:

```bash
# List deployments
doctl apps list-deployments <app-id>

# Rollback to specific deployment
doctl apps create-deployment <app-id> --deployment-id <previous-deployment-id>
```

Or via dashboard: App Platform → Deployments → Rollback

## Support Resources

- DigitalOcean App Platform Docs: https://docs.digitalocean.com/products/app-platform/
- Community Forum: https://www.digitalocean.com/community/tags/app-platform
- This repo's Issues: For application-specific problems
