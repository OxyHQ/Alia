/**
 * The browser stack's isolation contract, broken one property at a time, as
 * `isolation.test.ts` does for the computers.
 */
import { describe, expect, it } from 'vitest';
import {
  browserCreateArgs,
  browserEnv,
  browserStackIdentity,
  egressCreateArgs,
  egressEnv,
  networkViolations,
  stackViolations,
  type StackExpectation,
} from '../browser-isolation.js';
import { inspectionFromCreate } from './fake-docker.js';

const IMAGE = 'registry.example/oxy/alia-computer-workspace@sha256:abc';
const identity = browserStackIdentity('prod');
const env = { token: 't'.repeat(64), proxyUrl: 'http://172.30.0.3:3128', maxContexts: 3, idleMs: 600_000 };
const dns = { dns: ['10.0.0.2'], denyCidrs: [] };

function browser() {
  const inspection = inspectionFromCreate(browserCreateArgs(identity, IMAGE, 'runsc', env));
  return { ...inspection, State: { Running: true } };
}

function egress() {
  const inspection = inspectionFromCreate(egressCreateArgs(identity, IMAGE, 'runsc', dns));
  (inspection.NetworkSettings as { Networks: Record<string, unknown> }).Networks[identity.network] = { IPAddress: '172.30.0.3' };
  return { ...inspection, State: { Running: true } };
}

const browserExpectation: StackExpectation = { role: 'browser', identity, image: IMAGE, runtime: 'runsc', env: browserEnv(env) };
const egressExpectation: StackExpectation = { role: 'egress', identity, image: IMAGE, runtime: 'runsc', env: egressEnv(dns) };

describe('the browser container', () => {
  it('accepts exactly what browserCreateArgs asks for', () => {
    expect(stackViolations([browser()], browserExpectation)).toEqual({ violations: [], stale: false });
  });

  it('asks for every hardening flag, and only the internal network', () => {
    const args = browserCreateArgs(identity, IMAGE, 'runsc', env).join(' ');
    for (const flag of [
      '--runtime runsc', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--ipc private',
      '--memory 1024m', '--memory-swap 1024m', '--pids-limit 512', '--restart no', '--user 1000:1000', '--pull never',
      `--network ${identity.network}`,
    ]) {
      expect(args).toContain(flag);
    }
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('-p ');
    expect(args).not.toContain('docker.sock');
  });

  const breaks: Array<[string, (c: ReturnType<typeof browser>) => void]> = [
    ['runtime', (c) => { c.HostConfig.Runtime = 'runc'; }],
    ['image', (c) => { c.Config.Image = 'attacker/chromium:latest'; }],
    ['readonlyRootfs', (c) => { c.HostConfig.ReadonlyRootfs = false; }],
    ['unprivileged', (c) => { c.HostConfig.Privileged = true; }],
    ['noCapAdd', (c) => { c.HostConfig.CapAdd = ['NET_ADMIN']; }],
    ['networkMode', (c) => { c.HostConfig.NetworkMode = 'bridge'; }],
    ['networks', (c) => { (c.NetworkSettings as { Networks: Record<string, unknown> }).Networks.bridge = {}; }],
    ['networks', (c) => { (c.NetworkSettings as { Networks: Record<string, unknown> }).Networks.host = {}; }],
    ['memory', (c) => { c.HostConfig.Memory = 4 * 1024 * 1024 * 1024; }],
    ['noSwap', (c) => { c.HostConfig.MemorySwap = -1; }],
    ['noBinds', (c) => { c.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock']; }],
    ['noPorts', (c) => { c.HostConfig.PortBindings = { '8790/tcp': [{ HostPort: '8790' }] }; }],
    ['pidMode', (c) => { c.HostConfig.PidMode = 'host'; }],
    ['mounts', (c) => { (c.Mounts as unknown[]).push({ Type: 'volume', Name: 'alia-computer-x-workspace', Destination: '/workspace', RW: true }); }],
    ['entrypoint', (c) => { c.Config.Entrypoint = ['/bin/bash']; }],
    ['cmd', (c) => { c.Config.Cmd = ['-e', 'require("child_process")']; }],
    ['user', (c) => { c.Config.User = 'root'; }],
  ];

  it.each(breaks)('refuses a container whose %s differs', (name, edit) => {
    const container = browser();
    edit(container);
    expect(stackViolations([container], browserExpectation).violations).toContain(name);
  });

  it('calls a container that differs only in its token or proxy STALE, not foreign', () => {
    const result = stackViolations([browser()], { ...browserExpectation, env: browserEnv({ ...env, token: 'u'.repeat(64) }) });
    expect(result).toEqual({ violations: [], stale: true });
  });

  it('calls an extra environment variable stale too, so it is rebuilt rather than used', () => {
    const container = browser();
    (container.Config.Env as string[]).push('NODE_OPTIONS=--require /tmp/x.js');
    expect(stackViolations([container], browserExpectation).stale).toBe(true);
  });
});

describe('the egress container', () => {
  it('accepts exactly what egressCreateArgs asks for, on the default bridge plus the internal network', () => {
    expect(stackViolations([egress()], egressExpectation)).toEqual({ violations: [], stale: false });
  });

  it('holds no mount and no token', () => {
    const args = egressCreateArgs(identity, IMAGE, 'runsc', dns).join(' ');
    expect(args).not.toContain('--mount');
    expect(args).not.toContain('ALIA_BROWSER_TOKEN');
    expect(args).toContain('--memory 128m');
  });

  it('refuses an egress container with a mount or a third network', () => {
    const mounted = egress();
    (mounted.Mounts as unknown[]).push({ Type: 'volume', Name: identity.profilesVolume, Destination: '/profiles', RW: true });
    expect(stackViolations([mounted], egressExpectation).violations).toContain('mounts');
    const extra = egress();
    (extra.NetworkSettings as { Networks: Record<string, unknown> }).Networks['oxy-vpc-bridge'] = {};
    expect(stackViolations([extra], egressExpectation).violations).toContain('networks');
  });
});

describe('the internal network', () => {
  const network = (over: Record<string, unknown> = {}) => [{
    Name: identity.network,
    Driver: 'bridge',
    Internal: true,
    EnableIPv6: false,
    Labels: { ...identity.labels },
    Options: {},
    Containers: { a: { Name: identity.browser }, b: { Name: identity.egress }, c: { Name: 'alia-computer-host' } },
    ...over,
  }];
  const members = [identity.browser, identity.egress, 'alia-computer-host'];

  it('accepts an internal bridge with only the stack and the control API on it', () => {
    expect(networkViolations(network(), identity, members).violations).toEqual([]);
  });

  it.each([
    ['networkInternal', { Internal: false }],
    ['networkDriver', { Driver: 'host' }],
    ['networkOptions', { Options: { 'com.docker.network.bridge.enable_ip_masquerade': 'true' } }],
    ['networkMembers', { Containers: { x: { Name: 'alia-computer-abc-123' } } }],
    ['networkLabels', { Labels: {} }],
    ['networkNoIpv6', { EnableIPv6: true }],
  ])('refuses a network whose %s differs', (name, over) => {
    expect(networkViolations(network(over), identity, members).violations).toContain(name);
  });
});
