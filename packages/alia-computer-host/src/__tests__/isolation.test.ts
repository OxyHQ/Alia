import { describe, expect, it } from 'vitest';
import {
  computerIdentity,
  createArgs,
  isolationViolations,
  volumeViolations,
  workspacePath,
} from '../isolation.js';
import { inspectionFromCreate } from './fake-docker.js';

const IMAGE = 'registry.example/oxy/alia-computer-workspace@sha256:abc';
const identity = computerIdentity('prod', 'agent:a1:user:u1');

function compliant() {
  const inspection = inspectionFromCreate(createArgs(identity, IMAGE, 'runsc'));
  return { ...inspection, State: { Running: true } };
}

describe('the isolation contract', () => {
  it('accepts exactly what createArgs asks Docker to build', () => {
    // The positive control: without it, every refusal below could be a check
    // that refuses everything.
    expect(isolationViolations([compliant()], identity, IMAGE, 'runsc').violations).toEqual([]);
  });

  it('asks for every hardening flag', () => {
    const args = createArgs(identity, IMAGE, 'runsc').join(' ');
    for (const flag of [
      '--runtime runsc',
      '--read-only',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--network none',
      '--ipc private',
      '--memory 512m',
      '--memory-swap 512m',
      '--cpus 1',
      '--pids-limit 128',
      '--restart no',
      '--user 1000:1000',
      '--pull never',
      '--tmpfs /tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777',
    ]) {
      expect(args).toContain(flag);
    }
  });

  const breaks: Array<[string, (c: ReturnType<typeof compliant>) => void]> = [
    [
      'runtime',
      (c) => {
        c.HostConfig.Runtime = 'runc';
      },
    ],
    [
      'image',
      (c) => {
        c.Config.Image = 'attacker/image:latest';
      },
    ],
    [
      'user',
      (c) => {
        c.Config.User = '0:0';
      },
    ],
    [
      'readonlyRootfs',
      (c) => {
        c.HostConfig.ReadonlyRootfs = false;
      },
    ],
    [
      'unprivileged',
      (c) => {
        c.HostConfig.Privileged = true;
      },
    ],
    [
      'capDropAll',
      (c) => {
        c.HostConfig.CapDrop = [];
      },
    ],
    [
      'noCapAdd',
      (c) => {
        c.HostConfig.CapAdd = ['SYS_ADMIN'];
      },
    ],
    [
      'noNewPrivileges',
      (c) => {
        c.HostConfig.SecurityOpt = ['no-new-privileges', 'seccomp=unconfined'];
      },
    ],
    [
      'networkNone',
      (c) => {
        c.HostConfig.NetworkMode = 'bridge';
      },
    ],
    [
      'networks',
      (c) => {
        (c.NetworkSettings as { Networks: object }).Networks = { bridge: {} };
      },
    ],
    [
      'memory',
      (c) => {
        c.HostConfig.Memory = 2 * 1024 ** 3;
        c.HostConfig.MemorySwap = 2 * 1024 ** 3;
      },
    ],
    [
      'noSwap',
      (c) => {
        c.HostConfig.MemorySwap = -1;
      },
    ],
    [
      'pids',
      (c) => {
        c.HostConfig.PidsLimit = null;
      },
    ],
    [
      'cpus',
      (c) => {
        c.HostConfig.NanoCpus = 4e9;
      },
    ],
    [
      'noBinds',
      (c) => {
        c.HostConfig.Binds = ['/:/host'];
      },
    ],
    [
      'noDevices',
      (c) => {
        c.HostConfig.Devices = [{ PathOnHost: '/dev/kvm' }];
      },
    ],
    [
      'noPorts',
      (c) => {
        c.HostConfig.PortBindings = { '22/tcp': [{}] };
      },
    ],
    [
      'pidMode',
      (c) => {
        c.HostConfig.PidMode = 'host';
      },
    ],
    [
      'ipcPrivate',
      (c) => {
        c.HostConfig.IpcMode = 'host';
      },
    ],
    [
      'usernsDefault',
      (c) => {
        c.HostConfig.UsernsMode = 'host';
      },
    ],
    [
      'noRestart',
      (c) => {
        c.HostConfig.RestartPolicy = { Name: 'always' };
      },
    ],
    [
      'tmpfs',
      (c) => {
        c.HostConfig.Tmpfs = { '/tmp': 'rw,exec' };
      },
    ],
    [
      'mounts',
      (c) => {
        (c.Mounts as unknown[]).push({ Type: 'bind', Destination: '/host', RW: true });
      },
    ],
    [
      'labels',
      (c) => {
        (c.Config.Labels as Record<string, string>)['onl.alia.computer.actor'] = 'someone-else';
      },
    ],
    [
      'name',
      (c) => {
        c.Name = '/alia-computer-impostor';
      },
    ],
    [
      'env',
      (c) => {
        (c.Config.Env as string[]).push('AWS_SECRET_ACCESS_KEY=x');
      },
    ],
    [
      'entrypoint',
      (c) => {
        c.Config.Entrypoint = ['/bin/sh'];
      },
    ],
    [
      'cmd',
      (c) => {
        c.Config.Cmd = ['-c', 'nc -l 22'];
      },
    ],
  ];

  it.each(breaks)('refuses a container whose %s differs', (property, edit) => {
    const container = compliant();
    edit(container);
    expect(isolationViolations([container], identity, IMAGE, 'runsc').violations).toEqual([
      property,
    ]);
  });

  it('refuses an inspection that is not exactly one container of the expected shape', () => {
    expect(isolationViolations([], identity, IMAGE, 'runsc').violations).toEqual([
      'inspection_shape',
    ]);
    expect(
      isolationViolations([compliant(), compliant()], identity, IMAGE, 'runsc').violations,
    ).toEqual(['inspection_shape']);
    expect(isolationViolations([{ Id: 'x' }], identity, IMAGE, 'runsc').violations).toEqual([
      'inspection_shape',
    ]);
  });

  it('refuses a volume that could be a bind of a host path', () => {
    const volume = {
      Name: identity.volume,
      Labels: { ...identity.labels },
      Driver: 'local',
      Options: null,
      Scope: 'local',
    };
    expect(volumeViolations([volume], identity)).toEqual([]);
    expect(
      volumeViolations([{ ...volume, Options: { o: 'bind', device: '/' } }], identity),
    ).toEqual(['volumeOptions']);
    expect(volumeViolations([{ ...volume, Driver: 'nfs' }], identity)).toEqual(['volumeDriver']);
    expect(volumeViolations([{ ...volume, Labels: {} }], identity)).toEqual(['volumeLabels']);
  });

  it('gives two actors and two deployments different containers', () => {
    const other = computerIdentity('prod', 'agent:a1:user:u2');
    const staging = computerIdentity('staging', 'agent:a1:user:u1');
    expect(new Set([identity.container, other.container, staging.container]).size).toBe(3);
    // The raw actor id never appears in a name, label or log handle.
    expect(JSON.stringify(identity)).not.toContain('u1');
  });
});

describe('workspace paths', () => {
  it.each([
    ['/workspace', '/workspace'],
    ['/workspace/', '/workspace'],
    ['/workspace/a/./b', '/workspace/a/b'],
    ['/workspace//a', '/workspace/a'],
  ])('normalises %s', (input, expected) => {
    expect(workspacePath(input)).toBe(expected);
  });

  it.each([
    '/workspace/../etc/passwd',
    '/workspace/a/../../etc',
    '/workspacefoo',
    '/etc/passwd',
    'workspace/a',
    '/workspace/a\0b',
    `/workspace/${'a'.repeat(2050)}`,
  ])('refuses %s', (input) => {
    expect(() => workspacePath(input)).toThrow(/inside \/workspace/);
  });
});
