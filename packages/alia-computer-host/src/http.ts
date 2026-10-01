/**
 * The control API. Every route below `/v1` is keyed by actor and requires a
 * token from the workload exchange (`attestation.ts`).
 *
 *   GET  /health                                       liveness, no auth
 *   POST /auth/service-token/workload/challenge        → { data: { nonce } }
 *   POST /auth/service-token/workload                  → { data: { token, expiresIn, appName } }
 *   GET  /v1/actors/:actor/computer                    status
 *   POST /v1/actors/:actor/computer/start
 *   POST /v1/actors/:actor/computer/stop
 *   POST /v1/actors/:actor/commands                    { operationId, command, cwd?, timeoutSeconds?, background? }
 *   GET  /v1/actors/:actor/commands/:operationId       the stored receipt
 *   GET  /v1/actors/:actor/files?path=                 list a directory
 *   GET  /v1/actors/:actor/files/content?path=         read a text file
 *   PUT  /v1/actors/:actor/files/content               { path, text }
 *   POST /v1/actors/:actor/files/directories           { path }
 *
 * Extension points for the next steps (browser worker, live view) are new
 * route groups under the same actor and the same token — not a second auth.
 *
 * Responses are `{ data }` or `{ error: { code, message } }`. Nothing a
 * response or a log line carries includes a command's text or a file's
 * content; logs name the actor by hash.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { AttestationError, type WorkloadAuthority } from './attestation.js';
import type { ComputerService } from './computer-service.js';
import { HostError } from './errors.js';

const commandSchema = z.object({
  operationId: z.string().min(1).max(128),
  command: z.string().min(1).max(16_000),
  cwd: z.string().max(2048).optional(),
  timeoutSeconds: z.number().int().positive().max(3600).optional(),
  background: z.boolean().optional(),
}).strict();
const writeSchema = z.object({ path: z.string().min(1).max(2048), text: z.string().max(256 * 1024) }).strict();
const pathSchema = z.object({ path: z.string().min(1).max(2048) }).strict();

type Handler = (req: Request, res: Response) => Promise<unknown>;

const route = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => {
  handler(req, res).then((data) => res.json({ data }), next);
};

function queryPath(req: Request): string | undefined {
  const value = req.query.path;
  return typeof value === 'string' ? value : undefined;
}

export function createApp(options: {
  service: ComputerService;
  authority: WorkloadAuthority;
  log: { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  ready: () => boolean;
}) {
  const { service, authority, log } = options;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '400kb' }));

  app.get('/health', (_req, res) => {
    res.status(options.ready() ? 200 : 503).json({ ok: options.ready() });
  });

  app.post('/auth/service-token/workload/challenge', (_req, res) => {
    try {
      res.json({ data: { nonce: authority.issueNonce() } });
    } catch (error) {
      res.status(429).json({ error: { code: error instanceof AttestationError ? error.reason : 'challenge_failed', message: 'Try again shortly.' } });
    }
  });

  app.post('/auth/service-token/workload', (req, res) => {
    authority.exchange(req.body).then(
      (granted) => res.json({ data: granted }),
      (error: unknown) => {
        const reason = error instanceof AttestationError ? error.reason : 'attestation_failed';
        log.warn({ reason }, 'workload attestation refused');
        res.status(reason === 'sts_unreachable' ? 503 : 401).json({
          error: { code: reason, message: 'The workload attestation was refused.' },
        });
      },
    );
  });

  const v1 = express.Router();
  v1.use((req, res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!authority.verifyToken(token)) {
      res.status(401).json({ error: { code: 'unauthenticated', message: 'A workload token is required.' } });
      return;
    }
    next();
  });

  v1.get('/actors/:actor/computer', route((req) => service.status(req.params.actor as string)));
  v1.post('/actors/:actor/computer/start', route((req) => service.start(req.params.actor as string)));
  v1.post('/actors/:actor/computer/stop', route((req) => service.stop(req.params.actor as string)));
  v1.post('/actors/:actor/commands', route((req) => service.command(req.params.actor as string, commandSchema.parse(req.body))));
  v1.get('/actors/:actor/commands/:operationId', route(async (req) => {
    const receipt = await service.receipt(req.params.actor as string, req.params.operationId as string);
    if (!receipt) throw new HostError('No command with that operationId', 404, 'not_found');
    return receipt;
  }));
  v1.get('/actors/:actor/files', route((req) => service.list(req.params.actor as string, queryPath(req))));
  v1.get('/actors/:actor/files/content', route((req) => {
    const path = queryPath(req);
    if (!path) throw new HostError('path is required', 400, 'invalid_path');
    return service.read(req.params.actor as string, path);
  }));
  v1.put('/actors/:actor/files/content', route((req) => {
    const body = writeSchema.parse(req.body);
    return service.write(req.params.actor as string, body.path, body.text);
  }));
  v1.post('/actors/:actor/files/directories', route((req) => {
    const body = pathSchema.parse(req.body);
    return service.mkdir(req.params.actor as string, body.path);
  }));
  app.use('/v1', v1);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such route.' } });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HostError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: { code: 'invalid_request', message: error.issues[0]?.message ?? 'Invalid request' } });
      return;
    }
    // express.json() reports a body it could not parse or that is too large.
    const status = (error as { status?: unknown })?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: { code: 'invalid_request', message: 'The request body was refused.' } });
      return;
    }
    log.error({ err: error instanceof Error ? error.name : 'unknown' }, 'unhandled control API error');
    res.status(500).json({ error: { code: 'internal', message: 'The computer host failed.' } });
  });

  return app;
}

/**
 * The operations app, on its own port bound to the instance's loopback.
 *
 *   GET  /idle         { idle, runningComputers, inFlight, idleForMs, draining }
 *   POST /idle/drain   { stop: boolean, state } — `stop: true` means the host now
 *                      refuses new work and the instance may stop itself
 *
 * Used by the instance's systemd timer (oxy-infra
 * `files/alia-computer-host-userdata.sh`), never by the Alia API.
 */
export function createOpsApp(options: { service: ComputerService; idleStopMs: number }) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/idle', (_req, res, next) => {
    options.service.idleState().then((state) => res.json({ data: state }), next);
  });
  app.post('/idle/drain', (_req, res, next) => {
    options.service.drain(options.idleStopMs).then((result) => res.json({ data: result }), next);
  });
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // When Docker cannot be asked, the answer is "not idle": never stop on doubt.
    res.status(503).json({ data: { stop: false } });
  });
  return app;
}
