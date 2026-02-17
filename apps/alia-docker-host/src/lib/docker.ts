import Dockerode from 'dockerode';
import crypto from 'crypto';
import { log } from '../index.js';

export const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

const NETWORK_NAME = 'alia-containers';

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
  image: string;
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
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const container = docker.getContainer(containerId);

  // Update last activity
  const info = await container.inspect();
  const labels = { ...info.Config.Labels, 'alia.lastActivity': new Date().toISOString() };
  // Note: Docker doesn't support updating labels on a running container directly,
  // but we track it in the label on creation and use the exec timestamp for cleanup.

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

          // Cap output
          if (stdout.length > 50000) {
            stdout = stdout.slice(0, 50000) + '\n... [truncated]';
          }
          if (stderr.length > 50000) {
            stderr = stderr.slice(0, 50000) + '\n... [truncated]';
          }
        }
      });

      stream.on('end', async () => {
        clearTimeout(timer);
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

  // Use exec with heredoc to write file
  const dir = path.substring(0, path.lastIndexOf('/'));
  const escapedContent = content.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
  const cmd = `mkdir -p '${dir}' && cat > '${path}' << 'ALIA_EOF'\n${content}\nALIA_EOF`;

  const exec = await container.exec({
    Cmd: ['bash', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
  });

  return new Promise((resolve, reject) => {
    exec.start({}, (err, stream) => {
      if (err) return reject(err);
      stream?.on('end', () => resolve());
      stream?.on('error', reject);
      stream?.resume(); // drain the stream
    });
  });
}

export async function readFileFromContainer(
  containerId: string,
  path: string,
): Promise<string> {
  const result = await execInContainer(containerId, `cat '${path}'`, 10);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'File not found');
  }
  return result.stdout;
}

export async function listFilesInContainer(
  containerId: string,
  dir = '/workspace',
): Promise<Array<{ name: string; type: 'file' | 'directory' }>> {
  const result = await execInContainer(
    containerId,
    `ls -1pA '${dir}' 2>/dev/null || echo ''`,
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

  return `alia-snapshot:${tag}`;
}

export async function destroyContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    await removePortExposure(containerId);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true });
  } catch (err: any) {
    if (err.statusCode === 404) return; // already gone
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
