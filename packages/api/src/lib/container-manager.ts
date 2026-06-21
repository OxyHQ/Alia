/**
 * Container Manager — HTTP client for the Docker Host management service.
 *
 * All container operations go through this module. It calls the
 * alia-docker-api service running on the dedicated Docker host Droplet.
 */

import { log } from './logger.js';

const DOCKER_HOST_URL = process.env.DOCKER_HOST_URL || '';
const DOCKER_HOST_SECRET = process.env.DOCKER_HOST_SECRET || '';
const DEFAULT_TIMEOUT = 30_000;

export function isContainerSystemAvailable(): boolean {
  return Boolean(DOCKER_HOST_URL && DOCKER_HOST_SECRET);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  timeout = DEFAULT_TIMEOUT,
): Promise<T> {
  if (!DOCKER_HOST_URL || !DOCKER_HOST_SECRET) {
    throw new Error('Container system not configured (DOCKER_HOST_URL / DOCKER_HOST_SECRET missing)');
  }

  const url = `${DOCKER_HOST_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DOCKER_HOST_SECRET}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });

  const data = await res.json() as any;

  if (!res.ok) {
    const msg = data?.error || `Docker host returned ${res.status}`;
    log.agents.error({ status: res.status, path, error: msg }, 'Container manager request failed');
    throw new Error(msg);
  }

  return data as T;
}

// ── Container lifecycle ──

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

export async function createContainer(opts: CreateContainerOpts): Promise<ContainerInfo> {
  return request<ContainerInfo>('POST', '/containers', opts, 60_000);
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function execInContainer(
  containerId: string,
  command: string,
  timeout = 30,
): Promise<ExecResult> {
  return request<ExecResult>(
    'POST',
    `/containers/${containerId}/exec`,
    { command, timeout },
    (timeout + 5) * 1000, // HTTP timeout slightly longer than exec timeout
  );
}

export async function writeFileToContainer(
  containerId: string,
  path: string,
  content: string,
): Promise<void> {
  await request('POST', `/containers/${containerId}/files/write`, { path, content });
}

export async function readFileFromContainer(
  containerId: string,
  path: string,
): Promise<string> {
  const result = await request<{ content: string }>('GET', `/containers/${containerId}/files/read?path=${encodeURIComponent(path)}`);
  return result.content;
}

export async function listFilesInContainer(
  containerId: string,
  dir = '/workspace',
): Promise<Array<{ name: string; type: 'file' | 'directory' }>> {
  const result = await request<{ files: Array<{ name: string; type: 'file' | 'directory' }> }>(
    'GET',
    `/containers/${containerId}/files/list?dir=${encodeURIComponent(dir)}`,
  );
  return result.files;
}

export async function exposeContainerPort(
  containerId: string,
  port: number,
): Promise<string> {
  const result = await request<{ previewUrl: string }>('POST', `/containers/${containerId}/expose`, { port });
  return result.previewUrl;
}

export async function snapshotContainer(
  containerId: string,
  tag: string,
): Promise<string> {
  const result = await request<{ imageTag: string }>('POST', `/containers/${containerId}/snapshot`, { tag });
  return result.imageTag;
}

export async function destroyContainer(containerId: string): Promise<void> {
  await request('DELETE', `/containers/${containerId}`);
}

export async function getContainerStatus(containerId: string): Promise<{
  status: string;
  running: boolean;
  startedAt: string;
  image: string;
}> {
  return request('GET', `/containers/${containerId}`);
}

export async function listContainers(): Promise<ContainerInfo[]> {
  const result = await request<{ containers: ContainerInfo[] }>('GET', '/containers');
  return result.containers;
}
