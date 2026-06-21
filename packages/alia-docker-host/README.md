# Alia Docker Host

Container management service for Alia's autonomous agent runtime. Agents create Docker containers to execute code, develop projects, and expose web app previews.

## Architecture

```
Alia API                              This Droplet
+-----------------------+             +-----------------------------------+
| agent-tools.ts        |   HTTP      | alia-docker-api (Express :9090)   |
|   createContainer     | ----------> |   /containers (CRUD)              |
|   exec                |   Bearer    |   /containers/:id/exec            |
|   writeFile/readFile  |   token     |   /containers/:id/files           |
|   exposePort          |             |   /containers/:id/expose          |
|   snapshotContainer   |             |   /containers/:id/snapshot        |
|   destroyContainer    |             |                                   |
+-----------------------+             | alia-preview-proxy (Traefik :443) |
| container-manager.ts  |             |   *.preview.alia.onl -> containers|
|   (HTTP client)       |             |                                   |
+-----------------------+             | Docker Engine                     |
                                      |   [node:22] [python:3.12] [...]   |
                                      +-----------------------------------+
```

## Services

| Container | Port | Description |
|-----------|------|-------------|
| `alia-docker-api` | 9090 | Express server managing container lifecycle via Dockerode |
| `alia-preview-proxy` | 80, 443 | Traefik v3.2 reverse proxy for `*.preview.alia.onl` preview URLs |

## API Endpoints

All endpoints (except `/health`) require `Authorization: Bearer <DOCKER_HOST_SECRET>`.

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/health` | Docker engine info + managed container stats |
| `POST` | `/containers` | Create and start a container |
| `GET` | `/containers` | List managed containers |
| `GET` | `/containers/:id` | Container status |
| `DELETE` | `/containers/:id` | Stop and remove container |
| `POST` | `/containers/:id/exec` | Execute shell command |
| `POST` | `/containers/:id/files/write` | Write file (creates dirs) |
| `GET` | `/containers/:id/files/read` | Read file content |
| `GET` | `/containers/:id/files/list` | List directory |
| `POST` | `/containers/:id/expose` | Expose port via Traefik (returns HTTPS preview URL) |
| `POST` | `/containers/:id/snapshot` | Save container state (docker commit) |
| `GET` | `/snapshots/list` | List saved snapshots |
| `DELETE` | `/snapshots/:tag` | Delete a snapshot |

## Container Sizes

| Size | CPU | Memory | PID Limit |
|------|-----|--------|-----------|
| `small` | 1 core | 512 MB | 512 |
| `medium` | 2 cores | 2 GB | 1024 |
| `large` | 4 cores | 4 GB | 2048 |

## Allowed Base Images

`node:22`, `node:20`, `node:18`, `python:3.12`, `python:3.11`, `ubuntu:24.04`, `ubuntu:22.04`, `golang:1.22`, `ruby:3.3`, `rust:1.77`

## Security

- `--cap-drop ALL` with minimal `--cap-add`
- `no-new-privileges:true`
- PID, CPU, and memory limits per container
- Isolated bridge network (`alia-containers`)
- Internet outbound allowed (for `npm install`, `pip install`, etc.)

## Auto-Cleanup

A background loop runs every 60 seconds and destroys containers that exceed their inactivity timeout:
- **Ephemeral containers**: 30 minutes
- **Persistent containers**: 24 hours

## Setup

### Prerequisites

- DigitalOcean Droplet with Docker pre-installed (Docker 1-click image)
- Recommended: s-4vcpu-8gb or larger
- Wildcard DNS `*.preview.alia.onl` pointing to the Droplet IP

### Deploy

```bash
# On the Droplet
cp .env.example .env
# Edit .env with your DOCKER_HOST_SECRET

docker compose up -d --build
```

Or use the provisioning script from the monorepo root:

```bash
# Copy files to Droplet first, then on the Droplet:
bash /opt/alia-docker-host/../../scripts/setup-docker-host.sh
```

### Environment Variables

See [.env.example](.env.example) for all options.

| Variable | Required | Description |
|----------|----------|-------------|
| `DOCKER_HOST_SECRET` | Yes | Shared secret (must match API's `DOCKER_HOST_SECRET`) |
| `PREVIEW_DOMAIN` | No | Domain for preview URLs (default: `preview.alia.onl`) |
| `ACME_EMAIL` | No | Email for Let's Encrypt certs (default: `admin@alia.onl`) |
| `PORT` | No | API port (default: `9090`) |

### API Server Config

Add to `packages/api/.env`:

```bash
DOCKER_HOST_URL=http://<droplet-ip>:9090
DOCKER_HOST_SECRET=<same-secret-as-above>
```

## Development

```bash
npm install
npm run dev    # Requires Docker socket access
```
