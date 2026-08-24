/**
 * Offer this device's own inference runtime to the account.
 *
 * Mounted once, high in the tree. While it is running and the person has turned
 * local models on, Alia's backend can serve a turn from a model on THIS machine:
 * the server assembles the turn exactly as it does for a hosted model, hands the
 * provider request down this socket, and this hook performs the ordinary
 * `fetch` to `localhost` that only this device can perform.
 *
 * It also means the person's OTHER devices can use it. The model list is
 * announced on connect, so a phone can select a model running on a laptop and
 * the laptop's tab answers. That is why the announcement carries a catalogue at
 * all — a phone cannot reach the laptop's `localhost` to ask.
 *
 * The endpoint address never leaves this hook. What travels is bytes.
 */
import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { io as socketIO, type Socket } from 'socket.io-client';
import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import config from '@/lib/config';
import { getSocketToken } from '@/lib/api/client';
import { useLocalRuntimeStore } from '@/lib/stores/local-runtime-store';

interface LocalModelsResponse {
  data?: Array<{ id?: unknown }>;
}

/**
 * Why a probe failed, in terms a person can act on.
 *
 * The distinction that matters is the first two, and the browser refuses to
 * make it: a connection that never opened and a server that rejected this page
 * are BOTH `TypeError: Failed to fetch`, with the same message and no status.
 * Telling someone to allow an origin when nothing is running is wrong advice,
 * and it is the advice a single error string forces.
 */
export type LocalRuntimeFailure = 'unreachable' | 'refused' | 'http' | 'empty';

export class LocalRuntimeProbeError extends Error {
  constructor(
    readonly reason: LocalRuntimeFailure,
    /** Only set for `http`: the status the server answered with. */
    readonly status?: number,
  ) {
    super(reason);
    this.name = 'LocalRuntimeProbeError';
  }
}

/**
 * Ask a local OpenAI-compatible server what it can run.
 *
 * The retry on failure is the diagnosis, not a retry. A `no-cors` GET is a
 * SIMPLE request — no preflight, no custom headers — so the browser sends it
 * whatever the origin, and resolves it opaquely if any server answered at all.
 * Measured against Ollama: a foreign `Origin` gets `403` on the preflight of the
 * real request but `200` on the simple GET, while a dead port refuses the
 * connection in both. So resolving means "running and refusing us" and rejecting
 * means "nothing there" — the two cases one error string cannot separate.
 *
 * On native there is no CORS to fail, so the first request already succeeded or
 * the address is genuinely unreachable; the second call answers the same either
 * way.
 */
