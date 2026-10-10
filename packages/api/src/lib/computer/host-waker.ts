/**
 * Waking the computer host when it is asleep.
 *
 * The host is a Spot instance that STOPS ITSELF after thirty idle minutes
 * (oxy-infra `alia-computer-host.tf`), so most of the day nothing is billed but
 * its disks. The first call after that finds it unreachable, and this is what
 * turns that into a short wait instead of an error: start the instance, wait
 * for the control API's `/health`, carry on.
 *
 * ## One wake, however many callers
 *
 * Ten tool calls arriving at a sleeping host are ten callers of ONE wake: the
 * first creates the promise, the rest await it. Nobody calls StartInstances
 * twice, and nobody polls twice.
 *
 * ## Bounded, and honest about why it failed
 *
 * A wake has a deadline (90 s by default). Past it the caller gets
 * `host_waking` — "it is still starting" — which the tools turn into a message
 * telling the model to try again in a minute; the next call joins the instance
 * where it left off. A start that AWS refuses for lack of Spot capacity is
 * `host_capacity_unavailable`, and an instance that no longer exists is
 * `host_unavailable`: neither will be fixed by waiting.
 *
 * ## Least privilege
 *
 * `oxy-alia-task` may call StartInstances on this one instance (ARN and Role
 * tag) and DescribeInstances, which AWS cannot scope to a resource. It cannot
 * stop, terminate or modify anything; the instance stops itself.
 */
import { DescribeInstancesCommand, EC2Client, StartInstancesCommand } from '@aws-sdk/client-ec2';
import { ComputerHostError } from './computer-errors.js';

export type InstanceState =
  | 'pending'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'shutting-down'
  | 'terminated'
  | 'unknown';

/** What the waker needs from EC2, so a test can hand it a double. */
export interface InstanceControl {
  state(): Promise<InstanceState>;
  start(): Promise<void>;
}

/** AWS error names that mean "no capacity to start it now", not "try the same call again". */
const CAPACITY_ERRORS = new Set([
  'InsufficientInstanceCapacity',
  'InsufficientCapacity',
  'InsufficientCapacityOnHost',
  'InsufficientHostCapacity',
  'SpotMaxPriceTooLow',
  'MaxSpotInstanceCountExceeded',
  'InstanceLimitExceeded',
  'Unsupported',
]);

export class Ec2InstanceControl implements InstanceControl {
  private readonly client: EC2Client;

  constructor(
    private readonly instanceId: string,
    client?: EC2Client,
  ) {
    this.client = client ?? new EC2Client({});
  }

  async state(): Promise<InstanceState> {
    const answer = await this.client.send(
      new DescribeInstancesCommand({ InstanceIds: [this.instanceId] }),
    );
    const name = answer.Reservations?.[0]?.Instances?.[0]?.State?.Name;
    return (name as InstanceState | undefined) ?? 'unknown';
  }

  async start(): Promise<void> {
    await this.client.send(new StartInstancesCommand({ InstanceIds: [this.instanceId] }));
  }
}

export interface HostWakerOptions {
  control: InstanceControl;
  /** Whether the control API answers `/health` right now. */
  healthy: () => Promise<boolean>;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const START_RETRY_MS = 20_000;

export class HostWaker {
  private pending: Promise<void> | null = null;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HostWakerOptions) {
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.pollMs = options.pollMs ?? 3_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The instance's state, for a status call that must not wake anything. */
  state(): Promise<InstanceState> {
    return this.options.control.state();
  }

  /** Start the host if needed and resolve once `/health` answers. Single-flight. */
  wake(): Promise<void> {
    this.pending ??= this.run().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async run(): Promise<void> {
    const deadline = this.now() + this.timeoutMs;
    let lastStartAt = Number.NEGATIVE_INFINITY;
    while (this.now() < deadline) {
      const state = await this.options.control.state();
      if (state === 'terminated' || state === 'shutting-down' || state === 'unknown') {
        throw new ComputerHostError(
          'The computer host does not exist any more',
          503,
          'host_unavailable',
        );
      }
      if (state === 'running' && (await this.options.healthy())) return;
      // `stopping` cannot be started yet: wait for `stopped`. A start that
      // raced another caller's (or AWS's own restart after an interruption)
      // answers IncorrectInstanceState, which is simply the next poll.
      if (state === 'stopped' && this.now() - lastStartAt >= START_RETRY_MS) {
        lastStartAt = this.now();
        try {
          await this.options.control.start();
        } catch (error) {
          const name = (error as { name?: string } | null)?.name ?? '';
          if (CAPACITY_ERRORS.has(name)) {
            throw new ComputerHostError(
              'There is no machine capacity to start the computer right now',
              503,
              'host_capacity_unavailable',
            );
          }
          if (name !== 'IncorrectInstanceState') {
            throw new ComputerHostError(
              'The computer host could not be started',
              503,
              'host_unavailable',
            );
          }
        }
      }
      await this.sleep(this.pollMs);
    }
    throw new ComputerHostError('The computer is still starting', 503, 'host_waking');
  }
}
