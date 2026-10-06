/**
 * The browser's isolation contract: one internal network, two containers.
 *
 *     ┌─────────────── alia-browser-<dep> (docker network --internal) ───────────────┐
 *     │                                                                               │
 *     │  browser (gVisor)                egress (gVisor)            control API       │
 *     │  worker + Chromium   ──proxy──▶  validating proxy           (runc; joins to   │
 *     │  /profiles volume                :3128                       call :8790)      │
 *     └──────────────────────────────────────┬────────────────────────────────────────┘
 *                                            │ default bridge (NAT) — the ONLY way out
 *                                            ▼
 *                                      public internet, 80/443
 *
 * ## Why this shape
 *
 * The shell computers stay `--network none`. The browser cannot: it is the
 * point of it. So the boundary moves to the network:
 *
 *  - The BROWSER container sits only on an `--internal` network, which has no
 *    route anywhere — not to the internet, not to the VPC, not to the instance
 *    metadata service. Whatever Chromium does, even compromised, it can reach
 *    the proxy and nothing else outside its own container.
 *  - The EGRESS container is the one member with a second interface on the
 *    default bridge. It runs `egress-proxy.ts`: DNS answers validated, then a
 *    connection to exactly that public address on 80/443. It holds no secret,
 *    mounts nothing, and cannot drive the worker (it has no token).
 *  - The CONTROL API joins the internal network to call the worker. It never
 *    forwards traffic, and every route it serves there still needs a workload
 *    token.
 *
 * Both containers run under gVisor with the same hardening as an actor's
 * computer (read-only root, no capabilities, no-new-privileges, uid 1000,
 * memory/pids caps, no ports, no binds). They run the WORKSPACE image — the one
 * image already pinned by digest and deployed to this host — with a different
 * entrypoint, so the browser added no repository, no image and no instance
 * replacement (oxy-infra runbook 47).
 *
 * ## One browser per host, not one per actor
 *
 * A gVisor sandbox per actor running its own Chromium would cost ~350 MiB each
 * before rendering anything; six of them do not fit beside six computers in
 * 4 GiB. So one browser container holds every actor's context (`pool.ts`).
 * Contexts never share a renderer process, and the network boundary above
 * holds whatever happens inside — but a full Chromium compromise WOULD reach
 * the other contexts open at that moment and the saved profiles on the volume.
 * That is the price of fitting the host, it is stated here rather than hidden,
 * and the escape hatch is configuration: one actor per host.
 *
 * ## Memory: the browser costs two computer slots
 *
 *     4096 MiB  t4g.medium
 *     − ~450    OS, dockerd, containerd, SSM agent
 *     − ~150    control API (capped at 512)
 *     ≈ 3.4 GiB for sandboxes
 *
 *     no browser:    6 computers × 512 MiB                    = 3072 MiB
 *     with browser:  4 computers × 512 + 1024 (browser) + 128 = 3200 MiB
 *
 * So while the browser stack runs, two of the six computer slots are taken
 * ({@link BROWSER_SLOTS}); the browser itself holds at most three contexts
 * (worker ~70 MiB + Chromium ~200 MiB + ~250 MiB per page).
 *
 * The flags and the check below are, as in `isolation.ts`, one contract
 * written twice on purpose; `browser-isolation.test.ts` breaks each property.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MANAGED_LABEL, empty, inspectionSchema } from './isolation.js';

export const BROWSER_PORT = 8790;
export const EGRESS_PORT = 3128;
export const BROWSER_SLOTS = 2;
export const BROWSER_MEMORY_BYTES = 1024 * 1024 * 1024;
export const EGRESS_MEMORY_BYTES = 128 * 1024 * 1024;
const BROWSER_NANO_CPUS = 1_500_000_000;
const EGRESS_NANO_CPUS = 500_000_000;
const BROWSER_PIDS = 512;
const EGRESS_PIDS = 64;
export const BROWSER_TMPFS = 'rw,nosuid,nodev,noexec,size=268435456,mode=1777';
export const EGRESS_TMPFS = 'rw,nosuid,nodev,noexec,size=8388608,mode=1777';
export const PROFILES = '/profiles';
const USER = '1000:1000';
const NODE = '/usr/local/bin/node';
export const WORKER_SCRIPT = '/opt/alia/browser/dist/browser/worker-main.js';
export const EGRESS_SCRIPT = '/opt/alia/browser/dist/browser/egress-main.js';
export const PLAYWRIGHT_BROWSERS = '/opt/alia/ms-playwright';
const MANAGED_VALUE = 'browser-v1';
const ROLE_LABEL = 'onl.alia.computer.role';

export interface BrowserStackIdentity {
  network: string;
  browser: string;
  egress: string;
  profilesVolume: string;
  labels: Readonly<Record<string, string>>;
}

export function browserStackIdentity(deploymentId: string): BrowserStackIdentity {
  const deployment = createHash('sha256').update(deploymentId).digest('hex').slice(0, 12);
  const name = `alia-browser-${deployment}`;
  return {
    network: name,
    browser: name,
    egress: `${name}-egress`,
    profilesVolume: `${name}-profiles`,
    labels: { [MANAGED_LABEL]: MANAGED_VALUE, 'onl.alia.computer.deployment': deployment },
  };
}

/** Finds every container of this deployment's browser stack, whatever state it is in. */
export function browserStackFilter(identity: BrowserStackIdentity): string[] {
  return Object.entries(identity.labels).flatMap(([key, value]) => ['--filter', `label=${key}=${value}`]);
}

