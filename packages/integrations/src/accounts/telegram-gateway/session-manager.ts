import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import { Api } from 'telegram/tl';
import { randomUUID } from 'node:crypto';
import { getDb } from '../../db';
import {
  createTelegramSession,
  findRestorableTelegramSessions,
  findTelegramSession,
  findTelegramSessionCredential,
  findTelegramSessionOwner,
  findTelegramSessionQr,
  insertTelegramMessages,
  listTelegramSessions,
  listTelegramSessionsForUser,
  markTelegramConnected,
  markTelegramDisconnected,
  markTelegramLoggedOut,
  markTelegramLoginFailed,
  markTelegramQrPending,
  markTelegramReconnectExhausted,
  upsertTelegramChat,
} from './repository';
import { handleIncomingMessage } from '../../shared/chat-handler';
import { APIClient } from '../../shared/api-client';
import { DedupSet, errorMessage } from '../../shared/utils';
import { createLogger } from '../../shared/logger';
import { PendingQrs } from '../pending-qr';

const apiClient = new APIClient('telegram-gateway', process.env.INTEGRATIONS_SECRET || '');
const dedup = new DedupSet();
const logger = createLogger('Telegram');

class SessionManager {
  private sessions: Map<string, TelegramClient> = new Map();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private pendingQrs = new PendingQrs();

  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly BASE_RECONNECT_MS = 5000;
  private static readonly MAX_RECONNECT_MS = 60000;
  private static readonly JITTER_MAX_MS = 1000;
  /** Telegram's first QR takes longer than WhatsApp's. */
  private static readonly QR_TIMEOUT_MS = 60000;

  private get apiId(): number {
    return parseInt(process.env.TELEGRAM_API_ID || '0', 10);
  }

  private get apiHash(): string {
    return process.env.TELEGRAM_API_HASH || '';
  }

