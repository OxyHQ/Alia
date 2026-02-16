/**
 * Voice Session Manager (LiveKit)
 *
 * Manages the lifecycle of real-time voice sessions using LiveKit rooms:
 * - Creates LiveKit rooms and joins as agent participant(s)
 * - Bridges audio between LiveKit tracks and provider WebSockets (OpenAI/Grok)
 * - Handles cohost mode (second AI agent in the same room)
 * - Per-minute billing with credit reservations
 * - Inactivity timeouts (10s normal, 30s cohost)
 * - Server-side tool execution for function calling
 * - Graceful shutdown
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import type {
  VoiceSession,
  VoiceSessionConfig,
  VoiceProvider,
  CohostState,
  AgentDataMessage,
  ClientDataMessage,
} from './types-voice.js';
import { DEFAULT_COHOST_CONFIG } from './types-voice.js';
import { resolveAliaModel } from './model-resolver.js';
import {
  reserveVoiceCredits,
  finalizeVoiceCredits,
} from '../../../lib/credits-manager.js';
import { providers } from './providers/index.js';
import { log } from '../../../lib/logger.js';
import { LiveKitAgentBridge } from '../../../lib/livekit-agent.js';
import {
  createAgentToken,
  createVoiceRoom,
  deleteVoiceRoom,
  getLiveKitUrl,
} from '../../../lib/livekit-token.js';

// ============== TOOL EXECUTORS ==============

function buildVoiceToolExecutors(userId: string): Map<string, (args: any) => Promise<any>> {
  const executors = new Map<string, (args: any) => Promise<any>>();

  executors.set('getCurrentDate', async () => {
    const now = new Date();
    return {
      date: now.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      time: now.toLocaleTimeString('es-ES'),
      timestamp: now.toISOString(),
    };
  });

  executors.set('sendTelegramMessage', async (args: { message: string }) => {
    const { createSendTelegramTool } = await import('../../../lib/tools/telegram.js');
    const toolInstance = createSendTelegramTool(userId);
    return await toolInstance.execute(args, {} as any);
  });

  executors.set('saveUserMemory', async (args: { key: string; value: string; category?: string }) => {
    const { saveUserMemoryTool } = await import('../../../lib/tools/user-memory.js');
    const toolInstance = saveUserMemoryTool(userId);
    return await toolInstance.execute(args, {} as any);
  });

  executors.set('updateUserPreferences', async (args: { language?: string; tone?: string; responseLength?: string }) => {
    const { updateUserPreferencesTool } = await import('../../../lib/tools/user-memory.js');
    const toolInstance = updateUserPreferencesTool(userId);
    return await toolInstance.execute(args as any, {} as any);
  });

  executors.set('updateUserContext', async (args: { occupation?: string; location?: string; timezone?: string }) => {
    const { updateUserContextTool } = await import('../../../lib/tools/user-memory.js');
    const toolInstance = updateUserContextTool(userId);
    return await toolInstance.execute(args, {} as any);
  });

  return executors;
}

// ============== CONSTANTS ==============

const MAX_SESSIONS_PER_USER = 5;
const BILLING_INTERVAL_MS = 60 * 1000;
const USER_SILENCE_TIMEOUT_MS = 10 * 1000;          // 10s in normal mode
const COHOST_INACTIVITY_TIMEOUT_MS = 30 * 1000;     // 30s in cohost mode
const COHOST_CHECKIN_WAIT_MS = 15 * 1000;            // 15s after asking "still there?"
const MAX_RECENT_TRANSCRIPTS = 5;

// ============== VOICE SESSION MANAGER ==============

export class VoiceSessionManager {
  private sessions: Map<string, VoiceSession> = new Map();
  private userSessionCounts: Map<string, number> = new Map();

  constructor() {
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  // ============== SESSION LIFECYCLE ==============

  /**
   * Create a new voice session with a LiveKit room.
   * Returns the session (including roomName) so the caller can generate a user token.
   */
  async createSession(
    userId: string,
    model: string,
    config: VoiceSessionConfig
  ): Promise<VoiceSession> {
    // Check concurrent session limit
    const userSessions = this.userSessionCounts.get(userId) || 0;
    if (userSessions >= MAX_SESSIONS_PER_USER) {
      throw new Error(`Maximum concurrent sessions (${MAX_SESSIONS_PER_USER}) reached`);
    }

    const sessionId = randomUUID();
    const roomName = `voice-${sessionId}`;
    log.providers.info({ sessionId, userId, model, roomName }, 'Creating voice session');

    // Resolve Alia model to provider model
    const resolved = await resolveAliaModel(model, 1000);
    if (!resolved) {
      throw new Error(`Unable to resolve model: ${model}`);
    }

    const { provider, modelId, keyConfig, aliaModel } = resolved;
    log.providers.info({ model, provider, modelId }, 'Resolved voice model');

    // Get voice provider implementation
    const providerImpl = providers[provider] as VoiceProvider;
    if (!providerImpl || !providerImpl.voice) {
      throw new Error(`Provider ${provider} does not support voice`);
    }

    // Get cost per minute
    const { getModelMappingsForTier } = await import('./alia-models.js');
    const mappings = getModelMappingsForTier(aliaModel.tier);
    const mapping = mappings.find(m => m.provider === provider && m.modelId === modelId);
    const costPerMinute = mapping?.costPerMinute || 0.05;

    // Reserve credits
    const creditReservation = await reserveVoiceCredits(userId, 1, model, costPerMinute);
    if (!creditReservation) {
      throw new Error('Insufficient credits');
    }

    // Create session object
    const session: VoiceSession = {
      sessionId,
      providerSocket: null,
      state: 'connecting',
      startTime: new Date(),
      userId,
      aliaModelId: model,
      provider,
      providerModelId: modelId,
      creditReservation,
      roomName,
      agentBridge: null,
      lastActivityTime: new Date(),
      lastUserSpeechTime: null,
      billingTimer: null,
      minutesElapsed: 0,
      costPerMinute,
      audioFormat: config.audioFormat || 'pcm16',
      sampleRate: config.sampleRate || 24000,
      config,
      toolExecutors: buildVoiceToolExecutors(userId),
      userSilenceTimer: null,
      // Cohost (disabled by default)
      cohostEnabled: false,
      cohostBridge: null,
      cohostProviderSocket: null,
      cohostProvider: null,
      cohostProviderModelId: null,
      cohostCreditReservation: null,
      cohostCostPerMinute: 0,
      cohostBillingTimer: null,
      cohostMinutesElapsed: 0,
      cohostState: null,
      cohostToolExecutors: undefined,
      cohostInactivityTimer: null,
      recentTranscripts: [],
    };

    // Store session
    this.sessions.set(sessionId, session);
    this.userSessionCounts.set(userId, userSessions + 1);

    try {
      const t0 = Date.now();

      // 1. Create LiveKit room (best-effort — rooms auto-create on first join)
      try {
        await createVoiceRoom(roomName);
        log.providers.info({ roomName, ms: Date.now() - t0 }, '[Voice] Step 1/4: Created LiveKit room');
      } catch (err) {
        log.providers.warn({ err, roomName, ms: Date.now() - t0 }, '[Voice] Step 1/4: Could not pre-create LiveKit room (will auto-create on join)');
      }

      // 2. Connect to AI provider via WebSocket
      const t1 = Date.now();
      const providerSocket = await providerImpl.voice.connect(keyConfig, {
        ...config,
        model: modelId,
      });
      session.providerSocket = providerSocket;
      log.providers.info({ sessionId, provider, ms: Date.now() - t1 }, '[Voice] Step 2/4: Connected to provider');

      // 3. Create agent bridge and join LiveKit room
      const t2 = Date.now();
      const agentBridge = new LiveKitAgentBridge('alia-agent');
      const agentToken = await createAgentToken(roomName, 'alia-agent');
      await agentBridge.join(getLiveKitUrl(), agentToken);
      session.agentBridge = agentBridge;
      log.providers.info({ sessionId, ms: Date.now() - t2 }, '[Voice] Step 3/4: Agent joined LiveKit room');

      // 4. Wire up audio bridge and event handlers
      agentBridge.onUserAudioFrame = (base64Pcm16) => {
        if (session.providerSocket?.readyState === WebSocket.OPEN) {
          session.providerSocket.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: base64Pcm16,
          }));
        }
      };

      agentBridge.onClientData = (data: ClientDataMessage) => {
        this.handleClientDataMessage(sessionId, data);
      };

      agentBridge.onUserDisconnected = () => {
        this.closeSession(sessionId, 'client_disconnected');
      };

      this.setupProviderHandlers(session, providerImpl, 'primary');

      // Start billing
      this.startBillingTimer(session);
      await this.saveUsageRecord(session, false);

      session.state = 'active';
      log.providers.info({ sessionId, totalMs: Date.now() - t0 }, '[Voice] Step 4/4: Session active');
      return session;

    } catch (error) {
      log.providers.error({ err: error, sessionId }, '[Voice] Failed to create voice session');
      await this.closeSession(sessionId, 'setup_failed');
      throw error;
    }
  }

  getSession(sessionId: string): VoiceSession | null {
    return this.sessions.get(sessionId) || null;
  }

  async closeSession(sessionId: string, reason?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.state === 'disconnecting' || session.state === 'closed') return;

    session.state = 'disconnecting';
    log.providers.info({ sessionId, reason }, 'Closing voice session');

    try {
      // Clear all timers
      if (session.billingTimer) { clearInterval(session.billingTimer); session.billingTimer = null; }
      if (session.userSilenceTimer) { clearTimeout(session.userSilenceTimer); session.userSilenceTimer = null; }
      if (session.cohostBillingTimer) { clearInterval(session.cohostBillingTimer); session.cohostBillingTimer = null; }
      if (session.cohostInactivityTimer) { clearTimeout(session.cohostInactivityTimer); session.cohostInactivityTimer = null; }

      // Notify client before disconnecting
      try {
        await session.agentBridge?.publishData({ type: 'session.ended', reason: reason || 'session_closed' } satisfies AgentDataMessage);
      } catch {}

      // Finalize primary credits
      const endTime = new Date();
      const actualMinutes = Math.max((endTime.getTime() - session.startTime.getTime()) / 60000, 0.01);
      if (session.creditReservation) {
        try {
          await finalizeVoiceCredits(session.creditReservation, actualMinutes, session.aliaModelId, session.costPerMinute);
        } catch (e) { log.providers.error({ err: e }, 'Error finalizing primary credits'); }
      }

      // Finalize cohost credits if active
      if (session.cohostCreditReservation) {
        try {
          await finalizeVoiceCredits(session.cohostCreditReservation, session.cohostMinutesElapsed || 0.01, session.aliaModelId, session.cohostCostPerMinute);
        } catch (e) { log.providers.error({ err: e }, 'Error finalizing cohost credits'); }
      }

      // Save final usage record
      await this.saveUsageRecord(session, true, reason);

      // Close provider sockets
      if (session.providerSocket?.readyState === WebSocket.OPEN) {
        session.providerSocket.close(1000, reason || 'Session ended');
      }
      if (session.cohostProviderSocket?.readyState === WebSocket.OPEN) {
        session.cohostProviderSocket.close(1000, 'Session ended');
      }

      // Disconnect LiveKit bridges
      await session.agentBridge?.disconnect().catch(() => {});
      await session.cohostBridge?.disconnect().catch(() => {});

      // Delete LiveKit room
      await deleteVoiceRoom(session.roomName);

    } catch (error) {
      log.providers.error({ err: error }, 'Error during session cleanup');
    } finally {
      session.state = 'closed';
      this.sessions.delete(sessionId);
      const count = this.userSessionCounts.get(session.userId) || 1;
      this.userSessionCounts.set(session.userId, Math.max(0, count - 1));
      log.providers.info({ sessionId }, 'Voice session closed');
    }
  }

  // ============== PROVIDER EVENT HANDLERS ==============

  /**
   * Setup handlers for events from a provider WebSocket (OpenAI/Grok).
   * Routes audio to the appropriate LiveKit agent bridge and sends
   * transcripts/state via data channel.
   */
  private setupProviderHandlers(
    session: VoiceSession,
    providerImpl: VoiceProvider,
    role: 'primary' | 'cohost'
  ): void {
    const providerSocket = role === 'primary' ? session.providerSocket : session.cohostProviderSocket;
    const bridge = role === 'primary' ? session.agentBridge : session.cohostBridge;
    if (!providerSocket || !bridge) return;

    let currentTranscript = '';

    providerSocket.on('message', async (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString('utf-8'));

        // Route audio to LiveKit
        if (event.type === 'response.audio.delta' && event.delta) {
          await (bridge as LiveKitAgentBridge).publishAudioFrame(event.delta);
        }

        // Transcript streaming → data channel
        if (event.type === 'response.audio_transcript.delta' && event.delta) {
          currentTranscript += event.delta;
          await bridge.publishData({
            type: 'transcript.delta', delta: event.delta, speaker: role,
          } satisfies AgentDataMessage);
        }

        // Transcript complete
        if (event.type === 'response.audio_transcript.done' && event.transcript) {
          currentTranscript = '';
          await bridge.publishData({
            type: 'transcript.done', transcript: event.transcript, speaker: role,
          } satisfies AgentDataMessage);
          // Store in recent transcripts for cohost context
          session.recentTranscripts.push({ speaker: role, text: event.transcript, timestamp: Date.now() });
          if (session.recentTranscripts.length > MAX_RECENT_TRANSCRIPTS) {
            session.recentTranscripts.shift();
          }
        }

        // User transcript (only from primary agent since cohost doesn't receive user audio)
        if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
          await bridge.publishData({
            type: 'transcript.user', transcript: event.transcript,
          } satisfies AgentDataMessage);
          session.recentTranscripts.push({ speaker: 'user', text: event.transcript, timestamp: Date.now() });
          if (session.recentTranscripts.length > MAX_RECENT_TRANSCRIPTS) {
            session.recentTranscripts.shift();
          }
        }

        // Agent state: speaking
        if (event.type === 'response.created') {
          await bridge.publishData({
            type: 'agent.state', state: 'thinking', speaker: role,
          } satisfies AgentDataMessage);
        }

        // User started speaking (VAD) — only on primary
        if (event.type === 'input_audio_buffer.speech_started' && role === 'primary') {
          session.lastUserSpeechTime = new Date();
          session.lastActivityTime = new Date();
          // Clear silence timer
          if (session.userSilenceTimer) {
            clearTimeout(session.userSilenceTimer);
            session.userSilenceTimer = null;
          }
          // Reset cohost inactivity timer
          if (session.cohostInactivityTimer) {
            clearTimeout(session.cohostInactivityTimer);
            session.cohostInactivityTimer = null;
          }
          await bridge.publishData({
            type: 'agent.state', state: 'listening', speaker: 'primary',
          } satisfies AgentDataMessage);
          // If cohost is active and an AI is speaking, interrupt for user
          if (session.cohostEnabled && session.cohostState) {
            this.handleUserInterruptDuringCohost(session);
          }
        }

        // User stopped speaking
        if (event.type === 'input_audio_buffer.speech_stopped' && role === 'primary') {
          await bridge.publishData({
            type: 'agent.state', state: 'thinking', speaker: 'primary',
          } satisfies AgentDataMessage);
        }

        // Response complete — handle turn orchestration + silence timer
        if (event.type === 'response.done') {
          session.lastActivityTime = new Date();

          // Check for function calls (server-side tool execution)
          const hasFunctionCalls = await this.handleFunctionCalls(session, event, role);

          if (!hasFunctionCalls) {
            await bridge.publishData({
              type: 'agent.state', state: 'listening', speaker: role,
            } satisfies AgentDataMessage);

            // Handle cohost turn orchestration
            if (session.cohostEnabled && session.cohostState) {
              this.handleCohostTurnComplete(session, role);
            } else {
              // Normal mode: start 10s silence timer
              this.startUserSilenceTimer(session);
            }

            // Start cohost inactivity timer if in cohost mode
            if (session.cohostEnabled && !session.cohostInactivityTimer) {
              this.startCohostInactivityTimer(session);
            }
          }
        }

      } catch (error) {
        log.providers.error({ err: error, role }, 'Error handling provider message');
      }
    });

    providerSocket.on('error', (error) => {
      log.providers.error({ err: error, role }, 'Provider socket error');
      if (role === 'primary') {
        this.closeSession(session.sessionId, 'provider_error');
      } else {
        this.disableCohost(session.sessionId, 'cohost_provider_error');
      }
    });

    providerSocket.on('close', (code, reason) => {
      log.providers.info({ sessionId: session.sessionId, code, reason: reason?.toString(), role }, 'Provider socket closed');
      if (role === 'primary') {
        this.closeSession(session.sessionId, 'provider_closed');
      } else {
        this.disableCohost(session.sessionId, 'cohost_provider_closed');
      }
    });
  }

  // ============== FUNCTION CALL HANDLING ==============

  private async handleFunctionCalls(
    session: VoiceSession,
    event: any,
    role: 'primary' | 'cohost'
  ): Promise<boolean> {
    if (!event.response?.output) return false;

    const functionCalls = event.response.output.filter((item: any) => item.type === 'function_call');
    if (functionCalls.length === 0) return false;

    const providerSocket = role === 'primary' ? session.providerSocket : session.cohostProviderSocket;
    const executors = role === 'primary' ? session.toolExecutors : session.cohostToolExecutors;
    if (!providerSocket || providerSocket.readyState !== WebSocket.OPEN) return false;

    for (const fc of functionCalls) {
      const executor = executors?.get(fc.name);
      let output: string;

      if (executor) {
        try {
          const args = JSON.parse(fc.arguments || '{}');
          log.providers.info({ toolName: fc.name, args, role }, 'Executing voice tool');
          const result = await executor(args);
          output = JSON.stringify(result);
        } catch (error: any) {
          log.providers.error({ err: error, toolName: fc.name, role }, 'Voice tool error');
          output = JSON.stringify({ error: error.message || 'Tool execution failed' });
        }
      } else {
        output = JSON.stringify({ error: `Unknown tool: ${fc.name}` });
      }

      providerSocket.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: fc.call_id, output },
      }));
    }

    // Trigger follow-up response
    providerSocket.send(JSON.stringify({ type: 'response.create' }));
    return true;
  }

  // ============== CLIENT DATA MESSAGES ==============

  private handleClientDataMessage(sessionId: string, message: ClientDataMessage): void {
    switch (message.type) {
      case 'cohost.enable':
        this.enableCohost(sessionId);
        break;
      case 'cohost.disable':
        this.disableCohost(sessionId, 'user_disabled');
        break;
      case 'cohost.continue':
        this.continueCohostRound(sessionId);
        break;
    }
  }

  // ============== COHOST MODE ==============

  async enableCohost(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'active' || session.cohostEnabled) return;

    log.providers.info({ sessionId }, 'Enabling cohost mode');

    try {
      // Resolve provider for cohost (same model as primary)
      const resolved = await resolveAliaModel(session.aliaModelId, 1000);
      if (!resolved) throw new Error('Cannot resolve model for cohost');

      const { provider, modelId, keyConfig } = resolved;
      const providerImpl = providers[provider] as VoiceProvider;
      if (!providerImpl?.voice) throw new Error(`Provider ${provider} does not support voice`);

      // Reserve credits for cohost
      const cohostReservation = await reserveVoiceCredits(
        session.userId, 1, session.aliaModelId, session.costPerMinute
      );
      if (!cohostReservation) {
        await session.agentBridge?.publishData({
          type: 'error', code: 'insufficient_credits', message: 'Not enough credits for cohost',
        } satisfies AgentDataMessage);
        return;
      }

      // Build cohost instructions
      const cohostInstructions = this.buildCohostInstructions(session);

      // Connect cohost to provider
      const cohostSocket = await providerImpl.voice.connect(keyConfig, {
        ...session.config,
        model: modelId,
        voice: DEFAULT_COHOST_CONFIG.voice,
        instructions: cohostInstructions,
      });

      // Disable VAD on cohost (it responds only when triggered)
      cohostSocket.on('open', () => {
        cohostSocket.send(JSON.stringify({
          type: 'session.update',
          session: { turn_detection: null },
        }));
      });

      session.cohostProviderSocket = cohostSocket;
      session.cohostProvider = provider;
      session.cohostProviderModelId = modelId;
      session.cohostCreditReservation = cohostReservation;
      session.cohostCostPerMinute = session.costPerMinute;
      session.cohostMinutesElapsed = 0;
      session.cohostToolExecutors = buildVoiceToolExecutors(session.userId);

      // Create cohost agent bridge and join room
      const cohostBridge = new LiveKitAgentBridge('alia-cohost');
      const cohostToken = await createAgentToken(session.roomName, 'alia-cohost');
      await cohostBridge.join(getLiveKitUrl(), cohostToken);
      session.cohostBridge = cohostBridge;

      // Cohost does NOT subscribe to user audio (no onUserAudioFrame callback)
      // Only the primary agent receives user audio

      // Setup cohost provider handlers
      this.setupProviderHandlers(session, providerImpl, 'cohost');

      // Start cohost billing timer
      session.cohostBillingTimer = setInterval(() => {
        session.cohostMinutesElapsed++;
      }, BILLING_INTERVAL_MS);

      // Initialize cohost state
      session.cohostState = {
        turnState: 'idle',
        turnsInCurrentRound: 0,
        lastTranscript: null,
        config: { ...DEFAULT_COHOST_CONFIG },
      };
      session.cohostEnabled = true;

      // Notify client
      await session.agentBridge?.publishData({ type: 'cohost.enabled' } satisfies AgentDataMessage);

      // Inject recent conversation context into cohost
      await this.injectContextIntoCohost(session);

      // Auto-start: update primary AI prompt for cohost mode, then trigger cohost's first turn
      await this.updatePrimaryForCohostMode(session);

      // If there's a recent transcript from primary, trigger cohost to respond to it
      const lastPrimary = session.recentTranscripts
        .filter(t => t.speaker === 'primary')
        .pop();
      if (lastPrimary) {
        session.cohostState.turnState = 'cohost_speaking';
        this.injectTranscriptAndTrigger(session, 'cohost', `[Alia] ${lastPrimary.text}`);
      }

      log.providers.info({ sessionId }, 'Cohost mode enabled');

    } catch (error: any) {
      log.providers.error({ err: error }, 'Failed to enable cohost');
      await session.agentBridge?.publishData({
        type: 'error', code: 'cohost_failed', message: error.message,
      } satisfies AgentDataMessage);
      // Clean up partial state
      this.disableCohost(sessionId, 'setup_failed');
    }
  }

  async disableCohost(sessionId: string, reason?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.cohostEnabled) return;

    log.providers.info({ sessionId, reason }, 'Disabling cohost');

    // Cancel any ongoing cohost response
    if (session.cohostProviderSocket?.readyState === WebSocket.OPEN) {
      try {
        session.cohostProviderSocket.send(JSON.stringify({ type: 'response.cancel' }));
      } catch {}
      session.cohostProviderSocket.close(1000, 'Cohost disabled');
    }

    // Disconnect cohost bridge
    await session.cohostBridge?.disconnect().catch(() => {});

    // Finalize cohost credits
    if (session.cohostCreditReservation) {
      try {
        await finalizeVoiceCredits(
          session.cohostCreditReservation,
          Math.max(session.cohostMinutesElapsed, 0.01),
          session.aliaModelId,
          session.cohostCostPerMinute
        );
      } catch (e) { log.providers.error({ err: e }, 'Error finalizing cohost credits'); }
    }

    // Clear cohost timers
    if (session.cohostBillingTimer) { clearInterval(session.cohostBillingTimer); session.cohostBillingTimer = null; }
    if (session.cohostInactivityTimer) { clearTimeout(session.cohostInactivityTimer); session.cohostInactivityTimer = null; }

    // Reset cohost state
    session.cohostEnabled = false;
    session.cohostBridge = null;
    session.cohostProviderSocket = null;
    session.cohostProvider = null;
    session.cohostProviderModelId = null;
    session.cohostCreditReservation = null;
    session.cohostState = null;
    session.cohostToolExecutors = undefined;

    // Notify client
    await session.agentBridge?.publishData({ type: 'cohost.disabled' } satisfies AgentDataMessage).catch(() => {});

    log.providers.info({ sessionId }, 'Cohost disabled');
  }

  // ============== COHOST TURN ORCHESTRATION ==============

  private handleCohostTurnComplete(session: VoiceSession, completedRole: 'primary' | 'cohost'): void {
    if (!session.cohostState || !session.cohostEnabled) return;

    session.cohostState.turnsInCurrentRound++;

    // Check safety valve
    if (session.cohostState.turnsInCurrentRound >= session.cohostState.config.maxTurnsPerRound) {
      session.cohostState.turnState = 'idle';
      session.agentBridge?.publishData({
        type: 'cohost.round_complete',
        turns: session.cohostState.turnsInCurrentRound,
      } satisfies AgentDataMessage).catch(() => {});
      return;
    }

    // Get the last transcript from the completed role
    const lastTranscript = session.recentTranscripts
      .filter(t => t.speaker === completedRole)
      .pop();

    if (!lastTranscript || !session.cohostState.config.autoConverse) return;

    // After a pause, trigger the other AI to respond
    const nextRole = completedRole === 'primary' ? 'cohost' : 'primary';
    const prefix = completedRole === 'primary' ? '[Alia]' : '[Cohost]';

    setTimeout(() => {
      if (!session.cohostEnabled || session.state !== 'active') return;
      session.cohostState!.turnState = nextRole === 'primary' ? 'primary_speaking' : 'cohost_speaking';
      session.agentBridge?.publishData({
        type: 'cohost.turn_changed', speaker: nextRole,
      } satisfies AgentDataMessage).catch(() => {});
      this.injectTranscriptAndTrigger(session, nextRole, `${prefix} ${lastTranscript.text}`);
    }, session.cohostState.config.turnPauseMs);
  }

  private injectTranscriptAndTrigger(
    session: VoiceSession,
    targetRole: 'primary' | 'cohost',
    text: string
  ): void {
    const socket = targetRole === 'primary' ? session.providerSocket : session.cohostProviderSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    // Inject as user message
    socket.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    }));

    // Trigger response
    socket.send(JSON.stringify({ type: 'response.create' }));
  }

  private handleUserInterruptDuringCohost(session: VoiceSession): void {
    if (!session.cohostState) return;

    // Cancel whoever is currently speaking
    const activeSpeaker = session.cohostState.turnState;
    if (activeSpeaker === 'cohost_speaking' && session.cohostProviderSocket?.readyState === WebSocket.OPEN) {
      session.cohostProviderSocket.send(JSON.stringify({ type: 'response.cancel' }));
    }
    if (activeSpeaker === 'primary_speaking' && session.providerSocket?.readyState === WebSocket.OPEN) {
      session.providerSocket.send(JSON.stringify({ type: 'response.cancel' }));
    }

    session.cohostState.turnState = 'user_speaking';
    session.agentBridge?.publishData({
      type: 'cohost.turn_changed', speaker: 'user',
    } satisfies AgentDataMessage).catch(() => {});
  }

  private continueCohostRound(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.cohostState || !session.cohostEnabled) return;

    session.cohostState.turnsInCurrentRound = 0;
    // Re-trigger from primary
    const lastAny = session.recentTranscripts.pop();
    if (lastAny) {
      const prefix = lastAny.speaker === 'primary' ? '[Alia]' : lastAny.speaker === 'cohost' ? '[Cohost]' : '[User]';
      session.cohostState.turnState = 'cohost_speaking';
      this.injectTranscriptAndTrigger(session, 'cohost', `${prefix} ${lastAny.text}`);
    }
  }

  // ============== COHOST PROMPTS ==============

  private buildCohostInstructions(session: VoiceSession): string {
    const base = session.config.instructions || '';
    return `You are "Cohost", a co-host in a real-time voice conversation alongside Alia and a human user.
Messages prefixed with [Alia] are from the main assistant. Messages prefixed with [User] are from the human.
- Engage naturally with Alia's points — sometimes agree, sometimes disagree
- Keep responses concise (2-4 sentences)
- Speak with your own personality and viewpoint
- Be conversational, expressive, and natural
- Vary your conversational patterns: ask questions, make statements, bring new angles

${base}`;
  }

  private async injectContextIntoCohost(session: VoiceSession): Promise<void> {
    if (!session.cohostProviderSocket || session.cohostProviderSocket.readyState !== WebSocket.OPEN) return;
    if (session.recentTranscripts.length === 0) return;

    // Inject recent transcripts as conversation context
    for (const entry of session.recentTranscripts) {
      const prefix = entry.speaker === 'primary' ? '[Alia]' : entry.speaker === 'user' ? '[User]' : '[Cohost]';
      session.cohostProviderSocket.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `${prefix} ${entry.text}` }],
        },
      }));
    }
  }

  private async updatePrimaryForCohostMode(session: VoiceSession): Promise<void> {
    if (!session.providerSocket || session.providerSocket.readyState !== WebSocket.OPEN) return;

    // Append cohost awareness to primary's instructions
    const cohostAddendum = `\n\n## Cohost Mode
You are now in a conversation with another AI called "Cohost" and the user.
Messages prefixed with [Cohost] are from your co-host. Messages prefixed with [User] are from the human.
- Build on Cohost's points — agree, disagree, add nuance
- Keep turns concise (2-4 sentences) for natural flow
- Address the user when they speak
- Vary your patterns: ask questions, make statements, bring new angles`;

    session.providerSocket.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions: (session.config.instructions || '') + cohostAddendum,
      },
    }));
  }

  // ============== INACTIVITY TIMERS ==============

  /**
   * Start 10s silence timer (normal mode).
   * After AI finishes speaking, if user doesn't speak within 10s, end call.
   */
  private startUserSilenceTimer(session: VoiceSession): void {
    if (session.cohostEnabled) return; // Don't use in cohost mode

    // Clear any existing timer
    if (session.userSilenceTimer) {
      clearTimeout(session.userSilenceTimer);
    }

    session.userSilenceTimer = setTimeout(() => {
      log.providers.info({ sessionId: session.sessionId }, 'User silence timeout (10s)');
      this.closeSession(session.sessionId, 'user_silent');
    }, USER_SILENCE_TIMEOUT_MS);
  }

  /**
   * Start 30s cohost inactivity timer.
   * If user hasn't spoken for 30s during cohost mode, ask if they're still there.
   */
  private startCohostInactivityTimer(session: VoiceSession): void {
    if (!session.cohostEnabled) return;

    if (session.cohostInactivityTimer) {
      clearTimeout(session.cohostInactivityTimer);
    }

    session.cohostInactivityTimer = setTimeout(() => {
      this.pauseCohostAndCheckUser(session);
    }, COHOST_INACTIVITY_TIMEOUT_MS);
  }

  private pauseCohostAndCheckUser(session: VoiceSession): void {
    if (!session.cohostEnabled || session.state !== 'active') return;

    log.providers.info({ sessionId: session.sessionId }, 'Cohost inactivity: checking if user is still there');

    // Pause the AI-to-AI conversation
    if (session.cohostState) {
      session.cohostState.turnState = 'idle';
    }

    // Ask via primary AI
    if (session.providerSocket?.readyState === WebSocket.OPEN) {
      session.providerSocket.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '[System] The user has been silent for a while. Briefly ask them if they are still listening and want you to continue the conversation.' }],
        },
      }));
      session.providerSocket.send(JSON.stringify({ type: 'response.create' }));
    }

    // Wait 15s more, then close if still no response
    session.cohostInactivityTimer = setTimeout(() => {
      log.providers.info({ sessionId: session.sessionId }, 'User unresponsive after check-in, closing session');
      this.closeSession(session.sessionId, 'user_unresponsive');
    }, COHOST_CHECKIN_WAIT_MS);
  }

  // ============== BILLING ==============

  private startBillingTimer(session: VoiceSession): void {
    if (session.billingTimer) clearInterval(session.billingTimer);

    session.billingTimer = setInterval(() => {
      session.minutesElapsed++;
      const maxDuration = session.config.maxDuration || 30;
      if (session.minutesElapsed >= maxDuration) {
        log.providers.info({ sessionId: session.sessionId, maxDuration }, 'Max duration reached');
        this.closeSession(session.sessionId, 'max_duration_exceeded');
      }
    }, BILLING_INTERVAL_MS);
  }

  // ============== USAGE TRACKING ==============

  private async saveUsageRecord(session: VoiceSession, isFinal: boolean, disconnectReason?: string): Promise<void> {
    try {
      const { VoiceCallUsage } = await import('../../../models/voice-call-usage.js');

      const endTime = isFinal ? new Date() : undefined;
      const durationMinutes = isFinal
        ? (endTime!.getTime() - session.startTime.getTime()) / 60000
        : 0;
      const creditsCharged = isFinal && session.creditReservation
        ? session.creditReservation.creditsReserved
        : 0;

      const record: any = {
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
        // Cohost fields
        cohostEnabled: session.cohostEnabled,
        cohostProvider: session.cohostProvider,
        cohostProviderModel: session.cohostProviderModelId,
        cohostDurationMinutes: session.cohostMinutesElapsed,
        cohostCreditsCharged: session.cohostCreditReservation?.creditsReserved || 0,
      };

      if (isFinal) {
        await VoiceCallUsage.findOneAndUpdate({ sessionId: session.sessionId }, record, { upsert: true });
      } else {
        await VoiceCallUsage.create(record);
      }
    } catch (error) {
      log.providers.error({ err: error }, 'Error saving usage record');
    }
  }

  // ============== SHUTDOWN ==============

  private async shutdown(): Promise<void> {
    log.providers.info('Voice session manager shutting down...');
    const closePromises = Array.from(this.sessions.keys()).map(id =>
      this.closeSession(id, 'server_shutdown')
    );
    await Promise.all(closePromises);
    log.providers.info('Voice session manager shutdown complete');
  }

  getActiveSessionsCount(): number {
    return this.sessions.size;
  }

  getUserSessionsCount(userId: string): number {
    return this.userSessionCounts.get(userId) || 0;
  }
}

export const voiceSessionManager = new VoiceSessionManager();
