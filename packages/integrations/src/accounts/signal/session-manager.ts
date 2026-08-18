import { spawn, ChildProcess } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db';
import {
  createSignalSession,
  findRestorableSignalSessions,
  findSignalDaemonState,
  findSignalSession,
  findSignalSessionOwner,
  findSignalSessionQr,
  insertSignalMessages,
  listSignalSessions,
  listSignalSessionsForUser,
  markSignalConnected,
  markSignalDaemonStarted,
  markSignalDisconnected,
  markSignalFailed,
  markSignalLinked,
  markSignalUnlinked,
  saveSignalLinkQr,
  upsertSignalChat,
} from './repository';
import { handleIncomingMessage } from '../../shared/chat-handler';
import { APIClient } from '../../shared/api-client';
import { DedupSet, errorName } from '../../shared/utils';
import { createLogger } from '../../shared/logger';

/** Narrow shape of a signal-cli JSON-RPC `receive` envelope (only fields we read). */
interface SignalEnvelopeBody {
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  dataMessage?: {
    message?: string;
    timestamp?: number;
    groupInfo?: { groupId: string };
  };
}
interface SignalReceiveEnvelope {
  envelope?: SignalEnvelopeBody;
}

const apiClient = new APIClient('signal', process.env.INTEGRATIONS_SECRET || '');
const dedup = new DedupSet();
const logger = createLogger('Signal');

/**
 * Pending QR resolver used while a session is being linked and the user
 * has not scanned the QR code yet. The HTTP endpoint polls or awaits this.
 */
interface PendingQR {
  resolve: (qr: string) => void;
  reject: (err: Error) => void;
  promise: Promise<string>;
}

class SessionManager {
  private daemons: Map<string, ChildProcess> = new Map();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private pendingQRs: Map<string, PendingQR> = new Map();
  private sseCleanups: Map<string, () => void> = new Map();

  private nextPort = 9100;
  private usedPorts: Set<number> = new Set();

  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly BASE_RECONNECT_MS = 5000;
  private static readonly MAX_RECONNECT_MS = 60000;
  private static readonly JITTER_MAX_MS = 1000;

  /**
   * On startup, load all 'connected' or 'disconnected' sessions and attempt to
   * restart their daemons.
   */
  async initialize(): Promise<void> {
    const activeSessions = await findRestorableSignalSessions(getDb());
    logger.info(`Found ${activeSessions.length} active session(s) to restore`);

    for (const session of activeSessions) {
      try {
        await this.startDaemon(session.sessionId);
      } catch (err) {
        logger.error(`Failed to restore session ${session.sessionId}:`, err);
      }
    }
  }

