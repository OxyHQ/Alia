/**
 * The terminal an autonomous run's `shell` and `file_edit` primitives act
 * through — of which nothing is left but the refusal.
 *
 * ## There is no sandbox
 *
 * This used to be a persistent bash session in a Docker container claimed from
 * `lib/sandbox/container-pool.ts`, on a dedicated docker host
 * (`packages/alia-docker-host`) reached through `lib/container-manager.ts`.
 * Production never configured that host: the API tasks carried no
 * `DOCKER_HOST_URL`, the pool logged "sandbox not available" on every boot, and
 * every `shell` or `file_edit` call answered "Container system not configured".
 * The host, its client, the pool and the provider are gone.
 *
 * What remains is the surface `agent/actions.ts` still calls, answering exactly
 * what production answered. It exists only because that file builds the `shell`
 * and `file_edit` tools against it; once those two primitives leave
 * `buildRuntimeTools`, this file goes with them.
 */

const NO_SANDBOX = 'No sandbox is available, so there is no terminal or workspace filesystem to act on.';

export class TerminalSession {
  async run(_command: string, _timeout?: number): Promise<string> {
    throw new Error(NO_SANDBOX);
  }

  async readFile(_path: string): Promise<string> {
    throw new Error(NO_SANDBOX);
  }

  async writeFile(_path: string, _content: string): Promise<void> {
    throw new Error(NO_SANDBOX);
  }

  /** Always null: no container can be created. */
  getContainerId(): string | null {
    return null;
  }
}
