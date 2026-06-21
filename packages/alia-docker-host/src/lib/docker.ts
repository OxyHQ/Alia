import Dockerode from 'dockerode';
import crypto from 'crypto';
import { log } from '../index.js';

export const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

const NETWORK_NAME = 'alia-containers';
const WORKSPACE_ROOT = '/workspace';
const MAX_BASE64_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_BASE64_OUTPUT_CHARS = 15 * 1024 * 1024; // >10MB base64 payload
const DEFAULT_EXEC_OUTPUT_CHARS = 50_000;
const runtimeLastActivity = new Map<string, number>();

function shortId(containerId: string): string {
  return containerId.slice(0, 12);
}

export function touchContainerActivity(containerId: string): void {
  runtimeLastActivity.set(shortId(containerId), Date.now());
}

export function getContainerLastActivity(containerId: string): number | undefined {
  return runtimeLastActivity.get(shortId(containerId));
}

export function forgetContainerActivity(containerId: string): void {
  runtimeLastActivity.delete(shortId(containerId));
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeWorkspacePath(inputPath: string): string {
  let normalized = inputPath.replace(/\\/g, '/').trim();
  if (!normalized || normalized.includes('\0')) {
    throw new Error('Invalid path');
  }

  if (normalized.startsWith('/')) normalized = normalized.slice(1);
  if (normalized.startsWith('workspace/')) {
    normalized = normalized.slice('workspace/'.length);
  } else if (normalized === 'workspace') {
    return WORKSPACE_ROOT;
  }

  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw new Error('Path traversal is not allowed');
    segments.push(segment);
  }

  if (segments.length === 0) return WORKSPACE_ROOT;
  return `${WORKSPACE_ROOT}/${segments.join('/')}`;
}

export interface SizePreset {
  cpus: number;
  memory: number;   // bytes
  pidsLimit: number;
}

export const SIZE_PRESETS: Record<string, SizePreset> = {
  small:  { cpus: 1, memory: 512 * 1024 * 1024,  pidsLimit: 512 },
  medium: { cpus: 2, memory: 2048 * 1024 * 1024,  pidsLimit: 1024 },
  large:  { cpus: 4, memory: 4096 * 1024 * 1024,  pidsLimit: 2048 },
};

const ALLOWED_IMAGES = [
  'node:22', 'node:20', 'node:18',
  'python:3.12', 'python:3.11',
  'ubuntu:24.04', 'ubuntu:22.04',
  'golang:1.22',
  'ruby:3.3',
  'rust:1.77',
];

export interface CreateContainerOpts {
  image?: string;
  name?: string;
  size?: string;
  persistent?: boolean;
  labels?: Record<string, string>;
}

export interface ContainerInfo {
  containerId: string;
  name: string;
  image: string;
  status: string;
}

export async function ensureNetwork(): Promise<void> {
  try {
    await docker.getNetwork(NETWORK_NAME).inspect();
  } catch {
    await docker.createNetwork({
      Name: NETWORK_NAME,
      Driver: 'bridge',
      Internal: false,
    });
    log.info('Created Docker network: %s', NETWORK_NAME);
  }
}

export async function createContainer(opts: CreateContainerOpts): Promise<ContainerInfo> {
  const image = opts.image || 'ubuntu:22.04';
  if (!ALLOWED_IMAGES.includes(image)) {
    throw new Error(`Image not allowed: ${image}. Allowed: ${ALLOWED_IMAGES.join(', ')}`);
  }

  // Ensure image is pulled
  try {
    await docker.getImage(image).inspect();
  } catch {
    log.info('Pulling image: %s', image);
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
    });
  }

  const preset = SIZE_PRESETS[opts.size || 'small'] || SIZE_PRESETS.small;
  const name = opts.name || `alia-${crypto.randomUUID().slice(0, 12)}`;
  const timeoutMinutes = opts.persistent ? 1440 : 30;

  const labels: Record<string, string> = {
    'alia.managed': 'true',
    'alia.persistent': String(opts.persistent || false),
    'alia.timeout': String(timeoutMinutes),
    'alia.lastActivity': new Date().toISOString(),
    ...opts.labels,
  };

  const container = await docker.createContainer({
    Image: image,
    name,
    Labels: labels,
    Cmd: ['sleep', 'infinity'],
    WorkingDir: '/workspace',
    HostConfig: {
      Memory: preset.memory,
      NanoCpus: preset.cpus * 1e9,
      PidsLimit: preset.pidsLimit,
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'NET_BIND_SERVICE', 'DAC_OVERRIDE', 'FOWNER', 'SYS_CHROOT', 'KILL'],
      SecurityOpt: ['no-new-privileges:true'],
      NetworkMode: NETWORK_NAME,
      RestartPolicy: { Name: '' },
    },
  });

  await container.start();

  // Create /workspace directory
  const exec = await container.exec({
    Cmd: ['mkdir', '-p', '/workspace'],
    AttachStdout: false,
    AttachStderr: false,
  });
  await exec.start({ Detach: true });

  const info = await container.inspect();
  touchContainerActivity(info.Id);
  return {
    containerId: info.Id.slice(0, 12),
    name,
    image,
    status: info.State.Status,
  };
}

