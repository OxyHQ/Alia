/**
 * Who a container belongs to, how it must be built, and the check that refuses
 * to attach to anything else.
 *
 * Adapted from OpenMuse `apps/server/src/computer.ts` (MIT, see ../NOTICE).
 *
 * ## Inspect, then refuse
 *
 * The host never trusts a container because of its NAME. Anyone with access to
 * the Docker engine — an operator, a bug in an earlier version of this host —
 * can create a container called `alia-computer-…` with a bind mount of `/`,
 * `--privileged` or a network. So before every start, exec or file operation
 * the host inspects the container and compares EVERY isolation property with
 * what {@link createArgs} would have produced. One difference and the call is
 * refused with 409: a container this host did not build to spec is never
 * entered, whatever it is called.
 *
 * The two lists below — the flags and the check — are one contract written
 * twice on purpose. `isolation.test.ts` builds an inspection from the flags'
 * intent and then breaks each property in turn, so a flag removed from one
 * side and not the other fails a test rather than shipping.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { HostError } from './errors.js';

export const WORKSPACE = '/workspace';
export const CONTAINER_USER = '1000:1000';
export const MEMORY_BYTES = 512 * 1024 * 1024;
export const NANO_CPUS = 1_000_000_000;
export const PIDS_LIMIT = 128;
export const TMPFS_OPTIONS = 'rw,nosuid,nodev,noexec,size=67108864,mode=1777';
export const MANAGED_LABEL = 'onl.alia.computer.managed';
const MANAGED_VALUE = 'computer-v1';

/**
 * An actor is whoever the computer belongs to — an agent for one person, or
 * Alia for one person. The Alia API composes the id; the host only requires it
 * to be a short, inert token and never parses meaning out of it.
 */
export const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;

