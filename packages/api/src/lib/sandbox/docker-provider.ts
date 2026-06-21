/**
 * Docker Provider — Wraps the existing container-manager.ts behind the Sandbox interface.
 *
 * This is the current sandbox implementation using Docker containers
 * managed by the alia-docker-api service on a dedicated Droplet.
 */

import * as containerManager from '../container-manager.js';
import type {
  SandboxProvider,
  SandboxInfo,
  ExecResult,
  FileEntry,
  CreateSandboxOptions,
} from './sandbox.interface.js';

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = 'docker';

  isAvailable(): boolean {
    return containerManager.isContainerSystemAvailable();
  }

  async createSandbox(opts: CreateSandboxOptions): Promise<SandboxInfo> {
    const info = await containerManager.createContainer({
      image: opts.image,
      name: opts.name,
      size: opts.size,
      persistent: opts.persistent,
      labels: opts.labels,
    });

    return {
      id: info.containerId,
      name: info.name,
      image: info.image,
      status: info.status,
    };
  }

  async exec(sandboxId: string, command: string, timeoutSeconds = 30): Promise<ExecResult> {
    return containerManager.execInContainer(sandboxId, command, timeoutSeconds);
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    await containerManager.writeFileToContainer(sandboxId, path, content);
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    return containerManager.readFileFromContainer(sandboxId, path);
  }

  async listFiles(sandboxId: string, dir = '/workspace'): Promise<FileEntry[]> {
    return containerManager.listFilesInContainer(sandboxId, dir);
  }

  async exposePort(sandboxId: string, port: number): Promise<string> {
    return containerManager.exposeContainerPort(sandboxId, port);
  }

  async snapshot(sandboxId: string, tag: string): Promise<string> {
    return containerManager.snapshotContainer(sandboxId, tag);
  }

  async destroy(sandboxId: string): Promise<void> {
    await containerManager.destroyContainer(sandboxId);
  }

  async getStatus(sandboxId: string) {
    return containerManager.getContainerStatus(sandboxId);
  }

  async listAll(): Promise<SandboxInfo[]> {
    const containers = await containerManager.listContainers();
    return containers.map(c => ({
      id: c.containerId,
      name: c.name,
      image: c.image,
      status: c.status,
    }));
  }
}
