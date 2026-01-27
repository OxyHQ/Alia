# Alia Providers Service - Deployment Guide

## Production Domains

- **API Service**: `https://api.providers.alia.onl`
- **Admin Panel**: `https://providers.alia.onl`

## Environment Variables

### Production `.env`:

```env
# Server Configuration
PORT=3002
NODE_ENV=production

# MongoDB Connection
MONGODB_URI=mongodb://your-production-mongodb-uri

# Service Authentication
SERVICE_SECRET=your-production-secret-key

# CORS Configuration
ALLOWED_ORIGINS=https://providers.alia.onl,https://api.alia.onl

# Main API Service URL (for callbacks/webhooks if needed)
MAIN_API_URL=https://api.alia.onl
```

## CORS Configuration

The service must allow requests from:
1. **Admin Panel**: `https://providers.alia.onl`
2. **Main API**: `https://api.alia.onl`

Update your CORS configuration in the Express app:

```typescript
app.use(cors({
  origin: [
    'https://providers.alia.onl',
    'https://api.alia.onl',
    // For local development
    'http://localhost:5173',
    'http://localhost:3001',
  ],
  credentials: true,
}));
```

## Deployment Steps

1. **Build the service**:
   ```bash
   npm run build
   ```

2. **Set environment variables** on your production server

3. **Run migrations** (if you haven't already):
   ```bash
   npm run migrate:keys
   npm run migrate:models
   ```

4. **Start the service**:
   ```bash
   npm start
   # or with PM2
   pm2 start dist/index.js --name alia-providers
   ```

5. **Verify health endpoint**:
   ```bash
   curl https://api.providers.alia.onl/health
   ```

## Security Checklist

- [ ] HMAC secret is strong and securely stored
- [ ] MongoDB connection uses SSL/TLS
- [ ] Rate limiting is configured
- [ ] Admin panel is behind authentication/VPN
- [ ] API keys are stored hashed in database
- [ ] CORS is properly configured
- [ ] Service is behind reverse proxy (nginx/traefik)
- [ ] HTTPS is enforced
- [ ] Monitoring and logging are configured

## Monitoring

Monitor the following endpoints:
- `/health` - Service health check
- `/v1/providers/health` - Provider health metrics

Set up alerts for:
- High failure rates (> 10%)
- Circuit breakers opening
- Key archive events
- Service downtime

## Backup

Ensure MongoDB backups include:
- `providerkeys` collection (API keys)
- `modelconfigs` collection (Model configurations)
- `aliamodels` collection (Virtual model mappings)
- `providerhealth` collection (Health metrics - optional)
