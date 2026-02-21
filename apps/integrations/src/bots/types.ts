/**
 * Interface for bot adapters (Telegram Bot, Discord Bot).
 * Bot adapters run system-level bots that allow external users to interact with Alia,
 * and enable Alia to send messages proactively on the user's behalf.
 */
export interface BotAdapter {
  /** Platform identifier (e.g., 'telegram-bot', 'discord-bot') */
  name: string;

  /** Initialize the adapter (connect to platform, start polling/websocket) */
  initialize(): Promise<void>;

  /** Graceful shutdown (stop polling, disconnect) */
  shutdown(): Promise<void>;
}