const labelArgs = (labels: Readonly<Record<string, string>>) =>
  Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);

export function networkCreateArgs(identity: BrowserStackIdentity): string[] {
  return ['network', 'create', '--driver', 'bridge', '--internal', ...labelArgs(identity.labels), identity.network];
}

export function profilesVolumeArgs(identity: BrowserStackIdentity): string[] {
  return ['volume', 'create', ...labelArgs(identity.labels), identity.profilesVolume];
}

const hardening = (runtime: string) => [
  '--pull', 'never',
  '--runtime', runtime,
  '--user', USER,
  '--read-only',
  '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges',
  '--ipc', 'private',
  '--restart', 'no',
];

export interface BrowserEnv {
  token: string;
  proxyUrl: string;
  maxContexts: number;
  idleMs: number;
}

export function browserEnv(env: BrowserEnv): Record<string, string> {
  return {
    HOME: '/tmp',
    LANG: 'C.UTF-8',
    PLAYWRIGHT_BROWSERS_PATH: PLAYWRIGHT_BROWSERS,
    ALIA_BROWSER_TOKEN: env.token,
    ALIA_BROWSER_PROXY: env.proxyUrl,
    ALIA_BROWSER_PROFILES: PROFILES,
    ALIA_BROWSER_MAX_CONTEXTS: String(env.maxContexts),
    ALIA_BROWSER_IDLE_MS: String(env.idleMs),
  };
}

export function egressEnv(env: { dns: readonly string[]; denyCidrs: readonly string[] }): Record<string, string> {
  return {
    HOME: '/tmp',
    LANG: 'C.UTF-8',
    ALIA_EGRESS_DNS: env.dns.join(','),
    ALIA_EGRESS_DENY_CIDRS: env.denyCidrs.join(','),
  };
}

const envArgs = (env: Record<string, string>) => Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);

export function browserCreateArgs(identity: BrowserStackIdentity, image: string, runtime: string, env: BrowserEnv): string[] {
  return [
    'container', 'create',
    '--name', identity.browser,
    ...labelArgs({ ...identity.labels, [ROLE_LABEL]: 'browser' }),
    ...hardening(runtime),
    '--workdir', '/tmp',
    '--network', identity.network,
    '--memory', '1024m',
    '--memory-swap', '1024m',
    '--cpus', '1.5',
    '--pids-limit', String(BROWSER_PIDS),
    '--tmpfs', `/tmp:${BROWSER_TMPFS}`,
    '--mount', `type=volume,source=${identity.profilesVolume},target=${PROFILES}`,
    ...envArgs(browserEnv(env)),
    '--entrypoint', NODE,
    image,
    WORKER_SCRIPT,
  ];
}

