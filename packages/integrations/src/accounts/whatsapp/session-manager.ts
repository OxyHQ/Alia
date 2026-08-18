import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalKeyStore,
  type WASocket,
} from '@whiskeysockets/baileys';
import { randomUUID } from 'node:crypto';
import { getDb } from '../../db';
import {
  createWhatsAppSession,
  deleteWhatsAppChat,
  deleteWhatsAppMessage,
  deleteWhatsAppMessagesForChat,
  findRestorableWhatsAppSessions,
  findWhatsAppSession,
  findWhatsAppSessionOwner,
  findWhatsAppSessionQr,
  insertWhatsAppMessages,
  listWhatsAppSessions,
  listWhatsAppSessionsForUser,
  markWhatsAppConnected,
  markWhatsAppDisconnected,
  markWhatsAppFailed,
  markWhatsAppLoggedOut,
  markWhatsAppQrPending,
  readWhatsAppAuthKeys,
  readWhatsAppAuthState,
  saveWhatsAppAuthState,
  updateWhatsAppMessageText,
  upsertWhatsAppChat,
  upsertWhatsAppChats,
  writeWhatsAppAuthKeys,
  type WhatsAppChatSync,
  type WhatsAppMessageInsert,
} from './repository';
import { handleIncomingMessage } from '../../shared/chat-handler';
import { APIClient } from '../../shared/api-client';
import { createLogger } from '../../shared/logger';

const apiClient = new APIClient('whatsapp', process.env.INTEGRATIONS_SECRET || '');
const logger = createLogger('WhatsApp');

/** Baileys timestamps are `number` or a protobuf `Long` (`{ low, high }`). */
type LongLike = { low: number; high?: number };
function toUnixSeconds(ts: number | LongLike | null | undefined, fallback: number): number {
  if (typeof ts === 'number') return ts;
  if (ts && typeof ts === 'object' && typeof ts.low === 'number') return ts.low;
  return fallback;
}

/** Convert Buffers to base64 JSON objects before storage (jsonb holds no bytes). */
function serialize(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data, BufferJSON.replacer));
}

/** Restore Buffers from the stored jsonb. */
function deserialize<T = unknown>(data: unknown): T {
  return JSON.parse(JSON.stringify(data), BufferJSON.reviver) as T;
}

/**
 * Pending QR resolver used while a session is being created and the user
 * has not scanned the QR code yet. The HTTP endpoint polls or awaits this.
 */
interface PendingQR {
  resolve: (qr: string) => void;
  reject: (err: Error) => void;
  promise: Promise<string>;
}

class SessionManager {
  private sessions: Map<string, WASocket> = new Map();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private pendingQRs: Map<string, PendingQR> = new Map();
  private credsSaveQueue: Promise<void> = Promise.resolve();

  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly BASE_RECONNECT_MS = 5000;
  private static readonly MAX_RECONNECT_MS = 60000;
  private static readonly JITTER_MAX_MS = 1000;

  /**
   * On startup, load all 'connected' or 'disconnected' sessions and attempt to
   * reconnect them.
   */
  async initialize(): Promise<void> {
    const activeSessions = await findRestorableWhatsAppSessions(getDb());
    logger.info(`Found ${activeSessions.length} active session(s) to restore`);

    for (const session of activeSessions) {
      try {
        await this.startSession(session.sessionId);
      } catch (err) {
        logger.error(`Failed to restore session ${session.sessionId} (user ${session.oxyUserId}):`, err);
      }
    }
  }