export async function execInContainer(
  containerId: string,
  command: string,
  timeout = 30,
  maxOutputChars = DEFAULT_EXEC_OUTPUT_CHARS,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const container = docker.getContainer(containerId);
  touchContainerActivity(containerId);

  const exec = await container.exec({
    Cmd: ['bash', '-c', command],
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: '/workspace',
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeout}s`));
    }, timeout * 1000);

    exec.start({}, (err, stream) => {
      if (err || !stream) {
        clearTimeout(timer);
        return reject(err || new Error('No stream'));
      }

      let stdout = '';
      let stderr = '';

      // Docker multiplexes stdout/stderr into a single stream with headers
      // Each frame: [type(1) | 0(3) | size(4) | data(size)]
      stream.on('data', (chunk: Buffer) => {
        // Parse multiplexed stream
        let offset = 0;
        while (offset < chunk.length) {
          if (offset + 8 > chunk.length) {
            // Partial header, treat as raw stdout
            stdout += chunk.slice(offset).toString();
            break;
          }
          const type = chunk[offset];
          const size = chunk.readUInt32BE(offset + 4);
          const data = chunk.slice(offset + 8, offset + 8 + size).toString();
          offset += 8 + size;

          if (type === 1) {
            stdout += data;
          } else if (type === 2) {
            stderr += data;
          } else {
            stdout += data;
          }

          // Cap output to avoid unbounded memory growth on noisy commands.
          if (maxOutputChars > 0 && stdout.length > maxOutputChars) {
            stdout = stdout.slice(0, maxOutputChars) + '\n... [truncated]';
          }
          if (maxOutputChars > 0 && stderr.length > maxOutputChars) {
            stderr = stderr.slice(0, maxOutputChars) + '\n... [truncated]';
          }
        }
      });

      stream.on('end', async () => {
        clearTimeout(timer);
        touchContainerActivity(containerId);
        try {
          const inspectResult = await exec.inspect();
          resolve({ stdout, stderr, exitCode: inspectResult.ExitCode ?? 0 });
        } catch {
          resolve({ stdout, stderr, exitCode: 0 });
        }
      });

      stream.on('error', (streamErr: Error) => {
        clearTimeout(timer);
        reject(streamErr);
      });
    });
  });
}

export async function writeFileToContainer(
  containerId: string,
  path: string,
  content: string,
): Promise<void> {
  const container = docker.getContainer(containerId);
  const safePath = normalizeWorkspacePath(path);

  // Use exec with heredoc to write file
  const dir = safePath.substring(0, safePath.lastIndexOf('/'));
  const cmd = `mkdir -p ${shellEscape(dir || WORKSPACE_ROOT)} && cat > ${shellEscape(safePath)} << 'ALIA_EOF'\n${content}\nALIA_EOF`;

  const exec = await container.exec({
    Cmd: ['bash', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
  });

  return new Promise((resolve, reject) => {
    exec.start({}, (err, stream) => {
      if (err) return reject(err);
      stream?.on('end', () => {
        touchContainerActivity(containerId);
        resolve();
      });
      stream?.on('error', reject);
      stream?.resume(); // drain the stream
    });
  });
}

export async function readFileFromContainer(
  containerId: string,
  path: string,
): Promise<string> {
  const safePath = normalizeWorkspacePath(path);
  const result = await execInContainer(containerId, `cat -- ${shellEscape(safePath)}`, 10);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'File not found');
  }
  return result.stdout;
}

export async function readFileRawFromContainer(
  containerId: string,
  path: string,
): Promise<Buffer> {
  const safePath = normalizeWorkspacePath(path);
  const result = await execInContainer(
    containerId,
    `if [ ! -f ${shellEscape(safePath)} ]; then echo "File not found" >&2; exit 1; fi; ` +
    `size=$(wc -c < ${shellEscape(safePath)}); ` +
    `if [ "$size" -gt ${MAX_BASE64_FILE_SIZE} ]; then echo "File too large" >&2; exit 2; fi; ` +
    `base64 -w 0 -- ${shellEscape(safePath)}`,
    20,
    MAX_BASE64_OUTPUT_CHARS,
  );

  if (result.exitCode === 2) {
    throw new Error('File too large to download');
  }
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'File not found');
  }

  const encoded = result.stdout.trim();
  return Buffer.from(encoded, 'base64');
}

export async function listFilesInContainer(
  containerId: string,
  dir = '/workspace',
): Promise<Array<{ name: string; type: 'file' | 'directory' }>> {
  const safeDir = normalizeWorkspacePath(dir);
  const result = await execInContainer(
    containerId,
    `ls -1pA -- ${shellEscape(safeDir)} 2>/dev/null || echo ''`,
    10,
  );

  if (!result.stdout.trim()) return [];

  return result.stdout.trim().split('\n').map(line => {
    const isDir = line.endsWith('/');
    return {
      name: isDir ? line.slice(0, -1) : line,
      type: isDir ? 'directory' as const : 'file' as const,
    };
  });
}

export async function exposeContainerPort(
  containerId: string,
  port: number,
  previewDomain: string,
): Promise<string> {
  // Traefik uses Docker labels for service discovery.
  // Since we can't update labels on a running container, we use the Traefik
  // file provider instead. We write a dynamic config file that Traefik watches.
  const fs = await import('fs/promises');
  const configDir = '/etc/traefik/dynamic';

  await fs.mkdir(configDir, { recursive: true });

  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  const containerIp = info.NetworkSettings.Networks[NETWORK_NAME]?.IPAddress;

  if (!containerIp) {
    throw new Error('Container has no IP in the alia-containers network');
  }

  const routerName = `container-${containerId}-${port}`;
  const host = `${containerId}-${port}.${previewDomain}`;

  const config = {
    http: {
      routers: {
        [routerName]: {
          rule: `Host(\`${host}\`)`,
          service: routerName,
          entryPoints: ['websecure'],
          tls: { certResolver: 'letsencrypt' },
        },
        [`${routerName}-http`]: {
          rule: `Host(\`${host}\`)`,
          service: routerName,
          entryPoints: ['web'],
        },
      },
      services: {
        [routerName]: {
          loadBalancer: {
            servers: [{ url: `http://${containerIp}:${port}` }],
          },
        },
      },
    },
  };

  await fs.writeFile(
    `${configDir}/${routerName}.json`,
    JSON.stringify(config, null, 2),
  );

  touchContainerActivity(containerId);
  return `https://${host}`;
}

