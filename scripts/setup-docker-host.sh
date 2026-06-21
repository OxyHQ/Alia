#!/bin/bash
# ==============================================================================
# Alia Docker Host - Droplet Setup Script
#
# Provisions a DigitalOcean Droplet to run Alia's container execution system.
# Agents create Docker containers on this host to execute code, develop
# projects, and expose web app previews via HTTPS.
#
# Architecture:
#   alia-docker-api    — Express service managing containers via Docker API
#   alia-preview-proxy — Traefik reverse proxy for *.preview.alia.onl
#
# Prerequisites:
#   - DigitalOcean Droplet with Docker pre-installed (Docker 1-click image)
#   - Recommended: s-4vcpu-8gb or larger
#   - Root/SSH access
#   - Wildcard DNS *.preview.alia.onl -> Droplet IP (create via DO control panel)
#
# Usage:
#   1. Create Droplet with Docker 1-click image from DO Marketplace
#   2. Copy packages/alia-docker-host to /opt/alia-docker-host on the Droplet
#   3. Run this script on the Droplet: bash setup-docker-host.sh
# ==============================================================================

set -euo pipefail

echo "=== Alia Docker Host Setup ==="
echo ""

# ── 1. Verify Docker is available ──

echo "[1/5] Verifying Docker..."
if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker not found. Use the Docker 1-click image from DigitalOcean Marketplace."
  exit 1
fi
echo "Docker $(docker --version) found."

if ! docker compose version &>/dev/null; then
  echo "ERROR: Docker Compose plugin not found."
  exit 1
fi
echo "Docker Compose $(docker compose version --short) found."

# ── 2. Configure .env ──

echo "[2/5] Configuring environment..."

cd /opt/alia-docker-host

if [ ! -f .env ]; then
  if [ -z "${DOCKER_HOST_SECRET:-}" ]; then
    read -rp "Enter DOCKER_HOST_SECRET (shared secret, must match API .env): " DOCKER_HOST_SECRET
  fi
  read -rp "Enter PREVIEW_DOMAIN [preview.alia.onl]: " PREVIEW_DOMAIN
  PREVIEW_DOMAIN=${PREVIEW_DOMAIN:-preview.alia.onl}
  read -rp "Enter ACME_EMAIL [admin@alia.onl]: " ACME_EMAIL
  ACME_EMAIL=${ACME_EMAIL:-admin@alia.onl}

  cat > .env << EOF
DOCKER_HOST_SECRET=${DOCKER_HOST_SECRET}
PREVIEW_DOMAIN=${PREVIEW_DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
PORT=9090
NODE_ENV=production
EOF
  echo ".env created."
else
  echo ".env already exists, skipping."
fi

# ── 3. Pre-pull base images ──

echo "[3/5] Pre-pulling base Docker images (parallel)..."
docker pull node:22 &
docker pull python:3.12 &
docker pull ubuntu:22.04 &
wait
echo "Base images ready."

# ── 4. Build and start services ──

echo "[4/5] Building and starting services..."
docker compose up -d --build

# ── 5. Verify ──

echo "[5/5] Verifying deployment..."
sleep 5

if curl -sf http://localhost:9090/health > /dev/null; then
  echo ""
  echo "=== Setup Complete ==="
  echo ""
  echo "Services running:"
  docker ps --format "  {{.Names}}\t{{.Status}}\t{{.Ports}}"
  echo ""
  echo "Health check: curl http://localhost:9090/health"
  echo "Droplet IP:   $(curl -sf ifconfig.me || echo 'unknown')"
  echo ""
  echo "Ensure the following are configured:"
  echo "  - Wildcard DNS: *.${PREVIEW_DOMAIN:-preview.alia.onl} -> this Droplet's IP"
  echo "  - Firewall: ports 22, 80, 443 open; port 9090 restricted to API server IP"
  echo "  - API .env: DOCKER_HOST_URL=http://<this-ip>:9090"
  echo "  - API .env: DOCKER_HOST_SECRET=<same secret as above>"
else
  echo ""
  echo "WARNING: Health check failed. Check logs with:"
  echo "  docker logs alia-docker-api"
  echo "  docker logs alia-preview-proxy"
fi