  /**
   * Create a brand-new session for a user who wants to link their WhatsApp.
   * Returns the sessionId and a promise that resolves with the first QR code string.
   */
  async createSession(oxyUserId: string): Promise<{ sessionId: string; qrPromise: Promise<string> }> {
    const sessionId = randomUUID();

    await createWhatsAppSession(getDb(), { sessionId, oxyUserId });

    // Set up a QR promise that the HTTP handler can await
    let qrResolve!: (qr: string) => void;
    let qrReject!: (err: Error) => void;
    const qrPromise = new Promise<string>((resolve, reject) => {
      qrResolve = resolve;
      qrReject = reject;
    });
    this.pendingQRs.set(sessionId, { resolve: qrResolve, reject: qrReject, promise: qrPromise });

    // Auto-reject if no QR received within 30 seconds
    setTimeout(() => {
      const pending = this.pendingQRs.get(sessionId);
      if (pending) {
        pending.reject(new Error('QR code generation timed out'));
        this.pendingQRs.delete(sessionId);
      }
    }, 30000);

    // Start the session (which will emit the QR)
    await this.startSession(sessionId);

    return { sessionId, qrPromise };
  }

  /**
   * Start or reconnect an existing session using the stored auth state.
   */
  async startSession(sessionId: string): Promise<void> {
    const oxyUserId = await findWhatsAppSessionOwner(getDb(), sessionId);
    if (!oxyUserId) {
      throw new Error(`No session record found for sessionId ${sessionId}`);
    }

    // Clean up any existing socket for this sessionId
    await this.cleanupSocket(sessionId);

    // Build Postgres-backed auth state
    const { state, saveCreds } = await this.createAuthState(sessionId);

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ['Alia', 'Chrome', '120.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: true,
    });

    this.sessions.set(sessionId, sock);

    // ---- Connection updates ----
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Store QR for polling endpoint and resolve the pending promise
        await markWhatsAppQrPending(getDb(), sessionId, qr);

        const pending = this.pendingQRs.get(sessionId);
        if (pending) {
          pending.resolve(qr);
          this.pendingQRs.delete(sessionId);
        }