export async function probeLocalRuntime(endpoint: string, signal?: AbortSignal): Promise<string[]> {
  const base = endpoint.replace(/\/$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}/models`, { signal });
  } catch (error: unknown) {
    // An abort is the caller withdrawing, not a diagnosis to report.
    if (signal?.aborted) throw error;
    const answered = await fetch(`${base}/models`, { mode: 'no-cors', signal }).then(
      () => true,
      () => false,
    );
    throw new LocalRuntimeProbeError(answered ? 'refused' : 'unreachable');
  }
  if (!response.ok) throw new LocalRuntimeProbeError('http', response.status);
  const body = (await response.json()) as LocalModelsResponse;
  const models = (body.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (models.length === 0) throw new LocalRuntimeProbeError('empty');
  return models.sort();
}

/**
 * What this device calls itself in another device's picker.
 *
 * Descriptive rather than identifying: the point is to tell two of the person's
 * own machines apart, not to fingerprint anything.
 */
function defaultLabel(): string {
  if (Platform.OS !== 'web') return `This ${Platform.OS} device`;
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const browser = /Firefox/.test(agent) ? 'Firefox' : /Edg\//.test(agent) ? 'Edge' : /Chrome/.test(agent) ? 'Chrome' : /Safari/.test(agent) ? 'Safari' : 'This browser';
  const os = /Macintosh/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** How often the model list is re-probed, so an `ollama pull` shows up on its own. */
const PROBE_INTERVAL_MS = 60_000;

/**
 * How often to retry after the probe found nothing.
 *
 * Detection is on by default, so the common case is a person with no local
 * server at all — retrying that every minute for every open tab is a connection
 * refused in their console forever. Backing off keeps detection automatic for
 * someone who starts Ollama later without making it noise for everyone else.
 */
const PROBE_BACKOFF_MS = 300_000;

/**
 * What this device's runtime currently offers.
 *
 * Its own hook so the settings screen can read the state without mounting a
 * second socket. React Query keys on the endpoint, so the screen and the
 * serving hook below share one probe rather than racing two.
 */
export function useLocalRuntimeProbe() {
  const { isAuthenticated } = useOxy();
  const consent = useLocalRuntimeStore((state) => state.consent);
  const endpoint = useLocalRuntimeStore((state) => state.endpoint);

  return useQuery({
    queryKey: ['local-runtime', 'models', endpoint],
    queryFn: ({ signal }) => probeLocalRuntime(endpoint, signal),
    // `granted` and nothing else: `unasked` must not reach localhost, which is
    // the whole point of asking first.
    enabled: consent === 'granted' && isAuthenticated,
    refetchInterval: (query) => (query.state.error === null ? PROBE_INTERVAL_MS : PROBE_BACKOFF_MS),
    retry: false,
    staleTime: PROBE_INTERVAL_MS,
  });
}

export function useLocalRuntime() {
  const { isAuthenticated } = useOxy();
  const consent = useLocalRuntimeStore((state) => state.consent);
  const runtimeId = useLocalRuntimeStore((state) => state.runtimeId);
  const storedLabel = useLocalRuntimeStore((state) => state.label);
  const setModels = useLocalRuntimeStore((state) => state.setModels);

  const label = storedLabel || defaultLabel();

  const probe = useLocalRuntimeProbe();
  const models = probe.data;

  const socketRef = useRef<Socket | null>(null);
  /** One controller per in-flight run, so an aborted turn stops the local server too. */
  const runsRef = useRef(new Map<string, AbortController>());

  /**
   * Serve one provider request from the local endpoint.
   *
   * Everything here is a copy: the body was built by the server and the bytes
   * are handed back unread. The address is taken from the store at call time
   * rather than closed over, so editing it in settings takes effect on the next
   * turn instead of the next reconnect.
   */
  const serve = useCallback(async (request: { runId?: unknown; path?: unknown; method?: unknown; body?: unknown }) => {
    const socket = socketRef.current;
    const runId = request.runId;
    if (!socket || typeof runId !== 'string') return;

    const controller = new AbortController();
    runsRef.current.set(runId, controller);
    const target = `${useLocalRuntimeStore.getState().endpoint.replace(/\/$/, '')}${
      typeof request.path === 'string' ? request.path.replace(/^\/v1/, '') : '/chat/completions'
    }`;

    try {
      const response = await fetch(target, {
        method: typeof request.method === 'string' ? request.method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof request.body === 'string' ? request.body : undefined,
        signal: controller.signal,
      });
      socket.emit('user-runtime:head', { runId, status: response.status });

      const reader = response.body?.getReader();
      if (!reader) {
        // No streaming body to relay — hand the whole payload over as one frame
        // so a non-streaming request still gets an answer.
        socket.emit('user-runtime:chunk', { runId, data: new Uint8Array(await response.arrayBuffer()) });
      } else {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) socket.emit('user-runtime:chunk', { runId, data: value });
        }
      }
      socket.emit('user-runtime:end', { runId });
    } catch (error: unknown) {
      // An abort is the server or the person cancelling, and the run is already
      // being torn down at the other end; anything else is worth reporting.
      if (!controller.signal.aborted) {
        socket.emit('user-runtime:error', {
          runId,
          message: error instanceof Error ? error.message : 'The local runtime failed.',
        });
      }
    } finally {
      runsRef.current.delete(runId);
    }
  }, []);

  useEffect(() => {
    if (consent !== 'granted' || !isAuthenticated) return;

    const socket = socketIO(config.apiUrl, {
      transports: ['websocket'],
      // Function form so a fresh token is read on every (re)connect, matching
      // every other socket in the app.
      auth: (cb) => cb({ token: getSocketToken() }),
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });
    socketRef.current = socket;

    socket.on('user-runtime:request', serve);
    socket.on('user-runtime:abort', ({ runId }: { runId?: unknown }) => {
      if (typeof runId === 'string') runsRef.current.get(runId)?.abort();
    });

    const runs = runsRef.current;
    return () => {
      for (const controller of runs.values()) controller.abort();
      runs.clear();
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [consent, isAuthenticated, serve]);

  /**
   * Announce the catalogue — on connect, and again whenever it changes.
   *
   * Separate from the connection effect on purpose: an `ollama pull` should
   * reach the account's other devices without tearing down a socket that may be
   * in the middle of serving a turn.
   */
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !models || models.length === 0) return;

    const announce = () => socket.emit('subscribe-user-runtime', { id: runtimeId, label, models });
    announce();
    socket.on('connect', announce);
    return () => {
      socket.off('connect', announce);
    };
  }, [models, runtimeId, label]);

  useEffect(() => {
    if (models) setModels(models);
  }, [models, setModels]);

  return {
    /** Reachable and offering at least one model. */
    ready: consent === 'granted' && (models?.length ?? 0) > 0,
    models: models ?? [],
    error: probe.error instanceof Error ? probe.error : null,
    isProbing: probe.isFetching,
    refresh: probe.refetch,
  };
}
