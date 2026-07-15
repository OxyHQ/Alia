import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import { Api } from 'telegram/tl';
import { v4 as uuidv4 } from 'uuid';
import { TelegramSession } from './models';
import { TelegramChat } from './models';
import { TelegramMessage } from './models';
import { handleIncomingMessage } from '../../shared/chat-handler';
import { APIClient } from '../../shared/api-client';
import { DedupSet, errorCode, errorMessage } from '../../shared/utils';
import { createLogger } from '../../shared/logger';

const apiClient = new APIClient('telegram-gateway', process.env.INTEGRATIONS_SECRET || '');
const dedup = new DedupSet();
const logger = createLogger('Telegram');

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
  private sessions: Map<string, TelegramClient> = new Map();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private pendingQRs: Map<string, PendingQR> = new Map();

  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly BASE_RECONNECT_MS = 5000;
  private static readonly MAX_RECONNECT_MS = 60000;
  private static readonly JITTER_MAX_MS = 1000;

  private get apiId(): number {
    return parseInt(process.env.TELEGRAM_API_ID || '0', 10);
  }

  private get apiHash(): string {
    return process.env.TELEGRAM_API_HASH || '';
  }

  /**
   * On startup, load all 'connected' or 'disconnected' sessions from MongoDB
   * and attempt to reconnect them.
   */
  async initialize(): Promise<void> {
    const activeSessions = await TelegramSession.find({
      status: { $in: ['connected', 'disconnected'] },
    });
    logger.info(`Found ${activeSessions.length} active session(s) to restore`);

    for (const session of activeSessions) {
      try {
        await this.startSession(session.sessionId);
      } catch (err) {
        logger.error(`Failed to restore session ${session.sessionId}:`, err);
      }
    }
  }

  /**
   * Create a brand-new session for a user who wants to link their Telegram.
   * Returns a sessionId and a promise that resolves with the first QR URL.
   */
  async createSession(oxyUserId: string): Promise<{ sessionId: string; qrPromise: Promise<string> }> {
    const sessionId = uuidv4();

    // Create a new session document in MongoDB
    await TelegramSession.create({
      sessionId,
      oxyUserId,
      status: 'qr-pending',
      sessionString: null,
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

    // Auto-reject if no QR received within 60 seconds (Telegram QR takes longer)
    setTimeout(() => {
      const pending = this.pendingQRs.get(sessionId);
      if (pending) {
        pending.reject(new Error('QR code generation timed out'));
        this.pendingQRs.delete(sessionId);
      }
    }, 60000);

    // Start the session (which will emit the QR)
    await this.startSession(sessionId, true);

    return { sessionId, qrPromise };
  }

  /**
   * Start or reconnect an existing session using session string stored in MongoDB.
   */
  async startSession(sessionId: string, isNewSession: boolean = false): Promise<void> {
    const sessionData = await TelegramSession.findOne({ sessionId });
    if (!sessionData) {
      throw new Error(`No session record found for sessionId ${sessionId}`);
    }

    // Clean up any existing client for this session
    await this.cleanupSocket(sessionId);

    const stringSession = sessionData.sessionString
      ? new StringSession(sessionData.sessionString)
      : new StringSession('');

    const client = new TelegramClient(stringSession, this.apiId, this.apiHash, {
      connectionRetries: 5,
      deviceModel: 'Alia Gateway',
      systemVersion: 'Linux',
      appVersion: '1.0.0',
    });

    await client.connect();

    this.sessions.set(sessionId, client);

    if (isNewSession || !sessionData.sessionString) {
      // New session: initiate QR code login flow
      try {
        await client.signInUserWithQrCode(
          { apiId: this.apiId, apiHash: this.apiHash },
          {
            qrCode: async (token) => {
              const base64Token = Buffer.from(token.token).toString('base64url');
              const qrUrl = `tg://login?token=${base64Token}`;

              await TelegramSession.updateOne(
                { sessionId },
                { $set: { lastQR: qrUrl, status: 'qr-pending' } }
              );

              const pending = this.pendingQRs.get(sessionId);
              if (pending) {
                pending.resolve(qrUrl);
                this.pendingQRs.delete(sessionId);
              }

              logger.debug(`QR code generated for session ${sessionId}`);
            },
            onError: async (error) => {
              logger.error(`QR login error for ${sessionId}:`, error);
              const pending = this.pendingQRs.get(sessionId);
              if (pending) {
                pending.reject(error instanceof Error ? error : new Error(String(error)));
                this.pendingQRs.delete(sessionId);
              }
              return true; // retry
            },
          }
        );

        // If we reach here, login succeeded
        await this.onConnected(sessionId, client);
      } catch (err: unknown) {
        // If QR login fails fatally, mark as failed
        const isAlreadyRejected = !this.pendingQRs.has(sessionId);
        if (!isAlreadyRejected) {
          const pending = this.pendingQRs.get(sessionId);
          if (pending) {
            pending.reject(err instanceof Error ? err : new Error(String(err)));
            this.pendingQRs.delete(sessionId);
          }
        }

        await TelegramSession.updateOne(
          { sessionId },
          { $set: { status: 'failed' } }
        );
        this.sessions.delete(sessionId);
        logger.error(`QR login failed for session ${sessionId}:`, err);
        return;
      }
    } else {
      // Reconnecting with existing session string
      try {
        if (await client.isUserAuthorized()) {
          await this.onConnected(sessionId, client);
        } else {
          // Session expired
          await TelegramSession.updateOne(
            { sessionId },
            { $set: { status: 'logged-out', sessionString: null, lastQR: null } }
          );
          this.sessions.delete(sessionId);
          logger.warn(`Session ${sessionId} expired, marked as logged-out`);
          return;
        }
      } catch (err: unknown) {
        const errorMsg = errorMessage(err);
        if (
          errorMsg.includes('AUTH_KEY_UNREGISTERED') ||
          errorMsg.includes('SESSION_REVOKED')
        ) {
          // Session permanently invalidated
          await TelegramSession.updateOne(
            { sessionId },
            { $set: { status: 'logged-out', sessionString: null, lastQR: null } }
          );
          this.sessions.delete(sessionId);
          logger.warn(`Session ${sessionId} revoked, marked as logged-out`);
          return;
        }

        // Transient error: schedule reconnect
        this.sessions.delete(sessionId);
        this.scheduleReconnect(sessionId);
      }
    }
  }

  /**
   * Called when a session successfully connects/authenticates.
   * Saves session string and user info to MongoDB, then sets up event handlers.
   */
  private async onConnected(sessionId: string, client: TelegramClient): Promise<void> {
    this.reconnectAttempts.delete(sessionId);

    const me = await client.getMe() as Api.User;
    const phoneNumber = me.phone || '';
    const displayName = [me.firstName, me.lastName].filter(Boolean).join(' ');
    const sessionString = client.session.save() as unknown as string;

    await TelegramSession.updateOne(
      { sessionId },
      {
        $set: {
          status: 'connected',
          lastConnected: new Date(),
          phoneNumber,
          displayName,
          telegramUserId: me.id?.toString(),
          sessionString,
          lastQR: null,
        },
      }
    );

    logger.info(`Session connected for ${sessionId} (${displayName}, +${phoneNumber})`);

    this.setupEventHandlers(sessionId, client);
  }

  /**
   * Set up event handlers for incoming messages on this session.
   */
  private setupEventHandlers(sessionId: string, client: TelegramClient): void {
    client.addEventHandler(async (event) => {
      const message = event.message;
      if (!message || message.out) return; // Skip outgoing

      const text = message.text || message.message || '';
      if (!text) return;

      const chatId = message.chatId?.toString() || '';
      if (!chatId) return;

      // Deduplication
      const msgId = message.id?.toString();
      if (!msgId || dedup.check(`${sessionId}:${msgId}`)) return;

      // Determine sender name if available
      let senderName = '';
      try {
        const sender = await message.getSender();
        if (sender && 'firstName' in sender) {
          const lastName = 'lastName' in sender ? sender.lastName : undefined;
          senderName = [sender.firstName, lastName]
            .filter(Boolean)
            .join(' ');
        }
      } catch {
        // Best-effort sender name resolution
      }

      // Persist to MongoDB
      try {
        await TelegramMessage.updateOne(
          { sessionId, messageId: message.id.toString() },
          {
            $setOnInsert: {
              sessionId,
              chatId,
              messageId: message.id.toString(),
              fromMe: false,
              timestamp: message.date || Math.floor(Date.now() / 1000),
              text,
              senderName,
            },
          },
          { upsert: true }
        );
      } catch (err: unknown) {
        if (errorCode(err) !== 11000) {
          logger.error(`Error persisting message:`, err);
        }
      }

      // Update chat record
      try {
        // Determine chat type
        let chatType: 'user' | 'group' | 'channel' = 'user';
        try {
          const chat = await message.getChat();
          if (chat) {
            if (chat.className === 'Channel') {
              chatType = ('megagroup' in chat && chat.megagroup) ? 'group' : 'channel';
            } else if (chat.className === 'Chat') {
              chatType = 'group';
            }
          }
        } catch {
          // Best-effort chat type resolution
        }

        const chatName = senderName || chatId;
        await TelegramChat.updateOne(
          { sessionId, chatId },
          {
            $set: {
              name: chatName,
              lastMessageTimestamp: message.date || Math.floor(Date.now() / 1000),
              chatType,
            },
            $inc: { unreadCount: 1 },
            $setOnInsert: { sessionId, chatId },
          },
          { upsert: true }
        );
      } catch (err: unknown) {
        if (errorCode(err) !== 11000) {
          logger.error(`Error updating chat:`, err);
        }
      }

      // Forward to shared AI handler
      try {
        const sessionDoc = await TelegramSession.findOne({ sessionId }).lean();
        if (!sessionDoc || !sessionDoc.oxyUserId) {
          logger.error(`No session or oxyUserId found for ${sessionId}`);
          return;
        }

        await handleIncomingMessage({
          platform: 'telegram-gateway',
          sessionId,
          oxyUserId: sessionDoc.oxyUserId,
          chatId: String(chatId),
          messageText: text,
          senderName,
          sendResponse: (text) => client.sendMessage(chatId, { message: text }).then(() => {}),
          setTyping: async (typing) => {
            try {
              await client.invoke(
                new Api.messages.SetTyping({
                  peer: chatId,
                  action: typing
                    ? new Api.SendMessageTypingAction()
                    : new Api.SendMessageCancelAction(),
                })
              );
            } catch {
              // Typing indicators are best-effort
            }
          },
          charLimit: 4096,
          platformContext: 'Accessible via Telegram. Keep responses under 4000 characters when possible.',
        }, apiClient);
      } catch (err) {
        logger.error(`Error handling message for ${sessionId}:`, err);
      }
    }, new NewMessage({}));

    // Handle disconnection events
    client.addEventHandler(async () => {
      // Client disconnected — attempt reconnect
      if (!this.sessions.has(sessionId)) return; // Already cleaned up

      logger.info(`Client disconnected for session ${sessionId}`);
      this.sessions.delete(sessionId);

      await TelegramSession.updateOne(
        { sessionId },
        { $set: { status: 'disconnected', lastDisconnected: new Date() } }
      );

      this.scheduleReconnect(sessionId);
    });
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(sessionId: string): void {
    const attempts = (this.reconnectAttempts.get(sessionId) || 0) + 1;
    this.reconnectAttempts.set(sessionId, attempts);

    if (attempts > SessionManager.MAX_RECONNECT_ATTEMPTS) {
      TelegramSession.updateOne(
        { sessionId },
        { $set: { status: 'failed', lastDisconnected: new Date() } }
      ).catch((err) => logger.error(`Failed to update session status:`, err));

      this.reconnectAttempts.delete(sessionId);
      logger.error(
        `Session ${sessionId} failed after ${SessionManager.MAX_RECONNECT_ATTEMPTS} reconnect attempts`
      );
      return;
    }

    const delay =
      Math.min(
        SessionManager.BASE_RECONNECT_MS * Math.pow(2, attempts - 1),
        SessionManager.MAX_RECONNECT_MS
      ) + Math.floor(Math.random() * SessionManager.JITTER_MAX_MS);

    logger.info(
      `Session ${sessionId} reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts}/${SessionManager.MAX_RECONNECT_ATTEMPTS})...`
    );

    // Clear any existing reconnect timer
    const existing = this.reconnectTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(sessionId);
      this.startSession(sessionId).catch((err) =>
        logger.error(`Reconnect failed for ${sessionId}:`, err)
      );
    }, delay);
    this.reconnectTimers.set(sessionId, timer);
  }

  /**
   * Disconnect and log out a session (removes session string).
   */
  async disconnectSession(sessionId: string): Promise<void> {
    const client = this.sessions.get(sessionId);
    if (client) {
      try {
        await client.disconnect();
      } catch (err) {
        logger.error(`Disconnect error for ${sessionId}:`, err);
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

    await TelegramSession.updateOne(
      { sessionId },
      {
        $set: {
          status: 'logged-out',
          sessionString: null,
          lastQR: null,
        },
      }
    );
  }

  /**
   * Get session status from MongoDB by sessionId.
   */
  async getStatus(sessionId: string) {
    return TelegramSession.findOne({ sessionId }).lean();
  }

  /**
   * Get all sessions for a given oxyUserId.
   */
  async getUserSessions(oxyUserId: string) {
    return TelegramSession.find({ oxyUserId })
      .select('sessionId oxyUserId telegramUserId phoneNumber displayName status lastConnected lastDisconnected createdAt')
      .lean();
  }

  /**
   * Get the active TelegramClient for a session.
   */
  getSocket(sessionId: string): TelegramClient | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all sessions from MongoDB.
   */
  async listSessions() {
    return TelegramSession.find()
      .select('sessionId oxyUserId telegramUserId phoneNumber displayName status lastConnected lastDisconnected createdAt')
      .lean();
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

    // Disconnect all clients
    for (const [sessionId, client] of this.sessions) {
      try {
        await client.disconnect();
      } catch (err) {
        logger.error(`Error disconnecting session ${sessionId}:`, err);
      }
    }
    this.sessions.clear();

    logger.info('All sessions shut down');
  }

  /**
   * Internal: clean up client and timers for a session before creating a new one.
   */
  private async cleanupSocket(sessionId: string): Promise<void> {
    const existingClient = this.sessions.get(sessionId);
    if (existingClient) {
      try {
        await existingClient.disconnect();
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
