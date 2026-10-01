/**
 * A Docker engine in memory, for the service suite.
 *
 * It answers the exact CLI invocations the host makes and BUILDS each
 * container's inspection from the `container create` flags it was given — the
 * way the real engine does — so the inspect-then-refuse check is exercised
 * against what the host actually asked for, not against a fixture that agrees
 * with it by construction. `tamper` then lets a test change a property behind
 * the host's back, as an operator or another process could.
 */
import type { DockerOptions, DockerResult, DockerRunner } from '../docker.js';

export interface FakeContainer {
  name: string;
  running: boolean;
  inspection: Record<string, unknown> & {
    HostConfig: Record<string, unknown>;
    Config: Record<string, unknown>;
    Name?: unknown;
    Mounts?: unknown;
    NetworkSettings?: unknown;
  };
}

const ok = (stdout = ''): DockerResult => ({ stdout, stderr: '', exitCode: 0, timedOut: false, interrupted: false, truncated: false });
const fail = (stderr = 'Error'): DockerResult => ({ stdout: '', stderr, exitCode: 1, timedOut: false, interrupted: false, truncated: false });

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((arg, i) => {
    if (arg === flag && i + 1 < args.length) values.push(args[i + 1] as string);
  });
  return values;
}

export function inspectionFromCreate(args: string[]): FakeContainer['inspection'] {
  const name = flagValues(args, '--name')[0] as string;
  const labels = Object.fromEntries(flagValues(args, '--label').map((l) => l.split('=') as [string, string]));
  const tmpfs = Object.fromEntries(flagValues(args, '--tmpfs').map((t) => [t.slice(0, t.indexOf(':')), t.slice(t.indexOf(':') + 1)]));
  const mount = flagValues(args, '--mount')[0] ?? '';
  const mountParts = Object.fromEntries(mount.split(',').map((kv) => kv.split('=') as [string, string]));
  const entrypointIndex = args.indexOf('--entrypoint');
  const image = args[entrypointIndex + 2] as string;
  const cmd = args.slice(entrypointIndex + 3);
  const memory = 512 * 1024 * 1024;
  return {
    Id: `id-${name}`,
    Name: `/${name}`,
    Config: {
      Image: image,
      User: flagValues(args, '--user')[0] ?? '',
      Labels: labels,
      Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_VERSION=22', 'YARN_VERSION=1', ...flagValues(args, '--env')],
      Entrypoint: [flagValues(args, '--entrypoint')[0]],
      Cmd: cmd,
      WorkingDir: flagValues(args, '--workdir')[0] ?? '',
    },
    HostConfig: {
      Runtime: flagValues(args, '--runtime')[0] ?? 'runc',
      ReadonlyRootfs: args.includes('--read-only'),
      Privileged: args.includes('--privileged'),
      CapDrop: flagValues(args, '--cap-drop'),
      CapAdd: null,
      SecurityOpt: flagValues(args, '--security-opt'),
      NetworkMode: flagValues(args, '--network')[0] ?? 'bridge',
      Memory: memory,
      MemorySwap: memory,
      PidsLimit: Number(flagValues(args, '--pids-limit')[0] ?? 0),
      NanoCpus: Number(flagValues(args, '--cpus')[0] ?? 0) * 1e9,
      Binds: null,
      Devices: null,
      DeviceRequests: null,
      PortBindings: {},
      PidMode: '',
      IpcMode: flagValues(args, '--ipc')[0] ?? 'shareable',
      UsernsMode: '',
      Tmpfs: tmpfs,
      RestartPolicy: { Name: flagValues(args, '--restart')[0] ?? 'no' },
    },
    Mounts: [{ Type: mountParts.type, Name: mountParts.source, Destination: mountParts.target, RW: true }],
    NetworkSettings: { Networks: { none: {} } },
    State: { Running: false },
  };
}

export type ExecHandler = (args: string[], options: DockerOptions) => DockerResult | Promise<DockerResult>;

export class FakeDocker {
  readonly containers = new Map<string, FakeContainer>();
  readonly volumes = new Map<string, { Labels: Record<string, string>; Driver: string; Options: Record<string, string> | null }>();
  readonly calls: string[][] = [];
  exec: ExecHandler = () => ok('');

  readonly run: DockerRunner = async (args, options) => {
    this.calls.push(args);
    const [group, verb] = args;
    if (group === 'container' && verb === 'ls') {
      const nameFilter = args.find((a) => a.startsWith('name=^/'));
      if (nameFilter) {
        const name = nameFilter.slice('name=^/'.length, -1);
        const container = this.containers.get(name);
        if (!container) return ok('');
        return ok(args.includes('{{.State}}') ? `${container.running ? 'running' : 'exited'}\n` : `id-${name}\n`);
      }
      const running = [...this.containers.values()].filter((c) => c.running);
      return ok(running.map((c) => `${(c.inspection.Config.Labels as Record<string, string>)['onl.alia.computer.actor']}\n`).join(''));
    }
    if (group === 'container' && verb === 'inspect') {
      const container = this.containers.get(args[2] as string);
      if (!container) return fail();
      return ok(JSON.stringify([{ ...container.inspection, State: { Running: container.running } }]));
    }
    if (group === 'container' && verb === 'create') {
      const inspection = inspectionFromCreate(args);
      const name = (inspection.Name as string).slice(1);
      this.containers.set(name, { name, running: false, inspection });
      return ok(`id-${name}`);
    }
    if (group === 'container' && verb === 'start') {
      const container = this.containers.get(args[2] as string);
      if (!container) return fail();
      container.running = true;
      return ok();
    }
    if (group === 'container' && verb === 'stop') {
      const container = this.containers.get(args[args.length - 1] as string);
      if (container) container.running = false;
      return ok();
    }
    if (group === 'container' && verb === 'rm') {
      this.containers.delete(args[args.length - 1] as string);
      return ok();
    }
    if (group === 'volume' && verb === 'ls') {
      const name = (args.find((a) => a.startsWith('name=^')) ?? '').slice('name=^'.length, -1);
      return ok(this.volumes.has(name) ? `${name}\n` : '');
    }
    if (group === 'volume' && verb === 'create') {
      const name = args[args.length - 1] as string;
      const labels = Object.fromEntries(flagValues(args, '--label').map((l) => l.split('=') as [string, string]));
      this.volumes.set(name, { Labels: labels, Driver: 'local', Options: null });
      return ok(name);
    }
    if (group === 'volume' && verb === 'inspect') {
      const name = args[2] as string;
      const volume = this.volumes.get(name);
      if (!volume) return fail();
      return ok(JSON.stringify([{ Name: name, Scope: 'local', ...volume }]));
    }
    if (group === 'exec') return this.exec(args, options);
    return fail(`unexpected docker call: ${args.join(' ')}`);
  };

  /** Change a property of a container behind the host's back. */
  tamper(name: string, edit: (inspection: FakeContainer['inspection']) => void): void {
    const container = this.containers.get(name);
    if (!container) throw new Error(`no container ${name}`);
    edit(container.inspection);
  }

  execCalls(): string[][] {
    return this.calls.filter((call) => call[0] === 'exec');
  }
}

export { ok, fail };
