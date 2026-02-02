/**
 * Voice Session Manager
 *
 * Manages the lifecycle of real-time voice sessions:
 * - Connection and authentication
 * - Session state tracking
 * - Billing timer (per-minute)
 * - Cleanup and graceful shutdown
 * - Inactivity monitoring
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import type {
  VoiceSession,
  VoiceSessionConfig,
  VoiceProvider,
} from './types-voice.js';
import { resolveAliaModel } from './model-resolver.js';
import {
  reserveVoiceCredits,
  finalizeVoiceCredits,
  refundReservation,
} from '../../../lib/credits-manager.js';
import { providers } from './providers/index.js';

// ============== CONSTANTS ==============

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SESSIONS_PER_USER = 5;
const BILLING_INTERVAL_MS = 60 * 1000; // 1 minute

// ============== VOICE SESSION MANAGER ==============

export class VoiceSessionManager {
  private sessions: Map<string, VoiceSession> = new Map();
  private userSessionCounts: Map<string, number> = new Map();
  private inactivityMonitor: NodeJS.Timeout | null = null;

  constructor() {
    this.startInactivityMonitor();

    // Graceful shutdown handler
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  /**
   * Create a new voice session
   */
  async createSession(
    userId: string,
    clientSocket: WebSocket,
    model: string,
    config: VoiceSessionConfig
  ): Promise<VoiceSession> {
    try {
      // Check concurrent session limit
      const userSessions = this.userSessionCounts.get(userId) || 0;
      if (userSessions >= MAX_SESSIONS_PER_USER) {
        throw new Error(`Maximum concurrent sessions (${MAX_SESSIONS_PER_USER}) reached`);
      }

      const sessionId = randomUUID();
      console.log(`[VoiceSessionManager] Creating session ${sessionId} for user ${userId}, model: ${model}`);

      // Resolve Alia model to provider model
      const resolved = await resolveAliaModel(model, 1000);
      if (!resolved) {
        throw new Error(`Unable to resolve model: ${model}`);
      }

      const { provider, modelId, keyConfig, aliaModel } = resolved;

      console.log(`[VoiceSessionManager] Resolved ${model} → ${provider}/${modelId}`);

      // Get voice provider
      const providerImpl = providers[provider] as VoiceProvider;
      if (!providerImpl || !providerImpl.voice) {
        throw new Error(`Provider ${provider} does not support voice`);
      }

      // Get cost per minute from model mappings
      const { getModelMappingsForTier } = await import('./alia-models.js');
      const mappings = getModelMappingsForTier(aliaModel.tier);
      const mapping = mappings.find(m => m.provider === provider && m.modelId === modelId);
      const costPerMinute = mapping?.costPerMinute || 0.05;

      // Reserve credits (1 minute initially)
      const creditReservation = await reserveVoiceCredits(userId, 1, model, costPerMinute);
      if (!creditReservation) {
        throw new Error('Insufficient credits');
      }

      console.log(`[VoiceSessionManager] Reserved credits for session ${sessionId}`);

      // Create session object
      const session: VoiceSession = {
        sessionId,
        clientSocket,
        providerSocket: null,
        state: 'connecting',
        startTime: new Date(),
        userId,
        aliaModelId: model,
        provider,
        providerModelId: modelId,
        creditReservation,
        lastActivityTime: new Date(),
        billingTimer: null,
        minutesElapsed: 0,
        costPerMinute,
        audioFormat: config.audioFormat || 'pcm16',
        sampleRate: config.sampleRate || 24000,
        config,
      };

      // Store session
      this.sessions.set(sessionId, session);
      this.userSessionCounts.set(userId, userSessions + 1);

      // Connect to provider
      try {
        const providerSocket = await providerImpl.voice.connect(keyConfig, {
          ...config,
          model: modelId,
        });

        session.providerSocket = providerSocket;
        session.state = 'active';

        console.log(`[VoiceSessionManager] Connected to provider for session ${sessionId}`);

        // Setup provider event handlers
        this.setupProviderHandlers(session, providerImpl);

        // Start billing timer
        this.startBillingTimer(session);

        // Save initial usage record
        await this.saveUsageRecord(session, false);

      } catch (error) {
        console.error(`[VoiceSessionManager] Failed to connect to provider:`, error);
        await this.closeSession(sessionId, 'provider_connection_failed');
        throw error;
      }

      return session;

    } catch (error) {
      console.error(`[VoiceSessionManager] Error creating session:`, error);
      throw error;
    }
  }

  /**
   * Get an active session by ID
   */
  getSession(sessionId: string): VoiceSession | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Close a voice session
   */
  async closeSession(sessionId: string, reason?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.state === 'disconnecting' || session.state === 'closed') {
      return; // Already closing
    }

    session.state = 'disconnecting';

    console.log(`[VoiceSessionManager] Closing session ${sessionId}, reason: ${reason || 'normal'}`);

    try {
      // Stop billing timer
      if (session.billingTimer) {
        clearInterval(session.billingTimer);
        session.billingTimer = null;
      }

      // Calculate actual duration
      const endTime = new Date();
      const durationMs = endTime.getTime() - session.startTime.getTime();
      const actualMinutes = Math.max(durationMs / 60000, 0.01); // Minimum 0.01 minutes

      // Finalize credits
      if (session.creditReservation) {
        try {
          await finalizeVoiceCredits(
            session.creditReservation,
            actualMinutes,
            session.aliaModelId,
            session.costPerMinute
          );
          console.log(`[VoiceSessionManager] Finalized credits for session ${sessionId}: ${actualMinutes.toFixed(2)} minutes`);
        } catch (error) {
          console.error(`[VoiceSessionManager] Error finalizing credits:`, error);
        }
      }

      // Save final usage record
      await this.saveUsageRecord(session, true, reason);

      // Close provider socket
      if (session.providerSocket && session.providerSocket.readyState === WebSocket.OPEN) {
        session.providerSocket.close(1000, reason || 'Session ended');
      }

      // Close client socket if still open
      if (session.clientSocket.readyState === WebSocket.OPEN) {
        session.clientSocket.close(1000, reason || 'Session ended');
      }

    } catch (error) {
      console.error(`[VoiceSessionManager] Error during session cleanup:`, error);
    } finally {
      // Mark as closed and remove from tracking
      session.state = 'closed';
      this.sessions.delete(sessionId);

      // Update user session count
      const userSessions = this.userSessionCounts.get(session.userId) || 1;
      this.userSessionCounts.set(session.userId, Math.max(0, userSessions - 1));

      console.log(`[VoiceSessionManager] Session ${sessionId} closed successfully`);
    }
  }

  /**
   * Handle client message
   */
  handleClientMessage(sessionId: string, message: Buffer | string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.providerSocket || session.state !== 'active') {
      return;
    }

    try {
      // Update activity timestamp
      session.lastActivityTime = new Date();

      // Parse message
      const data = typeof message === 'string' ? message : message.toString('utf-8');
      let event: any;

      try {
        event = JSON.parse(data);
      } catch {
        console.warn(`[VoiceSessionManager] Invalid JSON from client:`, data.substring(0, 100));
        return;
      }

      // Get provider
      const providerImpl = providers[session.provider] as VoiceProvider;

      // Translate event if needed
      const translatedEvent = providerImpl.voice.translateClientEvent
        ? providerImpl.voice.translateClientEvent(event)
        : event;

      // Forward to provider
      if (session.providerSocket.readyState === WebSocket.OPEN) {
        session.providerSocket.send(JSON.stringify(translatedEvent));
      }

    } catch (error) {
      console.error(`[VoiceSessionManager] Error handling client message:`, error);
    }
  }

  /**
   * Setup provider WebSocket event handlers
   */
  private setupProviderHandlers(session: VoiceSession, providerImpl: VoiceProvider): void {
    if (!session.providerSocket) return;

    // Message from provider
    session.providerSocket.on('message', (data: Buffer) => {
      if (session.clientSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      try {
        const message = data.toString('utf-8');
        let event: any;

        try {
          event = JSON.parse(message);
        } catch {
          console.warn(`[VoiceSessionManager] Invalid JSON from provider`);
          return;
        }

        // Translate event if needed
        const translatedEvent = providerImpl.voice.translateProviderEvent
          ? providerImpl.voice.translateProviderEvent(event)
          : event;

        // Forward to client
        session.clientSocket.send(JSON.stringify(translatedEvent));

        // Update activity
        session.lastActivityTime = new Date();

      } catch (error) {
        console.error(`[VoiceSessionManager] Error handling provider message:`, error);
      }
    });

    // Provider error
    session.providerSocket.on('error', (error) => {
      console.error(`[VoiceSessionManager] Provider socket error:`, error);
      this.closeSession(session.sessionId, 'provider_error');
    });

    // Provider close
    session.providerSocket.on('close', (code, reason) => {
      console.log(`[VoiceSessionManager] Provider socket closed: ${code} ${reason}`);
      this.closeSession(session.sessionId, 'provider_closed');
    });
  }

  /**
   * Start billing timer for a session
   */
  private startBillingTimer(session: VoiceSession): void {
    // Clear existing timer if any
    if (session.billingTimer) {
      clearInterval(session.billingTimer);
    }

    // Create billing interval (every minute)
    session.billingTimer = setInterval(() => {
      session.minutesElapsed++;
      console.log(`[VoiceSessionManager] Session ${session.sessionId} - ${session.minutesElapsed} minutes elapsed`);

      // Check max duration
      const maxDuration = session.config.maxDuration || 30;
      if (session.minutesElapsed >= maxDuration) {
        console.log(`[VoiceSessionManager] Session ${session.sessionId} reached max duration`);
        this.closeSession(session.sessionId, 'max_duration_exceeded');
      }
    }, BILLING_INTERVAL_MS);
  }

  /**
   * Start inactivity monitor
   */
  private startInactivityMonitor(): void {
    this.inactivityMonitor = setInterval(() => {
      const now = new Date();

      for (const [sessionId, session] of this.sessions.entries()) {
        const inactiveMs = now.getTime() - session.lastActivityTime.getTime();

        if (inactiveMs > INACTIVITY_TIMEOUT_MS) {
          console.log(`[VoiceSessionManager] Session ${sessionId} inactive for ${inactiveMs}ms, closing`);
          this.closeSession(sessionId, 'inactivity_timeout');
        }
      }
    }, 60000); // Check every minute
  }

  /**
   * Save usage record to MongoDB
   */
  private async saveUsageRecord(session: VoiceSession, isFinal: boolean, disconnectReason?: string): Promise<void> {
    try {
      // Import model dynamically to avoid circular dependencies
      const { VoiceCallUsage } = await import('../../../models/voice-call-usage.js');

      const endTime = isFinal ? new Date() : undefined;
      const durationMinutes = isFinal
        ? (endTime!.getTime() - session.startTime.getTime()) / 60000
        : 0;

      const creditsCharged = isFinal && session.creditReservation
        ? session.creditReservation.creditsReserved
        : 0;

      const record = {
        sessionId: session.sessionId,
        oxyUserId: session.userId,
        aliaModelId: session.aliaModelId,
        provider: session.provider,
        providerModel: session.providerModelId,
        startTime: session.startTime,
        endTime,
        durationMinutes,
        creditsCharged,
        costPerMinute: session.costPerMinute,
        disconnectReason,
        audioFormat: session.audioFormat,
        sampleRate: session.sampleRate,
      };

      if (isFinal) {
        // Update existing record
        await VoiceCallUsage.findOneAndUpdate(
          { sessionId: session.sessionId },
          record,
          { upsert: true }
        );
      } else {
        // Create new record
        await VoiceCallUsage.create(record);
      }

    } catch (error) {
      console.error(`[VoiceSessionManager] Error saving usage record:`, error);
    }
  }

  /**
   * Graceful shutdown
   */
  private async shutdown(): Promise<void> {
    console.log('[VoiceSessionManager] Shutting down gracefully...');

    // Stop inactivity monitor
    if (this.inactivityMonitor) {
      clearInterval(this.inactivityMonitor);
      this.inactivityMonitor = null;
    }

    // Close all sessions
    const closePromises = Array.from(this.sessions.keys()).map((sessionId) =>
      this.closeSession(sessionId, 'server_shutdown')
    );

    await Promise.all(closePromises);

    console.log('[VoiceSessionManager] Shutdown complete');
  }

  /**
   * Get active sessions count
   */
  getActiveSessionsCount(): number {
    return this.sessions.size;
  }

  /**
   * Get active sessions for a user
   */
  getUserSessionsCount(userId: string): number {
    return this.userSessionCounts.get(userId) || 0;
  }
}

// Export singleton instance
export const voiceSessionManager = new VoiceSessionManager();