        logger.info(`QR code generated for session ${sessionId} (user ${oxyUserId})`);
      }

      if (connection === 'open') {
        // Reset reconnect counter on successful connection
        this.reconnectAttempts.delete(sessionId);

        const phoneNumber = sock.user?.id?.split(':')[0] || '';
        const displayName = sock.user?.name || '';

        await markWhatsAppConnected(getDb(), sessionId, { phoneNumber, displayName });
        logger.info(`Session ${sessionId} connected for user ${oxyUserId} (${phoneNumber})`);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        this.sessions.delete(sessionId);

        if (shouldReconnect) {
          const attempts = (this.reconnectAttempts.get(sessionId) || 0) + 1;
          this.reconnectAttempts.set(sessionId, attempts);

          if (attempts > SessionManager.MAX_RECONNECT_ATTEMPTS) {
            await markWhatsAppFailed(getDb(), sessionId);
            this.reconnectAttempts.delete(sessionId);
            logger.error(
              `Session ${sessionId} for ${oxyUserId} failed after ${SessionManager.MAX_RECONNECT_ATTEMPTS} reconnect attempts`
            );
          } else {
            const delay = Math.min(
              SessionManager.BASE_RECONNECT_MS * Math.pow(2, attempts - 1),
              SessionManager.MAX_RECONNECT_MS,
            ) + Math.floor(Math.random() * SessionManager.JITTER_MAX_MS);

            await markWhatsAppDisconnected(getDb(), sessionId);
            logger.info(
              `Session ${sessionId} disconnected for user ${oxyUserId} (status ${statusCode}), reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts}/${SessionManager.MAX_RECONNECT_ATTEMPTS})...`
            );

            // Clear any existing reconnect timer
            const existing = this.reconnectTimers.get(sessionId);
            if (existing) clearTimeout(existing);

            const timer = setTimeout(() => {
              this.reconnectTimers.delete(sessionId);
              this.startSession(sessionId).catch((err) =>
                logger.error(`Reconnect failed for session ${sessionId}:`, err)
              );
            }, delay);
            this.reconnectTimers.set(sessionId, timer);
          }
        } else {
          await markWhatsAppLoggedOut(getDb(), sessionId);
          logger.info(`Session ${sessionId} logged out for user ${oxyUserId}`);
        }
      }
    });

    // ---- Credential updates ----
    sock.ev.on('creds.update', saveCreds);

    // ---- Incoming messages ----
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Persist all messages (both notify and history sync)
      const rows: WhatsAppMessageInsert[] = [];
      for (const msg of messages) {
        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || '';
        if (!text || !msg.key.id || !msg.key.remoteJid) continue;

        rows.push({
          sessionId,
          oxyUserId,
          jid: msg.key.remoteJid,
          messageId: msg.key.id,
          fromMe: msg.key.fromMe || false,
          timestamp: toUnixSeconds(msg.messageTimestamp, Math.floor(Date.now() / 1000)),
          text,
          pushName: msg.pushName || undefined,
        });
      }

      if (rows.length > 0) {
        try {
          await insertWhatsAppMessages(getDb(), rows);
        } catch (err) {
          logger.error(`Error persisting messages for session ${sessionId}:`, err);
        }
      }

      // Only forward real-time incoming messages to the chat handler
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          '';

        if (!text) continue;

        const remoteJid = msg.key?.remoteJid;
        if (!remoteJid) continue;

        // Look up the oxyUserId from the session record
        const owner = await findWhatsAppSessionOwner(getDb(), sessionId);
        if (!owner) {
          logger.error(`Chat: No session found for sessionId ${sessionId}`);
          continue;
        }

        try {
          await handleIncomingMessage({
            platform: 'whatsapp',
            sessionId,
            oxyUserId: owner,
            chatId: remoteJid,
            messageText: text,
            sendResponse: async (text) => { await sock.sendMessage(remoteJid, { text }); },
            setTyping: async (typing) => {
              await sock.presenceSubscribe(remoteJid);
              await sock.sendPresenceUpdate(typing ? 'composing' : 'available', remoteJid);
            },
            charLimit: 4000,
            platformContext: 'Accessible via WhatsApp. Keep responses under 3000 characters when possible.',
          }, apiClient);
        } catch (err) {
          logger.error(`Error handling message for session ${sessionId}:`, err);
        }
      }
    });

    // ---- Chat sync ----
    sock.ev.on('chats.upsert', async (chats) => {
      for (const chat of chats) {
        if (!chat.id || chat.id === 'status@broadcast') continue;

        try {
          await upsertWhatsAppChat(getDb(), {
            sessionId,
            oxyUserId,
            jid: chat.id,
            name: chat.name || chat.id.split('@')[0],
            unreadCount: chat.unreadCount || 0,
            conversationTimestamp: toUnixSeconds(chat.conversationTimestamp, 0),
          });
        } catch (err) {
          logger.error(`Error persisting chat for session ${sessionId}:`, err);
        }
      }
    });

    sock.ev.on('chats.update', async (updates) => {
      for (const update of updates) {
        if (!update.id || update.id === 'status@broadcast') continue;

        // Baileys reports only what changed; an absent field must stay absent so
        // the upsert leaves the stored value alone rather than nulling it.
        const changes: {
          name?: string;
          unreadCount?: number;
          conversationTimestamp?: number;
        } = {};
        if (update.name) changes.name = update.name;
        if (update.unreadCount !== undefined && update.unreadCount !== null) {
          changes.unreadCount = update.unreadCount;
        }
        if (update.conversationTimestamp) {
          changes.conversationTimestamp = toUnixSeconds(update.conversationTimestamp, 0);
        }

        if (Object.keys(changes).length > 0) {
          try {
            await upsertWhatsAppChat(getDb(), {
              sessionId,
              oxyUserId,
              jid: update.id,
              ...changes,
            });
          } catch (err) {
            logger.error(`Error updating chat for session ${sessionId}:`, err);
          }
        }
      }
    });

    // ---- Deletions ----
    sock.ev.on('chats.delete', async (deletedJids) => {
      for (const jid of deletedJids) {
        try {
          await deleteWhatsAppChat(getDb(), sessionId, jid);
          await deleteWhatsAppMessagesForChat(getDb(), sessionId, jid);
        } catch (err) {
          logger.error(`Error deleting chat ${jid} for session ${sessionId}:`, err);
        }
      }
    });

    sock.ev.on('messages.delete', async (item) => {
      if ('keys' in item) {
        // Individual message deletions
        for (const key of item.keys) {
          if (!key.id) continue;
          try {
            await deleteWhatsAppMessage(getDb(), sessionId, key.id);
          } catch (err) {
            logger.error(`Error deleting message for session ${sessionId}:`, err);
          }
        }
      } else if ('jid' in item && item.all) {
        // All messages in chat cleared
        try {
          await deleteWhatsAppMessagesForChat(getDb(), sessionId, item.jid);
        } catch (err) {
          logger.error(`Error clearing messages for session ${sessionId}:`, err);
        }
      }
    });

    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (!update.key?.id) continue;
        // Handle message edits
        const newText = update.update?.message?.conversation
          || update.update?.message?.extendedTextMessage?.text;
        if (newText) {
          try {
            await updateWhatsAppMessageText(getDb(), sessionId, update.key.id, newText);
          } catch (err) {
            logger.error(`Error updating message for session ${sessionId}:`, err);
          }
        }
      }
    });

    // ---- History sync (bulk chat/message sets from WhatsApp) ----
    sock.ev.on('messaging-history.set', async ({ chats, messages, isLatest }) => {
      logger.info(`History sync for session ${sessionId}: ${chats.length} chats, ${messages.length} messages (isLatest: ${isLatest})`);

      const chatRows: WhatsAppChatSync[] = chats
        .filter((c) => c.id !== 'status@broadcast')
        .map((c) => ({
          sessionId,
          oxyUserId,
          jid: c.id,
          name: c.name || c.id.split('@')[0],
          unreadCount: c.unreadCount || 0,
          conversationTimestamp: toUnixSeconds(c.conversationTimestamp, 0),
        }));

      if (chatRows.length > 0) {
        try {
          await upsertWhatsAppChats(getDb(), chatRows);
        } catch (err) {
          logger.error(`Error bulk upserting chats for session ${sessionId}:`, err);
        }
      }

      const messageRows: WhatsAppMessageInsert[] = [];
      for (const m of messages) {
        const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        if (!text || !m.key?.id || !m.key?.remoteJid) continue;

        messageRows.push({
          sessionId,
          oxyUserId,
          jid: m.key.remoteJid,
          messageId: m.key.id,
          fromMe: m.key.fromMe || false,
          timestamp: toUnixSeconds(m.messageTimestamp, Math.floor(Date.now() / 1000)),
          text,
          pushName: m.pushName || undefined,
        });
      }

      if (messageRows.length > 0) {
        try {
          await insertWhatsAppMessages(getDb(), messageRows);
          logger.info(`Persisted ${messageRows.length} messages for session ${sessionId}`);
        } catch (err) {
          logger.error(`Error bulk upserting messages for session ${sessionId}:`, err);
        }
      }
    });
  }

  /**
   * Build a Baileys-compatible AuthenticationState backed by Postgres.
   *
   * - `creds` live in `whatsapp_sessions.auth_state`
   * - signal keys (pre-keys, sessions, sender-keys, app-state-sync-keys) live in
   *   `whatsapp_sessions.auth_keys`, one jsonb object whose keys are Baileys'
   *   own type-and-id strings and whose values are the serialized key data.
   */
  async createAuthState(
    sessionId: string,
  ): Promise<{ state: AuthenticationState; saveCreds: () => void }> {
    // Load creds from the database or initialize fresh ones for a new session.
    // initAuthCreds() generates the identity keys that Baileys needs to
    // perform the Noise handshake with WhatsApp servers.
    const storedCreds = await readWhatsAppAuthState(getDb(), sessionId);
    const creds: AuthenticationCreds = storedCreds
      ? deserialize<AuthenticationCreds>(storedCreds)
      : initAuthCreds();

    const store: SignalKeyStore = {
      // Baileys' `get` is generic over `SignalDataTypeMap`; our store deserializes
      // opaque JSON, so the per-type value shape is recovered via the SDK's own typing.
      get: (async (type: string, ids: string[]) => {
        const result: Record<string, unknown> = {};
        const authKeys = await readWhatsAppAuthKeys(getDb(), sessionId);

        for (const id of ids) {
          const value = authKeys[`${type}-${id}`];
          if (value) {
            result[id] = deserialize(value);
          }
        }
        return result;
      }) as SignalKeyStore['get'],

      set: async (data: Record<string, Record<string, unknown>>) => {
        const set: Record<string, unknown> = {};
        const remove: string[] = [];

        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries)) {
            const key = `${type}-${id}`;
            if (value) {
              set[key] = serialize(value);
            } else {
              remove.push(key);
            }
          }
        }

        await writeWhatsAppAuthKeys(getDb(), sessionId, { set, remove });
      },
    };

    // In-memory cache reduces reads for frequently-accessed signal keys
    const keys = makeCacheableSignalKeyStore(store);

    const saveCreds = () => {
      this.credsSaveQueue = this.credsSaveQueue
        .then(() => saveWhatsAppAuthState(getDb(), sessionId, serialize(creds)))
        .then(() => {})
        .catch((err) => logger.error(`Failed to save creds for session ${sessionId}:`, err));
    };

    return { state: { creds, keys }, saveCreds };
  }

  /**
   * Disconnect and log out a session (removes auth data).
   */
  async disconnectSession(sessionId: string): Promise<void> {
    const sock = this.sessions.get(sessionId);
    if (sock) {
      try {
        await sock.logout();
      } catch (err) {
        logger.error(`Logout error for session ${sessionId}:`, err);
        // Force-close even if logout fails
        sock.end(undefined);
      }
      this.sessions.delete(sessionId);
    }

    // Clear reconnect timer and attempts
    const timer = this.reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(sessionId);
    }
    this.reconnectAttempts.delete(sessionId);

    await markWhatsAppLoggedOut(getDb(), sessionId);
  }

  /**
   * Session status by sessionId, without the Baileys credentials.
   */
  async getStatus(sessionId: string) {
    return findWhatsAppSession(getDb(), sessionId);
  }

  /**
   * The pairing QR for a session that is awaiting a scan.
   */
  async getQr(sessionId: string) {
    return findWhatsAppSessionQr(getDb(), sessionId);
  }

  /**
   * Get all sessions for a specific user.
   */
  async getUserSessions(oxyUserId: string) {
    return listWhatsAppSessionsForUser(getDb(), oxyUserId);
  }

  /**
   * Get the active WASocket for a session.
   */
  getSocket(sessionId: string): WASocket | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all sessions.
   */
  async listSessions() {
    return listWhatsAppSessions(getDb());
  }

  /**
   * Gracefully shut down all active sessions.
   */
  async shutdown(): Promise<void> {
    logger.info(`Shutting down ${this.sessions.size} session(s)...`);

    // Clear all reconnect timers
    for (const [sessionId, timer] of this.reconnectTimers) {
      clearTimeout(timer);
      this.reconnectTimers.delete(sessionId);
    }

    // Clear reconnect attempts
    this.reconnectAttempts.clear();

    // Close all sockets
    for (const [sessionId, sock] of this.sessions) {
      try {
        sock.end(undefined);
      } catch (err) {
        logger.error(`Error closing socket for session ${sessionId}:`, err);
      }
    }
    this.sessions.clear();

    logger.info('All sessions shut down');
  }

  /**
   * Internal: clean up socket and timers for a session before creating a new one.
   */
  private async cleanupSocket(sessionId: string): Promise<void> {
    const existingSock = this.sessions.get(sessionId);
    if (existingSock) {
      try {
        existingSock.end(undefined);
      } catch {
        // ignore
      }
      this.sessions.delete(sessionId);
    }

    const pending = this.pendingQRs.get(sessionId);
    if (pending) {
      pending.reject(new Error('Session was reset'));
      this.pendingQRs.delete(sessionId);
    }

    const timer = this.reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(sessionId);
    }

    this.reconnectAttempts.delete(sessionId);
  }
}

export const sessionManager = new SessionManager();