  /**
   * On startup, load all 'connected' or 'disconnected' sessions and attempt to
   * reconnect them.
   */
  async initialize(): Promise<void> {
    const activeSessions = await findRestorableTelegramSessions(getDb());
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
  async createSession(
    oxyUserId: string,
  ): Promise<{ sessionId: string; qrPromise: Promise<string> }> {
    const sessionId = randomUUID();

    await createTelegramSession(getDb(), { sessionId, oxyUserId });

    // A fresh id has no client, timer or wait to reset, so this goes straight to
    // `openClient` rather than through `startSession`, whose reset would reject
    // the wait armed here before the caller could await it.
    const qrPromise = this.pendingQrs.arm(sessionId, SessionManager.QR_TIMEOUT_MS);
    try {
      await this.openClient(sessionId, null);
    } catch (err) {
      // The caller gets this error instead of the promise, so nobody awaits the wait.
      this.pendingQrs.discard(sessionId);
      throw err;
    }

    return { sessionId, qrPromise };
  }

  /**
   * Start or reconnect an existing session using the stored session string.
   */
  async startSession(sessionId: string): Promise<void> {
    const sessionData = await findTelegramSessionCredential(getDb(), sessionId);
    if (!sessionData) {
      throw new Error(`No session record found for sessionId ${sessionId}`);
    }

    // Clean up any existing client for this session
    await this.cleanupSocket(sessionId);

    await this.openClient(sessionId, sessionData.sessionString || null);
  }

  /**
   * Connect a client for a session that has nothing left to clean up. Without a
   * session string it starts the QR login and returns once the client is
   * connected — the login itself finishes in the background.
   */
  private async openClient(sessionId: string, sessionString: string | null): Promise<void> {
    const client = new TelegramClient(
      new StringSession(sessionString ?? ''),
      this.apiId,
      this.apiHash,
      {
        connectionRetries: 5,
        deviceModel: 'Alia Gateway',
        systemVersion: 'Linux',
        appVersion: '1.0.0',
      },
    );

    await client.connect();

    this.sessions.set(sessionId, client);

    if (!sessionString) {
      // GramJS's QR login settles only once the user has scanned the code (or
      // the login fails), and the caller needs the code before that, so it must
      // not be awaited here. `loginWithQr` never rejects.
      void this.loginWithQr(sessionId, client);
      return;
    }

    // Reconnecting with existing session string
    try {
      if (await client.isUserAuthorized()) {
        await this.onConnected(sessionId, client);
      } else {
        // Session expired
        await markTelegramLoggedOut(getDb(), sessionId);
        this.sessions.delete(sessionId);
        logger.warn(`Session ${sessionId} expired, marked as logged-out`);
        return;
      }
    } catch (err: unknown) {
      const errorMsg = errorMessage(err);
      if (errorMsg.includes('AUTH_KEY_UNREGISTERED') || errorMsg.includes('SESSION_REVOKED')) {
        // Session permanently invalidated
        await markTelegramLoggedOut(getDb(), sessionId);
        this.sessions.delete(sessionId);
        logger.warn(`Session ${sessionId} revoked, marked as logged-out`);
        return;
      }

      // Transient error: schedule reconnect
      this.sessions.delete(sessionId);
      this.scheduleReconnect(sessionId);
    }
  }

  /**
   * The QR login of a session with no session string: hands each QR to the
   * pending wait and the database, then records the outcome. Never rejects —
   * it runs detached from the request that started it.
   */
  private async loginWithQr(sessionId: string, client: TelegramClient): Promise<void> {
    try {
      await client.signInUserWithQrCode(
        { apiId: this.apiId, apiHash: this.apiHash },
        {
          qrCode: async (token) => {
            const base64Token = Buffer.from(token.token).toString('base64url');
            const qrUrl = `tg://login?token=${base64Token}`;

            await markTelegramQrPending(getDb(), sessionId, qrUrl);
            this.pendingQrs.resolve(sessionId, qrUrl);

            logger.debug(`QR code generated for session ${sessionId}`);
          },
          onError: async (error) => {
            logger.error(`QR login error for ${sessionId}:`, error);
            this.pendingQrs.reject(
              sessionId,
              error instanceof Error ? error : new Error(String(error)),
            );
            return true; // retry
          },
        },
      );

      // If we reach here, login succeeded
      await this.onConnected(sessionId, client);
    } catch (err: unknown) {
      // A login that fails before the first QR fails the wait with its reason.
      this.pendingQrs.reject(sessionId, err instanceof Error ? err : new Error(String(err)));

      if (this.sessions.get(sessionId) !== client) {
        // Disconnected, reset or shut down while waiting for the scan: whoever
        // replaced this client owns the session's state now.
        logger.info(`QR login for session ${sessionId} ended after its client was replaced`);
        return;
      }
      this.sessions.delete(sessionId);
      logger.error(`QR login failed for session ${sessionId}:`, err);
      try {
        await markTelegramLoginFailed(getDb(), sessionId);
      } catch (dbErr) {
        logger.error(`Failed to record the failed QR login for session ${sessionId}:`, dbErr);
      }
    }
  }

  /**
   * Called when a session successfully connects/authenticates.
   * Saves the session string and user info, then sets up event handlers.
   */
  private async onConnected(sessionId: string, client: TelegramClient): Promise<void> {
    this.reconnectAttempts.delete(sessionId);

    const me = (await client.getMe()) as Api.User;
    const phoneNumber = me.phone || '';
    const displayName = [me.firstName, me.lastName].filter(Boolean).join(' ');
    const sessionString = client.session.save() as unknown as string;

    await markTelegramConnected(getDb(), sessionId, {
      phoneNumber,
      displayName,
      telegramUserId: me.id?.toString(),
      sessionString,
    });

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
          senderName = [sender.firstName, lastName].filter(Boolean).join(' ');
        }
      } catch {
        // Best-effort sender name resolution
      }

