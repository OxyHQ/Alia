# Deploying to DigitalOcean App Platform

This guide covers deploying the Alia Gateway Admin Panel as a Static Site on DigitalOcean.

## Prerequisites

- DigitalOcean account
- GitHub repository
- Domain configured (gateway.alia.onl)

## Deployment Steps

### Option 1: Using the Web UI

1. **Create a New App**
   - Go to DigitalOcean App Platform
   - Click "Create App"
   - Connect your GitHub repository
   - Select the repository and branch

2. **Configure the Static Site**
   - **Type**: Static Site
   - **Source Directory**: `/packages/alia-gateway-admin`
   - **Build Command**:
     ```bash
     bun install && bun run build
     ```
   - **Output Directory**: `dist`
   - **Node Version**: Select latest Node.js (18 or higher)

3. **Set Environment Variables**
   
   Add these as **Build-time** variables:
   
   ```env
   VITE_GATEWAY_API_URL=https://api.gateway.alia.onl
   VITE_SERVICE_SECRET=your-secret-here
   ```
   
   Set `VITE_SERVICE_SECRET` as an encrypted secret.

4. **Configure Domain**
   - Add custom domain: `gateway.alia.onl`
   - DigitalOcean will handle SSL/TLS automatically
   - Update your DNS to point to the app

5. **Deploy**
   - Review settings
   - Click "Create Resources"
   - Wait for the build and deployment

### Option 2: Using App Spec (YAML)

The app includes a `.do/app.yaml` configuration file. You can use it to deploy via the CLI:

1. **Install doctl**
   ```bash
   # macOS
   brew install doctl
   
   # Linux
   cd ~
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
   - `VITE_SERVICE_SECRET`: Set in DigitalOcean dashboard as encrypted variable

4. **Create the App**
   ```bash
   cd packages/alia-gateway-admin
   doctl apps create --spec .do/app.yaml
   ```

5. **Get App ID**
   ```bash
   doctl apps list
   ```

6. **Set the Secret**
   ```bash
   doctl apps update YOUR_APP_ID --env "VITE_SERVICE_SECRET=your-secret" --build-time
   ```

## Monorepo Considerations

This project uses a monorepo structure. Important notes:

1. **Source Directory**: Must be set to `/packages/alia-gateway-admin`
2. **Build Command**: Must run `bun install` first (dependencies aren't in repo root)
3. **Dependencies**: All dependencies are in the admin folder's `package.json`

## Troubleshooting

### Build fails with "Cannot find module"

**Cause**: Dependencies not installed before build

**Solution**: Ensure build command is:
```bash
bun install && bun run build
```

This installs all dependencies (including devDependencies which are needed for the build).

### CORS errors in production

**Cause**: Providers API not allowing requests from admin domain

**Solution**: Check `alia-gateway` service has correct CORS configuration:
```env
ALLOWED_ORIGINS=https://gateway.alia.onl,https://api.alia.onl
```

### Environment variables not working

**Cause**: Vite requires `VITE_` prefix and build-time scope

**Solution**: 
- All env vars must start with `VITE_`
- Must be set as **BUILD_TIME** scope (not runtime)
- Variables are baked into the build, not runtime

### 404 on page refresh

**Cause**: SPA routing not configured

**Solution**: DigitalOcean should auto-detect React Router and configure this. If not, the app.yaml includes:
```yaml
routes:
  - path: /
```

This ensures all routes serve index.html for client-side routing.

## Post-Deployment

1. **Verify Build**
   - Check build logs in DigitalOcean dashboard
   - Ensure no errors

2. **Test the App**
   - Visit https://gateway.alia.onl
   - Check all pages load
   - Verify API connection works

3. **Monitor**
   - Check DigitalOcean metrics
   - Set up alerts for downtime

4. **SSL Certificate**
   - DigitalOcean automatically provisions Let's Encrypt SSL
   - May take a few minutes after domain is configured

## Cost Estimation

**Static Site Pricing** (as of 2026):
- Free tier: 3 static sites
- Paid: $3/month per static site
- Bandwidth: 100GB included, then $0.01/GB

The admin panel should stay well within free/low-cost tiers.

## Continuous Deployment

By default, the app is configured to auto-deploy on push to the main branch:

```yaml
github:
  deploy_on_push: true
  branch: main
```

Every commit to main will trigger a new build and deployment.

## Security Notes

1. **Environment Variables**: Never commit secrets to Git
2. **Authentication**: The admin panel should be behind additional auth (VPN, OAuth, etc.)
3. **CORS**: Ensure only legitimate domains can make API requests
4. **HTTPS**: Always enforced by DigitalOcean

## Support

For DigitalOcean App Platform issues:
- Documentation: https://docs.digitalocean.com/products/app-platform/
- Community: https://www.digitalocean.com/community/tags/app-platform
