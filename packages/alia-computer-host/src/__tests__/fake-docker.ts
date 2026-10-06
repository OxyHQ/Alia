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

let addressCounter = 2;
function nextAddress(): string {
  addressCounter += 1;
  return `172.30.0.${addressCounter}`;
}

function labelFilters(args: string[]): Array<[string, string]> {
  return flagValues(args, '--filter')
    .filter((f) => f.startsWith('label='))
    .map((f) => {
      const [key, value] = f.slice('label='.length).split('=') as [string, string];
      return [key, value];
    });
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
  const memory = Number.parseInt(flagValues(args, '--memory')[0] ?? '512', 10) * 1024 * 1024;
  const network = flagValues(args, '--network')[0] ?? 'bridge';
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
      NetworkMode: network,
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
    Mounts: mount ? [{ Type: mountParts.type, Name: mountParts.source, Destination: mountParts.target, RW: true }] : [],
    NetworkSettings: { Networks: { [network]: network === 'none' ? {} : { IPAddress: nextAddress() } } },
    State: { Running: false },
  };
}

export type ExecHandler = (args: string[], options: DockerOptions) => DockerResult | Promise<DockerResult>;

export class FakeDocker {
  readonly containers = new Map<string, FakeContainer>();
  readonly volumes = new Map<string, { Labels: Record<string, string>; Driver: string; Options: Record<string, string> | null }>();
  readonly networks = new Map<string, { Labels: Record<string, string>; Internal: boolean; Options: Record<string, string>; members: Set<string> }>();
  /** The control API's own container, as `container inspect --format {{.Name}}` names it. */
  selfName = 'alia-computer-host';
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
      const filters = labelFilters(args);
      const onlyRunning = args.includes('status=running');
      const matching = [...this.containers.values()].filter((c) => {
        const labels = (c.inspection.Config.Labels ?? {}) as Record<string, string>;
        return (!onlyRunning || c.running) && filters.every(([key, value]) => labels[key] === value);
      });
      if (args.includes('{{.Names}}')) return ok(matching.map((c) => `${c.name}\n`).join(''));
      return ok(matching.map((c) => `${(c.inspection.Config.Labels as Record<string, string>)['onl.alia.computer.actor']}\n`).join(''));
    }
    if (group === 'container' && verb === 'inspect' && args[2] === '--format') {
      return ok(`/${this.selfName}\n`);
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
      const name = args[args.length - 1] as string;
      this.containers.delete(name);
      for (const network of this.networks.values()) network.members.delete(name);
      return ok();
    }
    if (group === 'network' && verb === 'ls') {
      const name = (args.find((a) => a.startsWith('name=^')) ?? '').slice('name=^'.length, -1);
      return ok(this.networks.has(name) ? `${name}\n` : '');
    }
    if (group === 'network' && verb === 'create') {
      const name = args[args.length - 1] as string;
      const labels = Object.fromEntries(flagValues(args, '--label').map((l) => l.split('=') as [string, string]));
      this.networks.set(name, { Labels: labels, Internal: args.includes('--internal'), Options: {}, members: new Set() });
      return ok(name);
    }
    if (group === 'network' && verb === 'connect') {
      const [, , name, container] = args as [string, string, string, string];
      const network = this.networks.get(name);
      if (!network) return fail();
      const target = container === 'self-id' ? this.selfName : container;
      network.members.add(target);
      const found = this.containers.get(target);
      if (found) {
        const settings = found.inspection.NetworkSettings as { Networks: Record<string, unknown> };
        settings.Networks[name] = { IPAddress: nextAddress() };
      }
      return ok();
    }
    if (group === 'network' && verb === 'inspect') {
      const name = args[2] as string;
      const network = this.networks.get(name);
      if (!network) return fail();
      const members = new Set(network.members);
      for (const container of this.containers.values()) {
        const settings = container.inspection.NetworkSettings as { Networks: Record<string, unknown> };
        if (container.running && settings.Networks[name]) members.add(container.name);
      }
      return ok(JSON.stringify([{
        Name: name,
        Driver: 'bridge',
        Internal: network.Internal,
        EnableIPv6: false,
        Labels: network.Labels,
        Options: network.Options,
        Containers: Object.fromEntries([...members].map((member) => [`id-${member}`, { Name: member }])),
      }]));
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