/** Created on the default bridge; the internal network is connected before it starts. */
export function egressCreateArgs(
  identity: BrowserStackIdentity,
  image: string,
  runtime: string,
  env: { dns: readonly string[]; denyCidrs: readonly string[] },
): string[] {
  return [
    'container', 'create',
    '--name', identity.egress,
    ...labelArgs({ ...identity.labels, [ROLE_LABEL]: 'egress' }),
    ...hardening(runtime),
    '--workdir', '/tmp',
    '--network', 'bridge',
    '--memory', '128m',
    '--memory-swap', '128m',
    '--cpus', '0.5',
    '--pids-limit', String(EGRESS_PIDS),
    '--tmpfs', `/tmp:${EGRESS_TMPFS}`,
    ...envArgs(egressEnv(env)),
    '--entrypoint', NODE,
    image,
    EGRESS_SCRIPT,
  ];
}

/** Environment NAMES the image itself may carry; everything else must be ours. */
const IMAGE_ENV = new Set(['PATH', 'NODE_VERSION', 'YARN_VERSION']);

function envMatches(actual: readonly string[], expected: Record<string, string>): boolean {
  const seen = new Map<string, string>();
  for (const entry of actual) {
    const at = entry.indexOf('=');
    seen.set(at === -1 ? entry : entry.slice(0, at), at === -1 ? '' : entry.slice(at + 1));
  }
  for (const [key, value] of Object.entries(expected)) if (seen.get(key) !== value) return false;
  for (const key of seen.keys()) if (!(key in expected) && !IMAGE_ENV.has(key)) return false;
  return true;
}

export type StackRole = 'browser' | 'egress';

export interface StackExpectation {
  role: StackRole;
  identity: BrowserStackIdentity;
  image: string;
  runtime: string;
  env: Record<string, string>;
}

/**
 * Every property, by name. `env` is reported apart from the rest: a container
 * whose only difference is its token or proxy address is OURS from a previous
 * control-API process (stale, recreate it); any other difference means
 * somebody built it differently, and the host refuses to use it.
 */
export function stackViolations(raw: unknown, expected: StackExpectation): { violations: string[]; stale: boolean } {
  const parsed = z.array(inspectionSchema).length(1).safeParse(raw);
  if (!parsed.success) return { violations: ['inspection_shape'], stale: false };
  const c = parsed.data[0];
  const h = c.HostConfig;
  const { identity, role } = expected;
  const browser = role === 'browser';
  const networks = Object.keys(c.NetworkSettings.Networks ?? {}).sort();
  const checks: Record<string, boolean> = {
    name: c.Name === `/${browser ? identity.browser : identity.egress}`,
    image: c.Config.Image === expected.image,
    user: c.Config.User === USER,
    workdir: c.Config.WorkingDir === '/tmp',
    labels: Object.entries({ ...identity.labels, [ROLE_LABEL]: role }).every(([key, value]) => c.Config.Labels?.[key] === value),
    entrypoint: JSON.stringify(c.Config.Entrypoint) === JSON.stringify([NODE]),
    cmd: JSON.stringify(c.Config.Cmd) === JSON.stringify([browser ? WORKER_SCRIPT : EGRESS_SCRIPT]),
    noExposedPorts: Object.keys(c.Config.ExposedPorts ?? {}).length === 0,
    runtime: h.Runtime === expected.runtime,
    readonlyRootfs: h.ReadonlyRootfs,
    unprivileged: !h.Privileged,
    capDropAll: Boolean(h.CapDrop?.includes('ALL')),
    noCapAdd: empty(h.CapAdd),
    noNewPrivileges: h.SecurityOpt?.length === 1 && h.SecurityOpt[0] === 'no-new-privileges',
    networkMode: h.NetworkMode === (browser ? identity.network : 'bridge'),
    networks: browser
      ? JSON.stringify(networks) === JSON.stringify([identity.network])
      : JSON.stringify(networks) === JSON.stringify(['bridge', identity.network].sort()),
    memory: h.Memory > 0 && h.Memory <= (browser ? BROWSER_MEMORY_BYTES : EGRESS_MEMORY_BYTES),
    noSwap: h.MemorySwap === h.Memory,
    pids: h.PidsLimit !== null && h.PidsLimit > 0 && h.PidsLimit <= (browser ? BROWSER_PIDS : EGRESS_PIDS),
    cpus: h.NanoCpus > 0 && h.NanoCpus <= (browser ? BROWSER_NANO_CPUS : EGRESS_NANO_CPUS),
    noBinds: empty(h.Binds),
    noDevices: empty(h.Devices) && empty(h.DeviceRequests),
    noPorts: Object.keys(h.PortBindings ?? {}).length === 0,
    pidMode: h.PidMode === '',
    ipcPrivate: h.IpcMode === 'private',
    usernsDefault: (h.UsernsMode ?? '') === '',
    noRestart: h.RestartPolicy.Name === 'no',
    tmpfs: Object.keys(h.Tmpfs ?? {}).length === 1 && h.Tmpfs?.['/tmp'] === (browser ? BROWSER_TMPFS : EGRESS_TMPFS),
    mounts: browser
      ? c.Mounts.length === 1 &&
        c.Mounts[0]?.Type === 'volume' &&
        c.Mounts[0]?.Name === identity.profilesVolume &&
        c.Mounts[0]?.Destination === PROFILES &&
        c.Mounts[0]?.RW === true
      : c.Mounts.length === 0,
  };
  const violations = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  const envOk = envMatches(c.Config.Env, expected.env);
  return { violations, stale: violations.length === 0 && !envOk };
}