export async function removePortExposure(containerId: string): Promise<void> {
  const fs = await import('fs/promises');
  const configDir = '/etc/traefik/dynamic';
  try {
    const files = await fs.readdir(configDir);
    for (const file of files) {
      if (file.startsWith(`container-${containerId}`)) {
        await fs.unlink(`${configDir}/${file}`);
      }
    }
  } catch {
    // Config dir might not exist yet
  }
}

export async function snapshotContainer(
  containerId: string,
  tag: string,
): Promise<string> {
  const container = docker.getContainer(containerId);
  const image = await container.commit({
    repo: 'alia-snapshot',
    tag,
    comment: `Snapshot created at ${new Date().toISOString()}`,
  });

  touchContainerActivity(containerId);
  return `alia-snapshot:${tag}`;
}

export async function destroyContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    await removePortExposure(containerId);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true });
    forgetContainerActivity(containerId);
  } catch (err: any) {
    if (err.statusCode === 404) {
      forgetContainerActivity(containerId);
      return; // already gone
    }
    throw err;
  }
}

export async function getContainerStatus(containerId: string): Promise<{
  status: string;
  running: boolean;
  startedAt: string;
  image: string;
  labels: Record<string, string>;
}> {
  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  touchContainerActivity(containerId);
  return {
    status: info.State.Status,
    running: info.State.Running,
    startedAt: info.State.StartedAt,
    image: info.Config.Image,
    labels: info.Config.Labels,
  };
}

export async function listManagedContainers(): Promise<ContainerInfo[]> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: ['alia.managed=true'] },
  });

  return containers.map(c => ({
    containerId: c.Id.slice(0, 12),
    name: c.Names[0]?.replace(/^\//, '') || '',
    image: c.Image,
    status: c.State,
  }));
}

export async function listSnapshots(): Promise<Array<{
  tag: string;
  id: string;
  size: number;
  created: string;
}>> {
  const images = await docker.listImages({
    filters: { reference: ['alia-snapshot'] },
  });

  return images.map(img => ({
    tag: img.RepoTags?.[0]?.split(':')?.[1] || 'unknown',
    id: img.Id.slice(0, 12),
    size: img.Size,
    created: new Date(img.Created * 1000).toISOString(),
  }));
}

export async function deleteSnapshot(tag: string): Promise<void> {
  const image = docker.getImage(`alia-snapshot:${tag}`);
  await image.remove();
}
