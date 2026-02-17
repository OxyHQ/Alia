#!/bin/bash
# ==============================================================================
# Alia Docker Host - Droplet Setup Script
#
# Run this on a fresh Ubuntu 24.04 DigitalOcean Droplet to set up the Docker
# host for Alia's container execution system.
#
# Prerequisites:
#   - Ubuntu 24.04 Droplet (recommended: s-4vcpu-8gb or larger)
#   - Root access
#
# Usage:
#   curl -sSL <raw-url> | bash
#   OR
#   bash setup-docker-host.sh
# ==============================================================================

set -euo pipefail

echo "=== Alia Docker Host Setup ==="

# ── 1. Install Docker Engine ──

echo "[1/7] Installing Docker Engine..."
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable docker
systemctl start docker

echo "Docker $(docker --version) installed."

# ── 2. Configure UFW Firewall ──

echo "[2/7] Configuring firewall..."
apt-get install -y -qq ufw

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (Traefik)
ufw allow 443/tcp   # HTTPS (Traefik)
# Port 9090 (management API) should be restricted to the API server IP.
# Uncomment and replace with your API server's IP:
# ufw allow from <API_SERVER_IP> to any port 9090

# For initial setup, allow 9090 from anywhere (restrict later):
ufw allow 9090/tcp

ufw --force enable
echo "Firewall configured."

# ── 3. Create project directory ──

echo "[3/7] Setting up project directory..."
mkdir -p /opt/alia-docker-host
cd /opt/alia-docker-host

# ── 4. Prompt for configuration ──

echo "[4/7] Configuration..."

if [ ! -f .env ]; then
  echo "Creating .env file..."

  read -p "Enter DOCKER_HOST_SECRET (shared secret for API auth): " DOCKER_HOST_SECRET
  read -p "Enter DO_DNS_TOKEN (DigitalOcean API token for DNS): " DO_DNS_TOKEN
  read -p "Enter PREVIEW_DOMAIN [preview.alia.onl]: " PREVIEW_DOMAIN
  PREVIEW_DOMAIN=${PREVIEW_DOMAIN:-preview.alia.onl}
  read -p "Enter ACME_EMAIL [admin@alia.onl]: " ACME_EMAIL
  ACME_EMAIL=${ACME_EMAIL:-admin@alia.onl}

  cat > .env << EOF
DOCKER_HOST_SECRET=${DOCKER_HOST_SECRET}
DO_DNS_TOKEN=${DO_DNS_TOKEN}
PREVIEW_DOMAIN=${PREVIEW_DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
PORT=9090
EOF

  echo ".env file created."
else
  echo ".env file already exists, skipping."
fi

# ── 5. Copy service files ──

echo "[5/7] Copying service files..."
echo "Please copy the apps/docker-host directory contents to /opt/alia-docker-host"
echo "  scp -r apps/docker-host/* root@<droplet-ip>:/opt/alia-docker-host/"

# ── 6. Pre-pull base images ──

echo "[6/7] Pre-pulling base Docker images..."
docker pull node:22 &
docker pull python:3.12 &
docker pull ubuntu:22.04 &
docker pull golang:1.22 &
wait
echo "Base images pulled."

# ── 7. Create Traefik dynamic config directory ──

echo "[7/7] Creating Traefik config directory..."
mkdir -p /etc/traefik/dynamic

# ── Done ──

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Copy apps/docker-host/ files to /opt/alia-docker-host/"
echo "  2. Set up wildcard DNS: *.${PREVIEW_DOMAIN:-preview.alia.onl} -> $(curl -s ifconfig.me)"
echo "  3. Restrict port 9090 in UFW to your API server IP:"
echo "     ufw delete allow 9090/tcp"
echo "     ufw allow from <API_SERVER_IP> to any port 9090"
echo "  4. cd /opt/alia-docker-host && docker compose up -d"
echo "  5. Verify: curl http://localhost:9090/health"
echo ""
