/**
 * Everything the host is told by its environment, validated once at boot.
 *
 * A host that would run with a bad image reference, no caller allow-list or a
 * runtime other than gVisor in production refuses to START, rather than starting
 * and refusing every request — a crash loop is visible in systemd and in the
 * logs, a host that answers 503 forever is not.
 */

export interface HostConfig {
  port: number;
  /**
   * The operations port: `/idle` and `/idle/drain`, for the instance's own
   * auto-stop timer. Unauthenticated, so the systemd unit publishes it on
   * 127.0.0.1 only — never on the private address the control API uses.
   */
  opsPort: number;
  /** How long the host must be idle before it may stop its own instance. */
  idleStopMs: number;
  /** The workspace image every container must run, by exact reference (a digest in production). */
  image: string;
  /** The OCI runtime containers are created with. `runsc` (gVisor) in production. */
  runtime: string;
  /**
   * Distinguishes this deployment's containers from anyone else's on the same
   * Docker engine; part of every name and label the host creates or attaches to.
   */
  deploymentId: string;
  /** Canonical IAM role ARNs allowed to call the control API (ADR 0026 subjects). */
  allowedRoleArns: readonly string[];
  /** Postgres for leases and command receipts. Absent only in tests and local dev. */
  databaseUrl?: string;
  /** How many actor containers may run at once on this host. */
  maxRunning: number;
  /** A running container with no control-API activity for this long is stopped. */
  idleMs: number;
  /** Soft cap on one actor's `/workspace`, in bytes. */
  workspaceQuotaBytes: number;
  /** Upper bound for a foreground command's own timeout, in seconds. */
  maxCommandSeconds: number;
  /**
   * The agents' browser (`browser-stack.ts`). On unless `ALIA_COMPUTER_BROWSER=off`;
   * it runs the same image as the computers, so there is nothing else to deploy.
   */
  browser: {
    enabled: boolean;
    /** Contexts open at once — the memory budget in `browser-isolation.ts`. */
    maxContexts: number;
    /** A context with no call for this long is saved and closed. */
    idleMs: number;
    /** This control API's own container, which joins the browser's network. */
    selfContainer: string;
    /** Extra IPv4 CIDRs the egress proxy refuses beyond every private range. */
    denyCidrs: string[];
  };
  production: boolean;
}

/** Docker's own reference grammar, narrowed: no whitespace, no shell metacharacters. */
export const IMAGE_REFERENCE = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,250}$/;

const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_-]+$/;

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

/**
 * Docker sets a container's hostname to its short id, which `docker network
 * connect` accepts; the systemd unit's container name is the fallback.
 */
function selfContainer(env: NodeJS.ProcessEnv): string {
  const value = env.ALIA_COMPUTER_SELF_CONTAINER || env.HOSTNAME || 'alia-computer-host';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value))
    throw new Error('ALIA_COMPUTER_SELF_CONTAINER is invalid');
  return value;
}

function denyCidrs(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const cidr of list) {
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(cidr))
      throw new Error(`ALIA_COMPUTER_BROWSER_DENY_CIDRS: ${cidr} is not an IPv4 CIDR`);
  }
  return list;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  const production = env.NODE_ENV === 'production';

  const image = env.ALIA_COMPUTER_IMAGE ?? '';
  if (!IMAGE_REFERENCE.test(image))
    throw new Error('ALIA_COMPUTER_IMAGE is missing or not an image reference');
  if (production && !image.includes('@sha256:')) {
    throw new Error('ALIA_COMPUTER_IMAGE must be pinned by digest in production');
  }

  const runtime = env.ALIA_COMPUTER_RUNTIME ?? 'runsc';
  if (production && runtime !== 'runsc') {
    throw new Error('ALIA_COMPUTER_RUNTIME must be runsc (gVisor) in production');
  }
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(runtime)) throw new Error('ALIA_COMPUTER_RUNTIME is invalid');

  const allowedRoleArns = (env.ALIA_COMPUTER_ALLOWED_ROLE_ARNS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowedRoleArns.length === 0)
    throw new Error('ALIA_COMPUTER_ALLOWED_ROLE_ARNS names no caller');
  for (const arn of allowedRoleArns) {
    // An assumed-role ARN names one task, and the next task would be refused.
    // The canonical role ARN is what a binding names (oxy-infra runbook 44).
    if (!ROLE_ARN.test(arn))
      throw new Error(`ALIA_COMPUTER_ALLOWED_ROLE_ARNS: ${arn} is not a canonical IAM role ARN`);
  }

  const databaseUrl = env.DATABASE_URL || undefined;
  if (production && !databaseUrl) throw new Error('DATABASE_URL is required in production');

  const deploymentId = env.ALIA_COMPUTER_DEPLOYMENT_ID ?? 'local';
  if (!/^[a-z0-9-]{1,32}$/.test(deploymentId))
    throw new Error('ALIA_COMPUTER_DEPLOYMENT_ID is invalid');

  return {
    port: positiveInteger('PORT', env.PORT, 8080),
    opsPort: positiveInteger('OPS_PORT', env.OPS_PORT, 8081),
    idleStopMs: positiveInteger(
      'ALIA_COMPUTER_HOST_IDLE_STOP_MS',
      env.ALIA_COMPUTER_HOST_IDLE_STOP_MS,
      30 * 60_000,
    ),
    image,
    runtime,
    deploymentId,
    allowedRoleArns,
    databaseUrl,
    maxRunning: positiveInteger('ALIA_COMPUTER_MAX_RUNNING', env.ALIA_COMPUTER_MAX_RUNNING, 12),
    idleMs: positiveInteger('ALIA_COMPUTER_IDLE_MS', env.ALIA_COMPUTER_IDLE_MS, 10 * 60_000),
    workspaceQuotaBytes: positiveInteger(
      'ALIA_COMPUTER_WORKSPACE_QUOTA_BYTES',
      env.ALIA_COMPUTER_WORKSPACE_QUOTA_BYTES,
      1024 * 1024 * 1024,
    ),
    maxCommandSeconds: positiveInteger(
      'ALIA_COMPUTER_MAX_COMMAND_SECONDS',
      env.ALIA_COMPUTER_MAX_COMMAND_SECONDS,
      300,
    ),
    browser: {
      enabled: env.ALIA_COMPUTER_BROWSER !== 'off',
      maxContexts: Math.min(
        positiveInteger(
          'ALIA_COMPUTER_BROWSER_MAX_CONTEXTS',
          env.ALIA_COMPUTER_BROWSER_MAX_CONTEXTS,
          3,
        ),
        6,
      ),
      idleMs: positiveInteger(
        'ALIA_COMPUTER_BROWSER_IDLE_MS',
        env.ALIA_COMPUTER_BROWSER_IDLE_MS,
        10 * 60_000,
      ),
      selfContainer: selfContainer(env),
      denyCidrs: denyCidrs(env.ALIA_COMPUTER_BROWSER_DENY_CIDRS),
    },
    production,
  };
}
