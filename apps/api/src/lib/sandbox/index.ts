/**
 * Sandbox Factory — Create and manage sandbox providers.
 *
 * Currently supports Docker. The factory pattern makes it easy
 * to add new providers (E2B, Fly.io, etc.) in the future.
 */

export type { SandboxProvider, SandboxInfo, ExecResult, FileEntry, CreateSandboxOptions } from './sandbox.interface.js';
export { DockerSandboxProvider } from './docker-provider.js';

import type { SandboxProvider } from './sandbox.interface.js';
import { DockerSandboxProvider } from './docker-provider.js';

let defaultProvider: SandboxProvider | null = null;

/**
 * Get the sandbox provider. Currently always Docker,
 * but the factory allows swapping providers without
 * changing consumer code.
 */
export function getSandboxProvider(): SandboxProvider {
  if (!defaultProvider) {
    defaultProvider = new DockerSandboxProvider();
  }
  return defaultProvider;
}

/** Check if any sandbox provider is available */
export function isSandboxAvailable(): boolean {
  return getSandboxProvider().isAvailable();
}
