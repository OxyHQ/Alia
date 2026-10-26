/** Ephemeral routing metadata only. The owner retains all audio, credentials and call state. */
import { randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { getRedisClient, withRedisTimeout } from '../redis.js';

export const VOICE_PEER_PATH = '/internal/voice/relay';
export const ROUTE_LEASE_MS = 45_000;
export const ROUTE_RENEW_MS = 10_000;
const MAX_ROUTE_LIFETIME_MS = 31 * 60_000;
const PREFIX = 'alia:voice-route:';

export interface VoiceRoute {
  accountId: string;
  generation: string;
  address: string;
  expiresAt: number;
}

export interface VoiceRouting {
  readonly generation: string;
  /** Resolves only metadata for this account, never an arbitrary client destination. */
  find(sessionId: string, accountId: string): Promise<VoiceRoute | null>;
  register(sessionId: string, accountId: string): Promise<{ release(): Promise<void> }>;
  peerUrl(route: VoiceRoute): string;
  permitsPeer(remoteAddress: string, host: string): boolean;
}

function sessionKey(sessionId: string): string {
  if (!/^vs_[0-9a-f-]{36}$/.test(sessionId)) throw new Error('Invalid voice route id');
  return `${PREFIX}${sessionId}`;
}

/** Exact deployment CIDR, not a blanket RFC1918 exception or caller-controlled URL. */
export function addressPolicy(cidr: string): (address: string) => boolean {
  const parts = cidr.split('/');
  if (parts.length !== 2 || isIP(parts[0]) !== 4 || !/^\d+$/.test(parts[1]))
    throw new Error('Voice peer VPC CIDR required');
  const bits = Number(parts[1]);
  if (bits < 16 || bits > 28) throw new Error('Voice peer VPC CIDR is too broad or invalid');
  const privateRanges = new BlockList();
  privateRanges.addSubnet('10.0.0.0', 8, 'ipv4');
  privateRanges.addSubnet('172.16.0.0', 12, 'ipv4');
  privateRanges.addSubnet('192.168.0.0', 16, 'ipv4');
  if (!privateRanges.check(parts[0], 'ipv4')) throw new Error('Voice peer VPC must be private');
  const allowed = new BlockList();
  allowed.addSubnet(parts[0], bits, 'ipv4');
  return (address) => isIP(address) === 4 && allowed.check(address, 'ipv4');
}

/** Reads the current container, not a task's sidecar or a guessed hostname. */
export async function discoverVoiceAddress(
  uri: string,
  allows: (address: string) => boolean,
  request: typeof fetch = fetch,
): Promise<string> {
  const url = new URL(uri);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '169.254.170.2' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith('/v4/')
  )
    throw new Error('Invalid ECS container metadata endpoint');
  const response = await request(url, {
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error('ECS metadata unavailable');
  if (!response.body) throw new Error('ECS metadata body absent');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 64 * 1024) throw new Error('ECS metadata exceeds limit');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const value = JSON.parse(text) as {
    Networks?: { NetworkMode?: string; IPv4Addresses?: string[] }[];
  };
  const addresses =
    value.Networks?.filter((network) => network.NetworkMode === 'awsvpc')
      .flatMap((network) => network.IPv4Addresses ?? [])
      .filter(allows) ?? [];
  if (addresses.length !== 1) throw new Error('ECS task address is not in the deployment VPC');
  return addresses[0];
}

const RENEW =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end";
const REMOVE =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

type RouteRedis = Pick<NonNullable<ReturnType<typeof getRedisClient>>, 'get' | 'set' | 'eval'>;

export function createVoiceRouting(input: {
  address: string;
  port: number;
  allows: (address: string) => boolean;
  redis: RouteRedis;
  generation?: string;
}): VoiceRouting {
  if (
    !input.allows(input.address) ||
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535
  )
    throw new Error('Invalid voice peer listener');
  const generation = input.generation ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/.test(generation)) throw new Error('Invalid voice owner generation');
  const valid = (route: VoiceRoute) =>
    typeof route.accountId === 'string' &&
    typeof route.generation === 'string' &&
    /^[0-9a-f-]{36}$/.test(route.generation) &&
    input.allows(route.address) &&
    Number.isSafeInteger(route.expiresAt) &&
    route.expiresAt > Date.now();
  return {
    generation,
    permitsPeer(remoteAddress, host) {
      const address = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress;
      return input.allows(address) && host === `${input.address}:${input.port}`;
    },
    async find(sessionId, accountId) {
      const raw = await withRedisTimeout(input.redis.get(sessionKey(sessionId)));
      if (!raw) return null;
      let route: VoiceRoute;
      try {
        route = JSON.parse(raw) as VoiceRoute;
      } catch {
        return null;
      }
      return route && valid(route) && route.accountId === accountId ? route : null;
    },
    peerUrl(route) {
      if (!valid(route)) throw new Error('Expired or invalid voice peer route');
      return `ws://${route.address}:${input.port}${VOICE_PEER_PATH}`;
    },
    async register(sessionId, accountId) {
      const key = sessionKey(sessionId);
      const route: VoiceRoute = {
        accountId,
        generation,
        address: input.address,
        expiresAt: Date.now() + MAX_ROUTE_LIFETIME_MS,
      };
      const value = JSON.stringify(route);
      if (
        (await withRedisTimeout(input.redis.set(key, value, 'PX', ROUTE_LEASE_MS, 'NX'))) !== 'OK'
      )
        throw new Error('Voice route already owned');
      let released = false;
      let renewing = false;
      const timer = setInterval(() => {
        if (released || renewing) return;
        renewing = true;
        const remaining = Math.min(ROUTE_LEASE_MS, route.expiresAt - Date.now());
        if (remaining <= 0) {
          clearInterval(timer);
          renewing = false;
          return;
        }
        void withRedisTimeout(input.redis.eval(RENEW, 1, key, value, remaining))
          .catch(() => undefined) // Never recreate an expired/replaced ownership lease.
          .finally(() => {
            renewing = false;
          });
      }, ROUTE_RENEW_MS);
      timer.unref?.();
      return {
        async release() {
          if (released) return;
          released = true;
          clearInterval(timer);
          await withRedisTimeout(input.redis.eval(REMOVE, 1, key, value));
        },
      };
    },
  };
}

let routing: Promise<VoiceRouting | null> | undefined;
export function productionVoiceRouting(): Promise<VoiceRouting | null> {
  // Local single-process development needs no distributed routing infrastructure.
  if (!process.env.ECS_CONTAINER_METADATA_URI_V4) return Promise.resolve(null);
  if (!routing) {
    routing = (async () => {
      const allows = addressPolicy(process.env.VOICE_PEER_VPC_CIDR ?? '');
      const address = await discoverVoiceAddress(
        process.env.ECS_CONTAINER_METADATA_URI_V4 ?? '',
        allows,
      );
      const redis = getRedisClient();
      if (!redis) throw new Error('Voice peer routing requires Redis');
      return createVoiceRouting({ address, port: Number(process.env.PORT), allows, redis });
    })().catch((error: unknown) => {
      routing = undefined;
      throw error;
    });
  }
  return routing;
}
