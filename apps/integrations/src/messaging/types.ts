import type { Router } from 'express';

/**
 * Common interface for all messaging platform adapters.
 * Each adapter manages its own connections, message handling, and lifecycle.
 */
export interface MessagingAdapter {
  /** Platform identifier (e.g., 'whatsapp', 'telegram-gateway', 'signal') */
  name: string;

  /** Initialize the adapter (connect to platforms, restore sessions, etc.) */
  initialize(): Promise<void>;

  /** Graceful shutdown (disconnect all sessions, stop polling, etc.) */
  shutdown(): Promise<void>;

  /** Optional Express router for gateway REST endpoints (QR, status, chats, etc.) */
  getRouter?(): Router;
}

/**
 * Shared session interface for gateway adapters (WhatsApp, Telegram, Signal).
 * Bot adapters (Telegram Bot, Discord) don't use sessions.
 */
export interface GatewaySession {
  sessionId: string;
  oxyUserId: string;
  status: 'connecting' | 'qr-pending' | 'connected' | 'disconnected' | 'logged-out';
  phoneNumber?: string;
  displayName?: string;
  lastQR?: string;
  lastConnected?: Date;
  lastDisconnected?: Date;
}