  /**
   * Link a new Signal device for a user.
   * Spawns signal-cli link and returns a promise that resolves with the QR URI.
   */
  async linkDevice(oxyUserId: string): Promise<{ sessionId: string; qrPromise: Promise<string> }> {
    const sessionId = randomUUID();
    const dataDir = path.resolve(`./signal-data/${sessionId}`);
    await fs.mkdir(dataDir, { recursive: true });

    await createSignalSession(getDb(), { sessionId, oxyUserId, dataDir });

    let qrResolve!: (qr: string) => void;
    let qrReject!: (err: Error) => void;
    const qrPromise = new Promise<string>((resolve, reject) => {
      qrResolve = resolve;
      qrReject = reject;
    });
    this.pendingQRs.set(sessionId, { resolve: qrResolve, reject: qrReject, promise: qrPromise });

    // Timeout after 90 seconds (Signal linking can be slow)
    setTimeout(() => {
      const pending = this.pendingQRs.get(sessionId);
      if (pending) {
        pending.reject(new Error('Link timed out'));
        this.pendingQRs.delete(sessionId);
      }
    }, 90000);

    const cliPath = process.env.SIGNAL_CLI_PATH || 'signal-cli';
    const linkProcess = spawn(cliPath, ['--config', dataDir, 'link', '-n', 'Alia'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let outputBuffer = '';

    linkProcess.stdout.on('data', (chunk: Buffer) => {
      outputBuffer += chunk.toString();
      // signal-cli outputs the sgnl:// URI to stdout
      const match = outputBuffer.match(/(sgnl:\/\/linkdevice\?[^\s]+)/);
      if (match) {
        const qrUrl = match[1];
        saveSignalLinkQr(getDb(), sessionId, qrUrl).catch((err) =>
          logger.error(`Failed to store link QR for ${sessionId}:`, err),
        );

        const pending = this.pendingQRs.get(sessionId);
        if (pending) {
          pending.resolve(qrUrl);
          this.pendingQRs.delete(sessionId);
        }
      }
    });

    linkProcess.stderr.on('data', (chunk: Buffer) => {
      logger.error(`link stderr for ${sessionId}:`, chunk.toString());
    });

    linkProcess.on('close', async (code) => {
      if (code === 0) {
        // Linking succeeded -- extract phone number from the data directory
        try {
          const accountsDir = path.join(dataDir, 'data');
          const files = await fs.readdir(accountsDir).catch(() => []);
          // signal-cli creates a directory named with the phone number
          const phoneDir = files.find((f) => f.startsWith('+'));
          const phoneNumber = phoneDir || '';

          await markSignalLinked(getDb(), sessionId, phoneNumber);

          // Start the daemon for receiving messages
          await this.startDaemon(sessionId);
        } catch (err) {
          logger.error(`Post-link error for ${sessionId}:`, err);
          await markSignalFailed(getDb(), sessionId);
        }
      } else {
        logger.error(`Link process exited with code ${code} for ${sessionId}`);
        await markSignalFailed(getDb(), sessionId);

        const pending = this.pendingQRs.get(sessionId);
        if (pending) {
          pending.reject(new Error(`Link process exited with code ${code}`));
          this.pendingQRs.delete(sessionId);
        }
      }
    });

    return { sessionId, qrPromise };
  }

  /**
   * Start the signal-cli daemon for a linked session.
   * Each session gets its own daemon process on a unique HTTP port.
   */
  async startDaemon(sessionId: string): Promise<void> {
    const session = await findSignalDaemonState(getDb(), sessionId);
    if (!session) throw new Error(`No session found: ${sessionId}`);

    // Kill existing daemon if running
    const existingDaemon = this.daemons.get(sessionId);
    if (existingDaemon) {
      try {
        existingDaemon.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.daemons.delete(sessionId);
    }

    // Clean up existing SSE listener
    const existingCleanup = this.sseCleanups.get(sessionId);
    if (existingCleanup) {
      existingCleanup();
      this.sseCleanups.delete(sessionId);
    }

    // Allocate a port
    const port = this.allocatePort(session.daemonPort);

    const cliPath = process.env.SIGNAL_CLI_PATH || 'signal-cli';
    const daemon = spawn(
      cliPath,
      [
        '--config',
        session.dataDir,
        '-a',
        session.phoneNumber || '',
        'daemon',
        '--http',
        '--http-host',
        '127.0.0.1',
        '--http-port',
        String(port),
        '--json',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    this.daemons.set(sessionId, daemon);

    await markSignalDaemonStarted(getDb(), sessionId, { port, pid: daemon.pid });

    // Listen for daemon ready (it outputs a line when ready)
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000); // Assume ready after 5s
      daemon.stderr.on('data', (chunk: Buffer) => {
        const line = chunk.toString();
        if (line.includes('Started')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    // Set up polling for incoming messages
    this.listenForMessages(sessionId, port);

    // Handle daemon crash with reconnect backoff
    daemon.on('close', async (code) => {
      logger.info(`Daemon for ${sessionId} exited with code ${code}`);
      this.daemons.delete(sessionId);

      // Clean up SSE listener
      const cleanup = this.sseCleanups.get(sessionId);
      if (cleanup) {
        cleanup();
        this.sseCleanups.delete(sessionId);
      }

      // Release port
      this.usedPorts.delete(port);

      // Check if session still exists and is not intentionally unlinked
      const currentSession = await findSignalDaemonState(getDb(), sessionId);
      if (!currentSession || currentSession.status === 'unlinked') {
        return;
      }

      // Reconnect with exponential backoff
      const attempts = (this.reconnectAttempts.get(sessionId) || 0) + 1;
      this.reconnectAttempts.set(sessionId, attempts);

      if (attempts > SessionManager.MAX_RECONNECT_ATTEMPTS) {
        await markSignalFailed(getDb(), sessionId);
        this.reconnectAttempts.delete(sessionId);
        logger.error(
          `Session ${sessionId} failed after ${SessionManager.MAX_RECONNECT_ATTEMPTS} reconnect attempts`
        );
      } else {
        const delay =
          Math.min(
            SessionManager.BASE_RECONNECT_MS * Math.pow(2, attempts - 1),
            SessionManager.MAX_RECONNECT_MS
          ) + Math.floor(Math.random() * SessionManager.JITTER_MAX_MS);

        await markSignalDisconnected(getDb(), sessionId);
        logger.info(
          `Session ${sessionId} disconnected (code ${code}), reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts}/${SessionManager.MAX_RECONNECT_ATTEMPTS})...`
        );

        // Clear any existing reconnect timer
        const existing = this.reconnectTimers.get(sessionId);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
          this.reconnectTimers.delete(sessionId);
          this.startDaemon(sessionId).catch((err) =>
            logger.error(`Reconnect failed for ${sessionId}:`, err)
          );
        }, delay);
        this.reconnectTimers.set(sessionId, timer);
      }
    });

    // Reset reconnect counter on successful daemon start
    this.reconnectAttempts.delete(sessionId);

    await markSignalConnected(getDb(), sessionId);

    logger.info(`Daemon started for session ${sessionId} on port ${port}`);
  }

  /**
   * Poll the signal-cli daemon's HTTP endpoint for incoming messages.
   * Uses a polling interval with an AbortController for cleanup.
   */
  listenForMessages(sessionId: string, port: number): void {
    const controller = new AbortController();
    this.sseCleanups.set(sessionId, () => controller.abort());

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/receive`, {
          signal: controller.signal,
        });
        if (!res.ok) return;

        const messages = (await res.json()) as SignalReceiveEnvelope[];
        for (const envelope of messages) {
          const msg = envelope.envelope;
          const text = msg?.dataMessage?.message;
          if (!msg || !text) continue;

          const dataMessage = msg.dataMessage;
          const sender = msg.sourceNumber || msg.sourceUuid || '';
          const timestamp = dataMessage?.timestamp || Date.now();
          const groupInfo = dataMessage?.groupInfo;
          const isGroup = !!groupInfo;
          const contactId = groupInfo ? groupInfo.groupId : sender;

          // Deduplication
          const dedupKey = `${sessionId}:${sender}:${text}:${Date.now().toString().slice(0, -3)}`;
          if (dedup.check(dedupKey)) continue;

          // Persist message
          try {
            await insertSignalMessages(getDb(), [
              {
                sessionId,
                contactId,
                messageTimestamp: String(timestamp),
                fromMe: false,
                timestamp: Math.floor(timestamp / 1000),
                text,
                senderName: msg.sourceName || '',
              },
            ]);
          } catch (err: unknown) {
            logger.error(`Error persisting message:`, err);
          }

          // Upsert chat
          try {
            await upsertSignalChat(getDb(), {
              sessionId,
              contactId,
              name: msg.sourceName || contactId,
              lastMessageTimestamp: Math.floor(timestamp / 1000),
              chatType: isGroup ? 'group' : 'direct',
            });
          } catch (err: unknown) {
            logger.error(`Error upserting chat:`, err);
          }

          // Forward to shared AI handler
          try {
            const oxyUserId = await findSignalSessionOwner(getDb(), sessionId);
            if (!oxyUserId) {
              logger.error(`No session found for ${sessionId}`);
              continue;
            }

            await handleIncomingMessage({
              platform: 'signal',
              sessionId,
              oxyUserId,
              chatId: contactId,
              messageText: text,
              senderName: msg.sourceName || '',
              sendResponse: async (responseText) => {
                await fetch(`http://127.0.0.1:${port}/api/v1/send`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    recipients: [sender],
                    message: responseText,
                  }),
                });
              },
              charLimit: 4096,
              platformContext: 'Accessible via Signal. Keep responses under 3000 characters when possible.',
            }, apiClient);
          } catch (err) {
            logger.error(`Error handling message:`, err);
          }
        }
      } catch (err: unknown) {
        if (errorName(err) !== 'AbortError') {
          logger.error(`Poll error for ${sessionId}:`, err);
        }
      }
    }, 2000); // Poll every 2 seconds

    controller.signal.addEventListener('abort', () => clearInterval(pollInterval));
  }

  /**
   * Allocate a unique port for a session's daemon, reusing the one already
   * recorded for it when nothing else has taken it.
   *
   * Takes the stored port rather than re-reading the row: the caller has just
   * loaded it, and a second read could see a different value than the one the
   * daemon is about to be started against.
   */
  private allocatePort(storedPort: number | null): number {
    if (storedPort && !this.usedPorts.has(storedPort)) {
      this.usedPorts.add(storedPort);
      return storedPort;
    }

    while (this.usedPorts.has(this.nextPort)) {
      this.nextPort++;
    }
    const port = this.nextPort++;
    this.usedPorts.add(port);
    return port;
  }

  /**
   * Unlink a device: kill daemon, delete data directory, update DB.
   */
  async unlinkDevice(sessionId: string): Promise<void> {
    // Kill daemon
    const daemon = this.daemons.get(sessionId);
    if (daemon) {
      try {
        daemon.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.daemons.delete(sessionId);
    }

    // Clean up SSE listener
    const cleanup = this.sseCleanups.get(sessionId);
    if (cleanup) {
      cleanup();
      this.sseCleanups.delete(sessionId);
    }

    // Clear reconnect timer
    const timer = this.reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(sessionId);
    }
    this.reconnectAttempts.delete(sessionId);

    // Clear pending QR
    const pending = this.pendingQRs.get(sessionId);
    if (pending) {
      pending.reject(new Error('Session unlinked'));
      this.pendingQRs.delete(sessionId);
    }

    // Get session to find data directory and port
    const session = await findSignalDaemonState(getDb(), sessionId);
    if (session) {
      // Release port
      if (session.daemonPort) {
        this.usedPorts.delete(session.daemonPort);
      }

      // Delete data directory
      try {
        await fs.rm(session.dataDir, { recursive: true, force: true });
      } catch (err) {
        logger.error(`Error deleting data dir for ${sessionId}:`, err);
      }
    }

    await markSignalUnlinked(getDb(), sessionId);

    logger.info(`Session ${sessionId} unlinked`);
  }

  /**
   * Session status by sessionId, without the signal-cli data directory.
   */
  async getStatus(sessionId: string) {
    return findSignalSession(getDb(), sessionId);
  }

  /**
   * The linking QR for a session that is awaiting a scan.
   */
  async getQr(sessionId: string) {
    return findSignalSessionQr(getDb(), sessionId);
  }

  /**
   * Get all sessions for a user.
   */
  async getUserSessions(oxyUserId: string) {
    return listSignalSessionsForUser(getDb(), oxyUserId);
  }

  /**
   * List all sessions.
   */
  async listSessions() {
    return listSignalSessions(getDb());
  }

  /**
   * Gracefully shut down all active daemons.
   */
  async shutdown(): Promise<void> {
    logger.info(`Shutting down ${this.daemons.size} daemon(s)...`);

    // Clear all reconnect timers
    for (const [sessionId, timer] of this.reconnectTimers) {
      clearTimeout(timer);
      this.reconnectTimers.delete(sessionId);
    }

    // Clear reconnect attempts
    this.reconnectAttempts.clear();

    // Clean up all SSE listeners
    for (const [sessionId, cleanup] of this.sseCleanups) {
      cleanup();
      this.sseCleanups.delete(sessionId);
    }

    // Clear pending QRs
    for (const [sessionId, pending] of this.pendingQRs) {
      pending.reject(new Error('Gateway shutting down'));
      this.pendingQRs.delete(sessionId);
    }

    // Kill all daemons
    for (const [sessionId, daemon] of this.daemons) {
      try {
        daemon.kill('SIGTERM');
      } catch (err) {
        logger.error(`Error killing daemon for ${sessionId}:`, err);
      }
    }
    this.daemons.clear();
    this.usedPorts.clear();

    logger.info('All daemons shut down');
  }
}

export const sessionManager = new SessionManager();