      // Persist the message
      try {
        await insertTelegramMessages(getDb(), [
          {
            sessionId,
            chatId,
            messageId: message.id.toString(),
            fromMe: false,
            timestamp: message.date || Math.floor(Date.now() / 1000),
            text,
            senderName,
          },
        ]);
      } catch (err: unknown) {
        logger.error(`Error persisting message:`, err);
      }

      // Update chat record
      try {
        // Determine chat type
        let chatType: 'user' | 'group' | 'channel' = 'user';
        try {
          const chat = await message.getChat();
          if (chat) {
            if (chat.className === 'Channel') {
              chatType = 'megagroup' in chat && chat.megagroup ? 'group' : 'channel';
            } else if (chat.className === 'Chat') {
              chatType = 'group';
            }
          }
        } catch {
          // Best-effort chat type resolution
        }

        const chatName = senderName || chatId;
        await upsertTelegramChat(getDb(), {
          sessionId,
          chatId,
          name: chatName,
          lastMessageTimestamp: message.date || Math.floor(Date.now() / 1000),
          chatType,
        });
      } catch (err: unknown) {
        logger.error(`Error updating chat:`, err);
      }

      // Forward to shared AI handler
      try {
        const oxyUserId = await findTelegramSessionOwner(getDb(), sessionId);
        if (!oxyUserId) {
          logger.error(`No session or oxyUserId found for ${sessionId}`);
          return;
        }

        await handleIncomingMessage(
          {
            platform: 'telegram-gateway',
            sessionId,
            oxyUserId,
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
                  }),
                );
              } catch {
                // Typing indicators are best-effort
              }
            },
            charLimit: 4096,
            platformContext:
              'Accessible via Telegram. Keep responses under 4000 characters when possible.',
          },
          apiClient,
        );
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

      await markTelegramDisconnected(getDb(), sessionId);

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
      markTelegramReconnectExhausted(getDb(), sessionId).catch((err) =>
        logger.error(`Failed to update session status:`, err),
      );

      this.reconnectAttempts.delete(sessionId);
      logger.error(
        `Session ${sessionId} failed after ${SessionManager.MAX_RECONNECT_ATTEMPTS} reconnect attempts`,
      );
      return;
    }

    const delay =
      Math.min(
        SessionManager.BASE_RECONNECT_MS * Math.pow(2, attempts - 1),
        SessionManager.MAX_RECONNECT_MS,
      ) + Math.floor(Math.random() * SessionManager.JITTER_MAX_MS);

    logger.info(
      `Session ${sessionId} reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts}/${SessionManager.MAX_RECONNECT_ATTEMPTS})...`,
    );

    // Clear any existing reconnect timer
    const existing = this.reconnectTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(sessionId);
      this.startSession(sessionId).catch((err) =>
        logger.error(`Reconnect failed for ${sessionId}:`, err),
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

    await markTelegramLoggedOut(getDb(), sessionId);
  }

  /**
   * Session status by sessionId, without the GramJS session string.
   */
  async getStatus(sessionId: string) {
    return findTelegramSession(getDb(), sessionId);
  }

  /**
   * The login QR for a session that is awaiting a scan.
   */
  async getQr(sessionId: string) {
    return findTelegramSessionQr(getDb(), sessionId);
  }

  /**
   * Get all sessions for a given oxyUserId.
   */
  async getUserSessions(oxyUserId: string) {
    return listTelegramSessionsForUser(getDb(), oxyUserId);
  }

  /**
   * Get the active TelegramClient for a session.
   */
  getSocket(sessionId: string): TelegramClient | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all sessions.
   */
  async listSessions() {
    return listTelegramSessions(getDb());
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

    this.pendingQrs.reject(sessionId, new Error('Session was reset'));

    const timer = this.reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(sessionId);
    }

    this.reconnectAttempts.delete(sessionId);
  }
}

export const sessionManager = new SessionManager();