export function assertActorId(actorId: string): string {
  if (!ACTOR_ID.test(actorId)) throw new HostError('Invalid actor id', 400, 'invalid_actor');
  return actorId;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export interface ComputerIdentity {
  container: string;
  volume: string;
  labels: Readonly<Record<string, string>>;
  /** The non-reversible handle logs carry instead of the actor id. */
  actorHash: string;
}

export function computerIdentity(deploymentId: string, actorId: string): ComputerIdentity {
  const deployment = hash(deploymentId).slice(0, 12);
  const actorHash = hash(actorId).slice(0, 24);
  const name = `alia-computer-${deployment}-${actorHash}`;
  return {
    container: name,
    volume: `${name}-workspace`,
    labels: {
      [MANAGED_LABEL]: MANAGED_VALUE,
      'onl.alia.computer.deployment': deployment,
      'onl.alia.computer.actor': actorHash,
    },
    actorHash,
  };
}

/** The label filter that finds every container this deployment manages. */
export function managedFilter(deploymentId: string): string[] {
  return [
    '--filter',
    `label=${MANAGED_LABEL}=${MANAGED_VALUE}`,
    '--filter',
    `label=onl.alia.computer.deployment=${hash(deploymentId).slice(0, 12)}`,
  ];
}

/**
 * A caller-supplied path, as an absolute path under `/workspace`, or a refusal.
 *
 * Rejects rather than sanitises: a `..` segment is an error, not something to
 * drop, because a caller that sent one is asking for something this cannot
 * give. `files.py` re-checks inside the container and also refuses symlinks
 * component by component — this is the first of two gates, not the only one.
 */
export function workspacePath(path: string): string {
  if (
    typeof path !== 'string' ||
    path.includes('\0') ||
    path.length > 2048 ||
    !path.startsWith(WORKSPACE) ||
    path.split('/').includes('..')
  ) {
    throw new HostError('Choose an absolute path inside /workspace', 422, 'invalid_path');
  }
  const normalized = posix.normalize(path).replace(/\/+$/, '') || '/';
  if (normalized !== WORKSPACE && !normalized.startsWith(`${WORKSPACE}/`)) {
    throw new HostError('Choose an absolute path inside /workspace', 422, 'invalid_path');
  }
  return normalized;
}

/** `docker container create` arguments: the isolation contract, as flags. */
export function createArgs(identity: ComputerIdentity, image: string, runtime: string): string[] {
  const labels = Object.entries(identity.labels).flatMap(([key, value]) => [
    '--label',
    `${key}=${value}`,
  ]);
  return [
    'container',
    'create',
    '--pull',
    'never',
    '--name',
    identity.container,
    ...labels,
    '--runtime',
    runtime,
    '--user',
    CONTAINER_USER,
    '--workdir',
    WORKSPACE,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--network',
    'none',
    '--ipc',
    'private',
    '--memory',
    '512m',
    '--memory-swap',
    '512m',
    '--cpus',
    '1',
    '--pids-limit',
    String(PIDS_LIMIT),
    '--restart',
    'no',
    '--tmpfs',
    `/tmp:${TMPFS_OPTIONS}`,
    '--mount',
    `type=volume,source=${identity.volume},target=${WORKSPACE}`,
    '--env',
    `HOME=${WORKSPACE}`,
    '--env',
    'LANG=C.UTF-8',
    '--entrypoint',
    '/usr/bin/sleep',
    image,
    'infinity',
  ];
}

export function volumeCreateArgs(identity: ComputerIdentity): string[] {
  const labels = Object.entries(identity.labels).flatMap(([key, value]) => [
    '--label',
    `${key}=${value}`,
  ]);
  return ['volume', 'create', ...labels, identity.volume];
}

export const inspectionSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Config: z.object({
    Image: z.string(),
    User: z.string(),
    Labels: z.record(z.string(), z.string()).nullable(),
    Env: z.array(z.string()),
    Entrypoint: z.array(z.string()).nullable(),
    Cmd: z.array(z.string()).nullable(),
    WorkingDir: z.string(),
    ExposedPorts: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  HostConfig: z.object({
    Runtime: z.string(),
    ReadonlyRootfs: z.boolean(),
    Privileged: z.boolean(),
    CapDrop: z.array(z.string()).nullable(),
    CapAdd: z.array(z.string()).nullable(),
    SecurityOpt: z.array(z.string()).nullable(),
    NetworkMode: z.string(),
    Memory: z.number(),
    MemorySwap: z.number(),
    PidsLimit: z.number().nullable(),
    NanoCpus: z.number(),
    Binds: z.array(z.string()).nullable(),
    Devices: z.array(z.unknown()).nullable(),
    DeviceRequests: z.array(z.unknown()).nullable(),
    PortBindings: z.record(z.string(), z.unknown()).nullable(),
    PidMode: z.string(),
    IpcMode: z.string(),
    UsernsMode: z.string().optional(),
    Tmpfs: z.record(z.string(), z.string()).nullable(),
    RestartPolicy: z.object({ Name: z.string() }),
  }),
  Mounts: z.array(
    z.object({
      Type: z.string(),
      Name: z.string().optional(),
      Destination: z.string(),
      RW: z.boolean(),
    }),
  ),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.unknown()).nullable() }),
  State: z.object({ Running: z.boolean() }),
});

export type Inspection = z.infer<typeof inspectionSchema>;

/** The environment variable NAMES the workspace image may carry; values are not ours to judge. */
const ALLOWED_ENV = new Set(['PATH', 'HOME', 'LANG', 'NODE_VERSION', 'YARN_VERSION']);

export const empty = (list: readonly unknown[] | null | undefined) => !list?.length;

/**
 * Every property that must hold, by name, so a refusal can say WHICH one failed
 * in the host's log (never in the response — see `HostError`).
 */
