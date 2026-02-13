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
import { v4 as uuidv4 } from 'uuid';
import { WhatsAppSession, type IWhatsAppSession } from './models/whatsapp-session';
import { WhatsAppChat } from './models/whatsapp-chat';
import { WhatsAppMessage } from './models/whatsapp-message';
import { handleIncomingMessage } from './handlers/chat';

/** Convert Buffers to base64 JSON objects before MongoDB storage (avoids BSON Binary). */
function serialize(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data, BufferJSON.replacer));
}

/** Restore Buffers from MongoDB (handles both base64 JSON and legacy BSON Binary). */
function deserialize<T = unknown>(data: unknown): T {
  return JSON.parse(JSON.stringify(data, (_key, value) => {
    if (value?._bsontype === 'Binary') {
      return { type: 'Buffer', data: Buffer.from(value.buffer).toString('base64') };
    }
    return value;
  }), BufferJSON.reviver);
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
   * On startup, load all 'connected' or 'disconnected' sessions from MongoDB
   * and attempt to reconnect them.
   */
  async initialize(): Promise<void> {
    const activeSessions = await WhatsAppSession.find({
      status: { $in: ['connected', 'disconnected'] },
    });
    console.log(`[WhatsApp] Found ${activeSessions.length} active session(s) to restore`);

    for (const session of activeSessions) {
      try {
        await this.startSession(session.sessionId);
      } catch (err) {
        console.error(`[WhatsApp] Failed to restore session ${session.sessionId} (user ${session.oxyUserId}):`, err);
      }
    }
  }

  /**
   * Create a brand-new session for a user who wants to link their WhatsApp.
   * Returns the sessionId and a promise that resolves with the first QR code string.
   */
  async createSession(oxyUserId: string): Promise<{ sessionId: string; qrPromise: Promise<string> }> {
    const sessionId = uuidv4();

    // Create a new MongoDB document for this session
    await WhatsAppSession.create({
      sessionId,
      oxyUserId,
      status: 'qr-pending',
      authState: null,
      authKeys: new Map(),
      lastQR: null,
    });

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
   * Start or reconnect an existing session using auth stored in MongoDB.
   */
  async startSession(sessionId: string): Promise<void> {
    const sessionData = await WhatsAppSession.findOne({ sessionId });
    if (!sessionData) {
      throw new Error(`No session record found for sessionId ${sessionId}`);
    }

    const oxyUserId = sessionData.oxyUserId;

    // Clean up any existing socket for this sessionId
    await this.cleanupSocket(sessionId);

    // Build MongoDB-backed auth state
    const { state, saveCreds } = await this.createMongoAuthState(sessionId, sessionData);

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
        await WhatsAppSession.updateOne(
          { sessionId },
          { $set: { status: 'qr-pending', lastQR: qr } }
        );

        const pending = this.pendingQRs.get(sessionId);
        if (pending) {
          pending.resolve(qr);
          this.pendingQRs.delete(sessionId);
        }

        console.log(`[WhatsApp] QR code generated for session ${sessionId} (user ${oxyUserId})`);
      }

      if (connection === 'open') {
        // Reset reconnect counter on successful connection
        this.reconnectAttempts.delete(sessionId);

        const phoneNumber = sock.user?.id?.split(':')[0] || '';
        const displayName = sock.user?.name || '';

        await WhatsAppSession.updateOne(
          { sessionId },
          {
            $set: {
              status: 'connected',
              lastConnected: new Date(),
              phoneNumber,
              displayName,
              lastQR: null,
            },
          }
        );
        console.log(`[WhatsApp] Session ${sessionId} connected for user ${oxyUserId} (${phoneNumber})`);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        this.sessions.delete(sessionId);

        if (shouldReconnect) {
          const attempts = (this.reconnectAttempts.get(sessionId) || 0) + 1;
          this.reconnectAttempts.set(sessionId, attempts);

          if (attempts > SessionManager.MAX_RECONNECT_ATTEMPTS) {
            await WhatsAppSession.updateOne(
              { sessionId },
              { $set: { status: 'failed', lastDisconnected: new Date() } }
            );
            this.reconnectAttempts.delete(sessionId);
            console.error(
              `[WhatsApp] Session ${sessionId} for ${oxyUserId} failed after ${SessionManager.MAX_RECONNECT_ATTEMPTS} reconnect attempts`
            );
          } else {
            const delay = Math.min(
              SessionManager.BASE_RECONNECT_MS * Math.pow(2, attempts - 1),
              SessionManager.MAX_RECONNECT_MS,
            ) + Math.floor(Math.random() * SessionManager.JITTER_MAX_MS);

            await WhatsAppSession.updateOne(
              { sessionId },
              { $set: { status: 'disconnected', lastDisconnected: new Date() } }
            );
            console.log(
              `[WhatsApp] Session ${sessionId} disconnected for user ${oxyUserId} (status ${statusCode}), reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts}/${SessionManager.MAX_RECONNECT_ATTEMPTS})...`
            );

            // Clear any existing reconnect timer
            const existing = this.reconnectTimers.get(sessionId);
            if (existing) clearTimeout(existing);

            const timer = setTimeout(() => {
              this.reconnectTimers.delete(sessionId);
              this.startSession(sessionId).catch((err) =>
                console.error(`[WhatsApp] Reconnect failed for session ${sessionId}:`, err)
              );
            }, delay);
            this.reconnectTimers.set(sessionId, timer);
          }
        } else {
          await WhatsAppSession.updateOne(
            { sessionId },
            {
              $set: {
                status: 'logged-out',
                authState: null,
                authKeys: new Map(),
                lastQR: null,
              },
            }
          );
          console.log(`[WhatsApp] Session ${sessionId} logged out for user ${oxyUserId}`);
        }
      }
    });

    // ---- Credential updates ----
    sock.ev.on('creds.update', saveCreds);

    // ---- Incoming messages ----
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Persist all messages to MongoDB (both notify and history sync)
      for (const msg of messages) {
        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || '';
        if (!text || !msg.key.id || !msg.key.remoteJid) continue;

        const ts = msg.messageTimestamp;
        const timestamp = typeof ts === 'number' ? ts : (ts as any)?.low || Math.floor(Date.now() / 1000);

        try {
          await WhatsAppMessage.updateOne(
            { sessionId, messageId: msg.key.id },
            {
              $setOnInsert: {
                sessionId,
                oxyUserId,
                jid: msg.key.remoteJid,
                messageId: msg.key.id,
                fromMe: msg.key.fromMe || false,
                timestamp,
                text,
                pushName: msg.pushName || undefined,
              },
            },
            { upsert: true }
          );
        } catch (err: any) {
          if (err.code !== 11000) { // ignore duplicate key
            console.error(`[WhatsApp] Error persisting message for session ${sessionId}:`, err);
          }
        }
      }

      // Only forward real-time incoming messages to the chat handler
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;
        try {
          await handleIncomingMessage(sessionId, sock, msg);
        } catch (err) {
          console.error(`[WhatsApp] Error handling message for session ${sessionId}:`, err);
        }
      }
    });

    // ---- Chat sync (persist chats to MongoDB) ----
    sock.ev.on('chats.upsert', async (chats) => {
      for (const chat of chats) {
        if (!chat.id || chat.id === 'status@broadcast') continue;
        const ts = chat.conversationTimestamp;
        const timestamp = typeof ts === 'number' ? ts : (ts as any)?.low || 0;

        try {
          await WhatsAppChat.updateOne(
            { sessionId, jid: chat.id },
            {
              $set: {
                name: chat.name || chat.id.split('@')[0],
                unreadCount: chat.unreadCount || 0,
                conversationTimestamp: timestamp,
              },
              $setOnInsert: { sessionId, oxyUserId, jid: chat.id },
            },
            { upsert: true }
          );
        } catch (err) {
          console.error(`[WhatsApp] Error persisting chat for session ${sessionId}:`, err);
        }
      }
    });

    sock.ev.on('chats.update', async (updates) => {
      for (const update of updates) {
        if (!update.id || update.id === 'status@broadcast') continue;
        const $set: Record<string, any> = {};
        if (update.name) $set.name = update.name;
        if (update.unreadCount !== undefined) $set.unreadCount = update.unreadCount;
        if (update.conversationTimestamp) {
          const ts = update.conversationTimestamp;
          $set.conversationTimestamp = typeof ts === 'number' ? ts : (ts as any)?.low || 0;
        }

        if (Object.keys($set).length > 0) {
          try {
            await WhatsAppChat.updateOne(
              { sessionId, jid: update.id },
              { $set, $setOnInsert: { sessionId, oxyUserId, jid: update.id } },
              { upsert: true }
            );
          } catch (err) {
            console.error(`[WhatsApp] Error updating chat for session ${sessionId}:`, err);
          }
        }
      }
    });

    // ---- Deletions (keep MongoDB in sync) ----
    sock.ev.on('chats.delete', async (deletedJids) => {
      for (const jid of deletedJids) {
        try {
          await WhatsAppChat.deleteOne({ sessionId, jid });
          await WhatsAppMessage.deleteMany({ sessionId, jid });
        } catch (err) {
          console.error(`[WhatsApp] Error deleting chat ${jid} for session ${sessionId}:`, err);
        }
      }
    });

    sock.ev.on('messages.delete', async (item) => {
      if ('keys' in item) {
        // Individual message deletions
        for (const key of item.keys) {
          if (!key.id) continue;
          try {
            await WhatsAppMessage.deleteOne({ sessionId, messageId: key.id });
          } catch (err) {
            console.error(`[WhatsApp] Error deleting message for session ${sessionId}:`, err);
          }
        }
      } else if ('jid' in item && item.all) {
        // All messages in chat cleared
        try {
          await WhatsAppMessage.deleteMany({ sessionId, jid: (item as any).jid });
        } catch (err) {
          console.error(`[WhatsApp] Error clearing messages for session ${sessionId}:`, err);
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
            await WhatsAppMessage.updateOne(
              { sessionId, messageId: update.key.id },
              { $set: { text: newText } }
            );
          } catch (err) {
            console.error(`[WhatsApp] Error updating message for session ${sessionId}:`, err);
          }
        }
      }
    });

    // ---- History sync (bulk chat/message sets from WhatsApp) ----
    sock.ev.on('messaging-history.set', async ({ chats, messages, isLatest }) => {
      console.log(`[WhatsApp] History sync for session ${sessionId}: ${chats.length} chats, ${messages.length} messages (isLatest: ${isLatest})`);

      // Bulk upsert chats
      if (chats.length > 0) {
        const chatOps = chats
          .filter((c: any) => c.id !== 'status@broadcast')
          .map((c: any) => {
            const ts = c.conversationTimestamp;
            const timestamp = typeof ts === 'number' ? ts : (ts as any)?.low || 0;
            return {
              updateOne: {
                filter: { sessionId, jid: c.id },
                update: {
                  $set: {
                    name: c.name || c.id.split('@')[0],
                    unreadCount: c.unreadCount || 0,
                    conversationTimestamp: timestamp,
                  },
                  $setOnInsert: { sessionId, oxyUserId, jid: c.id },
                },
                upsert: true,
              },
            };
          });

        if (chatOps.length > 0) {
          try {
            await WhatsAppChat.bulkWrite(chatOps, { ordered: false });
          } catch (err) {
            console.error(`[WhatsApp] Error bulk upserting chats for session ${sessionId}:`, err);
          }
        }
      }

      // Bulk upsert messages
      if (messages.length > 0) {
        const msgOps = messages
          .filter((m: any) => {
            const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
            return text && m.key?.id && m.key?.remoteJid;
          })
          .map((m: any) => {
            const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
            const ts = m.messageTimestamp;
            const timestamp = typeof ts === 'number' ? ts : (ts as any)?.low || Math.floor(Date.now() / 1000);
            return {
              updateOne: {
                filter: { sessionId, messageId: m.key.id },
                update: {
                  $setOnInsert: {
                    sessionId,
                    oxyUserId,
                    jid: m.key.remoteJid,
                    messageId: m.key.id,
                    fromMe: m.key.fromMe || false,
                    timestamp,
                    text,
                    pushName: m.pushName || undefined,
                  },
                },
                upsert: true,
              },
            };
          });

        if (msgOps.length > 0) {
          try {
            await WhatsAppMessage.bulkWrite(msgOps, { ordered: false });
            console.log(`[WhatsApp] Persisted ${msgOps.length} messages for session ${sessionId}`);
          } catch (err) {
            console.error(`[WhatsApp] Error bulk upserting messages for session ${sessionId}:`, err);
          }
        }
      }
    });
  }

  /**
   * Build a Baileys-compatible AuthenticationState backed by MongoDB.
   *
   * - `creds` are stored in sessionData.authState
   * - signal keys (pre-keys, sessions, sender-keys, app-state-sync-keys, etc.)
   *   are stored in sessionData.authKeys as a Map<string, Mixed>
   *   where each key is `${type}-${id}` and the value is the serialized key data.
   */
  async createMongoAuthState(
    sessionId: string,
    sessionData: IWhatsAppSession
  ): Promise<{ state: AuthenticationState; saveCreds: () => void }> {
    // Load creds from DB or initialize fresh ones for a new session.
    // initAuthCreds() generates the identity keys that Baileys needs to
    // perform the Noise handshake with WhatsApp servers.
    let creds: AuthenticationCreds = sessionData.authState
      ? deserialize<AuthenticationCreds>(sessionData.authState)
      : initAuthCreds();

    const store: SignalKeyStore = {
      get: async (type: string, ids: string[]) => {
        const result: Record<string, any> = {};
        const fresh = await WhatsAppSession.findOne({ sessionId }).lean();
        const authKeys = fresh?.authKeys as Record<string, any> | undefined;

        for (const id of ids) {
          const value = authKeys?.[`${type}-${id}`];
          if (value) {
            result[id] = deserialize(value);
          }
        }
        return result;
      },

      set: async (data: Record<string, Record<string, any>>) => {
        const $set: Record<string, any> = {};
        const $unset: Record<string, any> = {};

        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries)) {
            const key = `authKeys.${type}-${id}`;
            if (value) {
              $set[key] = serialize(value);
            } else {
              $unset[key] = '';
            }
          }
        }

        const ops: Record<string, any> = {};
        if (Object.keys($set).length > 0) ops['$set'] = $set;
        if (Object.keys($unset).length > 0) ops['$unset'] = $unset;

        if (Object.keys(ops).length > 0) {
          await WhatsAppSession.updateOne({ sessionId }, ops);
        }
      },
    };

    // In-memory cache reduces MongoDB reads for frequently-accessed signal keys
    const keys = makeCacheableSignalKeyStore(store);

    const saveCreds = () => {
      this.credsSaveQueue = this.credsSaveQueue
        .then(() => WhatsAppSession.updateOne({ sessionId }, { $set: { authState: serialize(creds) } }))
        .then(() => {})
        .catch((err) => console.error(`[WhatsApp] Failed to save creds for session ${sessionId}:`, err));
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
        console.error(`[WhatsApp] Logout error for session ${sessionId}:`, err);
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

    await WhatsAppSession.updateOne(
      { sessionId },
      {
        $set: {
          status: 'logged-out',
          authState: null,
          authKeys: new Map(),
          lastQR: null,
        },
      }
    );
  }

  /**
   * Get session status from MongoDB by sessionId.
   */
  async getStatus(sessionId: string) {
    return WhatsAppSession.findOne({ sessionId }).lean();
  }

  /**
   * Get all sessions for a specific user.
   */
  async getUserSessions(oxyUserId: string) {
    return WhatsAppSession.find({ oxyUserId })
      .select('sessionId oxyUserId phoneNumber displayName status lastConnected lastDisconnected createdAt')
      .lean();
  }

  /**
   * Get the active WASocket for a session.
   */
  getSocket(sessionId: string): WASocket | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all sessions from MongoDB.
   */
  async listSessions() {
    return WhatsAppSession.find()
      .select('sessionId oxyUserId phoneNumber displayName status lastConnected lastDisconnected createdAt')
      .lean();
  }

  /**
   * Gracefully shut down all active sessions.
   */
  async shutdown(): Promise<void> {
    console.log(`[WhatsApp] Shutting down ${this.sessions.size} session(s)...`);

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
        console.error(`[WhatsApp] Error closing socket for session ${sessionId}:`, err);
      }
    }
    this.sessions.clear();

    console.log('[WhatsApp] All sessions shut down');
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
