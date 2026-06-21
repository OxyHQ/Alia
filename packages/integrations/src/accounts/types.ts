import type { Router } from 'express';

/**
 * Interface for account adapters (WhatsApp, Telegram, Signal, Gmail).
 * Account adapters manage personal user accounts — Alia monitors and responds passively.
 */
export interface AccountAdapter {
  /** Platform identifier (e.g., 'whatsapp', 'telegram-gateway', 'signal') */
  name: string;

  /** Initialize the adapter (restore sessions, etc.) */
  initialize(): Promise<void>;

  /** Graceful shutdown (disconnect all sessions) */
  shutdown(): Promise<void>;

  /** Express router for REST endpoints (connect, QR, status, chats, send, etc.) */
  getRouter(): Router;
}

/**
 * Session state for account adapters.
 */
export interface AccountSession {
  sessionId: string;
  oxyUserId: string;
  status: 'connecting' | 'qr-pending' | 'connected' | 'disconnected' | 'logged-out';
  phoneNumber?: string;
  displayName?: string;
  lastQR?: string;
  lastConnected?: Date;
  lastDisconnected?: Date;
}
