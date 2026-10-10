/**
 * Waking a sleeping computer host: one wake for many callers, a bounded wait,
 * and errors that say why — with EC2 and the clock replaced by doubles.
 */
import { describe, expect, it, vi } from 'vitest';
import { HttpComputerClient } from '../computer-client.js';
import { HostWaker, type InstanceControl, type InstanceState } from '../host-waker.js';

/** An instance that walks through the states EC2 would, one poll at a time. */
function instance(states: InstanceState[], startError?: { name: string }) {
  let index = 0;
  const control: InstanceControl & { starts: number } = {
    starts: 0,
    state: vi.fn(async () => states[Math.min(index++, states.length - 1)] as InstanceState),
    start: vi.fn(async () => {
      control.starts += 1;
      if (startError) throw Object.assign(new Error(startError.name), startError);
    }),
  };
  return control;
}

function waker(control: InstanceControl, healthy: () => Promise<boolean>, timeoutMs = 90_000) {
  let clock = 0;
  return new HostWaker({
    control,
    healthy,
    timeoutMs,
    pollMs: 3_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
}

describe('HostWaker', () => {
  it('starts a stopped instance once and resolves when /health answers', async () => {
    const control = instance(['stopped', 'pending', 'pending', 'running', 'running']);
    let polls = 0;
    const w = waker(control, async () => ++polls >= 2);
    await w.wake();
    expect(control.starts).toBe(1);
  });

  it('is single-flight: concurrent callers share one wake and one StartInstances', async () => {
    const control = instance(['stopped', 'pending', 'running']);
    const w = waker(control, async () => true);
    await Promise.all([w.wake(), w.wake(), w.wake(), w.wake()]);
    expect(control.starts).toBe(1);
    // And a later wake is a new one, not a cached result.
    const again = instance(['running']);
    const w2 = waker(again, async () => true);
    await w2.wake();
    expect(again.starts).toBe(0);
  });

  it('waits for a stopping instance to finish stopping before starting it', async () => {
    const control = instance(['stopping', 'stopping', 'stopped', 'pending', 'running']);
    await waker(control, async () => true).wake();
    expect(control.starts).toBe(1);
    expect(vi.mocked(control.start).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(control.state).mock.invocationCallOrder[2] as number,
    );
  });

  it('gives up at the deadline with host_waking, so the tool can say "it is starting"', async () => {
    const control = instance(['stopped', 'pending']);
    await expect(waker(control, async () => false, 30_000).wake()).rejects.toMatchObject({
      code: 'host_waking',
    });
  });

  it('reports Spot capacity as host_capacity_unavailable, without retrying for the whole deadline', async () => {
    const control = instance(['stopped'], { name: 'InsufficientInstanceCapacity' });
    await expect(waker(control, async () => false).wake()).rejects.toMatchObject({
      code: 'host_capacity_unavailable',
    });
    expect(control.starts).toBe(1);
  });

  it('treats IncorrectInstanceState as a race and keeps polling', async () => {
    let first = true;
    const control = instance(['stopped', 'pending', 'running']);
    control.start = vi.fn(async () => {
      if (first) {
        first = false;
        throw Object.assign(new Error('x'), { name: 'IncorrectInstanceState' });
      }
    });
    await expect(waker(control, async () => true).wake()).resolves.toBeUndefined();
  });

  it('refuses a terminated instance as host_unavailable', async () => {
    await expect(waker(instance(['terminated']), async () => true).wake()).rejects.toMatchObject({
      code: 'host_unavailable',
    });
  });
});

describe('the client and a sleeping host', () => {
  const mintToken = async () => ({ token: 't', expiresIn: 900 });

  it('wakes the host before the first call when /health does not answer, then proceeds', async () => {
    let awake = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (!awake) throw new TypeError('fetch failed');
      if (String(url).endsWith('/health')) return new Response('{"ok":true}');
      return new Response(JSON.stringify({ data: { state: 'running' } }));
    });
    const wake = vi.fn(async () => {
      awake = true;
    });
    const client = new HttpComputerClient({
      baseUrl: 'http://host:8080',
      fetch: fetchImpl as unknown as typeof fetch,
      mintToken,
      waker: { wake, state: async () => 'stopped' } as unknown as HostWaker,
    });
    await expect(client.start('agent:a:user:u')).resolves.toMatchObject({ state: 'running' });
    expect(wake).toHaveBeenCalledOnce();
  });

  it('wakes and retries once when the host answers host_stopping mid-drain', async () => {
    let draining = true;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/health')) return new Response('{"ok":true}');
      if (draining) {
        return new Response(
          JSON.stringify({ error: { code: 'host_stopping', message: 'stopping' } }),
          { status: 503 },
        );
      }
      return new Response(JSON.stringify({ data: { state: 'running' } }));
    });
    const wake = vi.fn(async () => {
      draining = false;
    });
    const client = new HttpComputerClient({
      baseUrl: 'http://host',
      fetch: fetchImpl as unknown as typeof fetch,
      mintToken,
      waker: { wake } as unknown as HostWaker,
    });
    await expect(client.start('a')).resolves.toMatchObject({ state: 'running' });
    expect(wake).toHaveBeenCalledOnce();
  });

  it('answers status "asleep" without waking a stopped host', async () => {
    const wake = vi.fn();
    const client = new HttpComputerClient({
      baseUrl: 'http://host',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
      mintToken,
      waker: { wake, state: async () => 'stopped' } as unknown as HostWaker,
    });
    await expect(client.status('a')).resolves.toMatchObject({ state: 'asleep' });
    expect(wake).not.toHaveBeenCalled();
  });

  it('surfaces a wake failure as the host error code', async () => {
    const client = new HttpComputerClient({
      baseUrl: 'http://host',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
      mintToken,
      waker: {
        wake: async () => {
          const { ComputerHostError } = await import('../computer-errors.js');
          throw new ComputerHostError('no capacity', 503, 'host_capacity_unavailable');
        },
      } as unknown as HostWaker,
    });
    await expect(client.run('a', { operationId: 'x', command: 'ls' })).rejects.toMatchObject({
      code: 'host_capacity_unavailable',
    });
  });
});
