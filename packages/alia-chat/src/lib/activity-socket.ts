import { io, type Socket } from 'socket.io-client';
import type { AliaAvatarState } from '../components/AliaAvatar';
import { useAliaActivityStore } from './activity-store';

/** A run that goes quiet this long is over: a crashed run never says `idle`. */
export const ACTIVITY_QUIET_MS = 90_000;
/** Between tries after the server refuses a handshake (socket.io does not retry those itself). */
const RETRY_MS = 5_000;

const STATES: ReadonlySet<string> = new Set<AliaAvatarState>([
  'idle',
  'thinking',
  'working',
  'writing',
]);

interface Connection {
  socket: Socket;
  refs: number;
  quiet: Map<string, ReturnType<typeof setTimeout>>;
  retry: ReturnType<typeof setTimeout> | null;
}

/** One connection per API origin, however many buttons ask for it. */
const connections = new Map<string, Connection>();

function open(url: string, getToken: () => string | null): Connection {
  const socket = io(url, {
    transports: ['websocket'],
    // Read on every (re)connect, so a rotated access token is the one that goes out.
    auth: (cb) => cb({ token: getToken() }),
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });
  const connection: Connection = { socket, refs: 0, quiet: new Map(), retry: null };
  const store = useAliaActivityStore.getState;

  const reset = (): void => {
    for (const timer of connection.quiet.values()) clearTimeout(timer);
    connection.quiet.clear();
    store().clearRemote();
  };

  socket.on('connect', () => socket.emit('subscribe-alia-activity'));
  // What happened while disconnected is unknown; a stale "working" is worse than idle.
  socket.on('disconnect', reset);
  socket.on('connect_error', () => {
    // A refused handshake (no token yet, an expired one) ends the socket's own retrying.
    if (socket.active || connection.retry !== null) return;
    connection.retry = setTimeout(() => {
      connection.retry = null;
      socket.connect();
    }, RETRY_MS);
  });
  socket.on('alia:activity', (event: unknown) => {
    if (typeof event !== 'object' || event === null) return;
    const { state, sessionId } = event as { state?: unknown; sessionId?: unknown };
    if (typeof sessionId !== 'string' || typeof state !== 'string' || !STATES.has(state)) return;
    const pending = connection.quiet.get(sessionId);
    if (pending !== undefined) clearTimeout(pending);
    connection.quiet.delete(sessionId);
    store().setRemote(sessionId, state as AliaAvatarState);
    if (state !== 'idle') {
      connection.quiet.set(
        sessionId,
        setTimeout(() => {
          connection.quiet.delete(sessionId);
          store().setRemote(sessionId, 'idle');
        }, ACTIVITY_QUIET_MS),
      );
    }
  });
  return connection;
}

/**
 * Listen for Alia's activity on the person's behalf. Every caller shares the one connection for
 * `url`; the last to release closes it. Returns the release.
 */
export function acquireActivitySocket(url: string, getToken: () => string | null): () => void {
  let held = connections.get(url);
  if (!held) {
    held = open(url, getToken);
    connections.set(url, held);
  }
  const connection = held;
  connection.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--connection.refs > 0) return;
    connections.delete(url);
    if (connection.retry !== null) clearTimeout(connection.retry);
    connection.socket.removeAllListeners();
    connection.socket.disconnect();
    for (const timer of connection.quiet.values()) clearTimeout(timer);
    useAliaActivityStore.getState().clearRemote();
  };
}