const networkSchema = z.object({
  Name: z.string(),
  Driver: z.string(),
  Internal: z.boolean(),
  EnableIPv6: z.boolean().optional(),
  Attachable: z.boolean().optional(),
  Ingress: z.boolean().optional(),
  ConfigOnly: z.boolean().optional(),
  ConfigFrom: z.object({ Network: z.string() }).optional(),
  Labels: z.record(z.string(), z.string()).nullable(),
  Options: z.record(z.string(), z.string()).nullable(),
  Containers: z.record(z.string(), z.object({ Name: z.string(), IPv4Address: z.string().optional() })).nullable().optional(),
});

export type NetworkInspection = z.infer<typeof networkSchema>;

/**
 * The network must be an INTERNAL bridge with our labels, no driver options
 * and no members but the browser, its egress and the control API itself.
 */
export function networkViolations(
  raw: unknown,
  identity: BrowserStackIdentity,
  allowedMembers: readonly string[],
): { inspection: NetworkInspection | null; violations: string[] } {
  const parsed = z.array(networkSchema).length(1).safeParse(raw);
  if (!parsed.success) return { inspection: null, violations: ['network_shape'] };
  const n = parsed.data[0];
  const members = Object.values(n.Containers ?? {}).map((member) => member.Name);
  const checks: Record<string, boolean> = {
    networkName: n.Name === identity.network,
    networkDriver: n.Driver === 'bridge',
    networkInternal: n.Internal === true,
    networkNoIpv6: n.EnableIPv6 !== true,
    networkNotIngress: n.Ingress !== true,
    networkNoConfigFrom: !n.ConfigOnly && !n.ConfigFrom?.Network,
    networkOptions: Object.keys(n.Options ?? {}).length === 0,
    networkLabels: Object.entries(identity.labels).every(([key, value]) => n.Labels?.[key] === value),
    networkMembers: members.every((name) => allowedMembers.includes(name)),
  };
  return { inspection: n, violations: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name) };
}

/** A container's IPv4 address on the browser network, from `container inspect`. */
export function addressOn(raw: unknown, network: string): string | null {
  const parsed = z
    .array(z.object({ NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ IPAddress: z.string() }).partial()).nullable() }) }))
    .length(1)
    .safeParse(raw);
  if (!parsed.success) return null;
  const address = parsed.data[0].NetworkSettings.Networks?.[network]?.IPAddress ?? '';
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address) ? address : null;
}