export function isolationViolations(
  raw: unknown,
  identity: ComputerIdentity,
  image: string,
  runtime: string,
): { inspection: Inspection | null; violations: string[] } {
  const parsed = z.array(inspectionSchema).length(1).safeParse(raw);
  if (!parsed.success) return { inspection: null, violations: ['inspection_shape'] };
  const c = parsed.data[0];
  const h = c.HostConfig;
  const checks: Record<string, boolean> = {
    name: c.Name === `/${identity.container}`,
    image: c.Config.Image === image,
    user: c.Config.User === CONTAINER_USER,
    workdir: c.Config.WorkingDir === WORKSPACE,
    labels: Object.entries(identity.labels).every(
      ([key, value]) => c.Config.Labels?.[key] === value,
    ),
    env: c.Config.Env.every((value) => ALLOWED_ENV.has(value.split('=')[0] ?? '')),
    entrypoint: JSON.stringify(c.Config.Entrypoint) === '["/usr/bin/sleep"]',
    cmd: JSON.stringify(c.Config.Cmd) === '["infinity"]',
    runtime: h.Runtime === runtime,
    readonlyRootfs: h.ReadonlyRootfs,
    unprivileged: !h.Privileged,
    capDropAll: Boolean(h.CapDrop?.includes('ALL')),
    noCapAdd: empty(h.CapAdd),
    noNewPrivileges: h.SecurityOpt?.length === 1 && h.SecurityOpt[0] === 'no-new-privileges',
    networkNone: h.NetworkMode === 'none',
    networks: Object.keys(c.NetworkSettings.Networks ?? {}).every((network) => network === 'none'),
    memory: h.Memory > 0 && h.Memory <= MEMORY_BYTES,
    noSwap: h.MemorySwap === h.Memory,
    pids: h.PidsLimit !== null && h.PidsLimit > 0 && h.PidsLimit <= PIDS_LIMIT,
    cpus: h.NanoCpus > 0 && h.NanoCpus <= NANO_CPUS,
    noBinds: empty(h.Binds),
    noDevices: empty(h.Devices) && empty(h.DeviceRequests),
    noPorts: Object.keys(h.PortBindings ?? {}).length === 0,
    pidMode: h.PidMode === '',
    ipcPrivate: h.IpcMode === 'private',
    usernsDefault: (h.UsernsMode ?? '') === '',
    noRestart: h.RestartPolicy.Name === 'no',
    tmpfs: Object.keys(h.Tmpfs ?? {}).length === 1 && h.Tmpfs?.['/tmp'] === TMPFS_OPTIONS,
    mounts:
      c.Mounts.length === 1 &&
      c.Mounts[0]?.Type === 'volume' &&
      c.Mounts[0]?.Name === identity.volume &&
      c.Mounts[0]?.Destination === WORKSPACE &&
      c.Mounts[0]?.RW === true,
  };
  return {
    inspection: c,
    violations: Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name),
  };
}

const volumeSchema = z.object({
  Name: z.string(),
  Labels: z.record(z.string(), z.string()).nullable(),
  Driver: z.string(),
  Options: z.record(z.string(), z.unknown()).nullable(),
  Scope: z.string(),
});

/**
 * The workspace volume must be a plain local volume carrying this actor's
 * labels. A volume with driver OPTIONS can be a bind of any host path
 * (`o=bind,device=/`), which is why any option at all is refused.
 */
export function volumeViolations(raw: unknown, identity: ComputerIdentity): string[] {
  const parsed = z.array(volumeSchema).length(1).safeParse(raw);
  if (!parsed.success) return ['volume_shape'];
  const v = parsed.data[0];
  const checks: Record<string, boolean> = {
    volumeName: v.Name === identity.volume,
    volumeDriver: v.Driver === 'local',
    volumeScope: v.Scope === 'local',
    volumeOptions: Object.keys(v.Options ?? {}).length === 0,
    volumeLabels: Object.entries(identity.labels).every(
      ([key, value]) => v.Labels?.[key] === value,
    ),
  };
  return Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
}
