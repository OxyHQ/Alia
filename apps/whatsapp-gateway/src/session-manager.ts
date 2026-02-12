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
import { WhatsAppSession, type IWhatsAppSession } from './models/whatsapp-session';
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
  private pendingQRs: Map<string, PendingQR> = new Map();
  private credsSaveQueue: Promise<void> = Promise.resolve();

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
        await this.startSession(session.oxyUserId);
      } catch (err) {
        console.error(`[WhatsApp] Failed to restore session for ${session.oxyUserId}:`, err);
      }
    }
  }

  /**
   * Create a brand-new session for a user who wants to link their WhatsApp.
   * Returns a promise that resolves with the first QR code string.
   */
  async createSession(oxyUserId: string): Promise<{ qrPromise: Promise<string> }> {
    // Clean up any existing session/socket for this user
    await this.cleanupSocket(oxyUserId);

    // Upsert the MongoDB document
    await WhatsAppSession.findOneAndUpdate(
      { oxyUserId },
      {
        $set: {
          status: 'qr-pending',
          authState: null,
          authKeys: new Map(),
          lastQR: null,
        },
        $setOnInsert: { oxyUserId },
      },
      { upsert: true, new: true }
    );

    // Set up a QR promise that the HTTP handler can await
    let qrResolve!: (qr: string) => void;
    let qrReject!: (err: Error) => void;
    const qrPromise = new Promise<string>((resolve, reject) => {
      qrResolve = resolve;
      qrReject = reject;
    });
    this.pendingQRs.set(oxyUserId, { resolve: qrResolve, reject: qrReject, promise: qrPromise });

    // Auto-reject if no QR received within 30 seconds
    setTimeout(() => {
      const pending = this.pendingQRs.get(oxyUserId);
      if (pending) {
        pending.reject(new Error('QR code generation timed out'));
        this.pendingQRs.delete(oxyUserId);
      }
    }, 30000);

    // Start the session (which will emit the QR)
    await this.startSession(oxyUserId);

    return { qrPromise };
  }

  /**
   * Start or reconnect an existing session using auth stored in MongoDB.
   */
  async startSession(oxyUserId: string): Promise<void> {
    const sessionData = await WhatsAppSession.findOne({ oxyUserId });
    if (!sessionData) {
      throw new Error(`No session record found for user ${oxyUserId}`);
    }

    // Build MongoDB-backed auth state
    const { state, saveCreds } = await this.createMongoAuthState(oxyUserId, sessionData);

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ['Alia', 'Chrome', '120.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    this.sessions.set(oxyUserId, sock);

    // ---- Connection updates ----
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Store QR for polling endpoint and resolve the pending promise
        await WhatsAppSession.updateOne(
          { oxyUserId },
          { $set: { status: 'qr-pending', lastQR: qr } }
        );

        const pending = this.pendingQRs.get(oxyUserId);
        if (pending) {
          pending.resolve(qr);
          this.pendingQRs.delete(oxyUserId);
        }

        console.log(`[WhatsApp] QR code generated for user ${oxyUserId}`);
      }

      if (connection === 'open') {
        const phoneNumber = sock.user?.id?.split(':')[0] || '';
        const displayName = sock.user?.name || '';

        await WhatsAppSession.updateOne(
          { oxyUserId },
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
        console.log(`[WhatsApp] Session connected for user ${oxyUserId} (${phoneNumber})`);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        this.sessions.delete(oxyUserId);

        if (shouldReconnect) {
          await WhatsAppSession.updateOne(
            { oxyUserId },
            { $set: { status: 'disconnected', lastDisconnected: new Date() } }
          );
          console.log(
            `[WhatsApp] Session disconnected for user ${oxyUserId} (status ${statusCode}), reconnecting in 5s...`
          );

          // Clear any existing reconnect timer
          const existing = this.reconnectTimers.get(oxyUserId);
          if (existing) clearTimeout(existing);

          const timer = setTimeout(() => {
            this.reconnectTimers.delete(oxyUserId);
            this.startSession(oxyUserId).catch((err) =>
              console.error(`[WhatsApp] Reconnect failed for ${oxyUserId}:`, err)
            );
          }, 5000);
          this.reconnectTimers.set(oxyUserId, timer);
        } else {
          await WhatsAppSession.updateOne(
            { oxyUserId },
            {
              $set: {
                status: 'logged-out',
                authState: null,
                authKeys: new Map(),
                lastQR: null,
              },
            }
          );
          console.log(`[WhatsApp] Session logged out for user ${oxyUserId}`);
        }
      }
    });

    // ---- Credential updates ----
    sock.ev.on('creds.update', saveCreds);

    // ---- Incoming messages ----
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;
        try {
          await handleIncomingMessage(oxyUserId, sock, msg);
        } catch (err) {
          console.error(`[WhatsApp] Error handling message for ${oxyUserId}:`, err);
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
    oxyUserId: string,
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
        const fresh = await WhatsAppSession.findOne({ oxyUserId }).lean();
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
          await WhatsAppSession.updateOne({ oxyUserId }, ops);
        }
      },
    };

    // In-memory cache reduces MongoDB reads for frequently-accessed signal keys
    const keys = makeCacheableSignalKeyStore(store);

    const saveCreds = () => {
      this.credsSaveQueue = this.credsSaveQueue
        .then(() => WhatsAppSession.updateOne({ oxyUserId }, { $set: { authState: serialize(creds) } }))
        .then(() => {})
        .catch((err) => console.error(`[WhatsApp] Failed to save creds for ${oxyUserId}:`, err));
    };

    return { state: { creds, keys }, saveCreds };
  }

  /**
   * Disconnect and log out a user's session (removes auth data).
   */
  async disconnectSession(oxyUserId: string): Promise<void> {
    const sock = this.sessions.get(oxyUserId);
    if (sock) {
      try {
        await sock.logout();
      } catch (err) {
        console.error(`[WhatsApp] Logout error for ${oxyUserId}:`, err);
        // Force-close even if logout fails
        sock.end(undefined);
      }
      this.sessions.delete(oxyUserId);
    }

    // Clear reconnect timer
    const timer = this.reconnectTimers.get(oxyUserId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(oxyUserId);
    }

    await WhatsAppSession.updateOne(
      { oxyUserId },
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
   * Get session status from MongoDB.
   */
  async getStatus(oxyUserId: string) {
    return WhatsAppSession.findOne({ oxyUserId }).lean();
  }

  /**
   * Get the active WASocket for a user.
   */
  getSocket(oxyUserId: string): WASocket | undefined {
    return this.sessions.get(oxyUserId);
  }

  /**
   * List all sessions from MongoDB.
   */
  async listSessions() {
    return WhatsAppSession.find()
      .select('oxyUserId phoneNumber displayName status lastConnected lastDisconnected createdAt')
      .lean();
  }

  /**
   * Gracefully shut down all active sessions.
   */
  async shutdown(): Promise<void> {
    console.log(`[WhatsApp] Shutting down ${this.sessions.size} session(s)...`);

    // Clear all reconnect timers
    for (const [userId, timer] of this.reconnectTimers) {
      clearTimeout(timer);
      this.reconnectTimers.delete(userId);
    }

    // Close all sockets
    for (const [userId, sock] of this.sessions) {
      try {
        sock.end(undefined);
      } catch (err) {
        console.error(`[WhatsApp] Error closing socket for ${userId}:`, err);
      }
    }
    this.sessions.clear();

    console.log('[WhatsApp] All sessions shut down');
  }

  /**
   * Internal: clean up socket and timers for a user before creating a new session.
   */
  private async cleanupSocket(oxyUserId: string): Promise<void> {
    const existingSock = this.sessions.get(oxyUserId);
    if (existingSock) {
      try {
        existingSock.end(undefined);
      } catch {
        // ignore
      }
      this.sessions.delete(oxyUserId);
    }

    const timer = this.reconnectTimers.get(oxyUserId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(oxyUserId);
    }
  }
}

export const sessionManager = new SessionManager();
