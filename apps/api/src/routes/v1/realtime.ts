/**
 * Realtime Voice API Endpoint
 *
 * WebSocket endpoint for real-time voice conversations.
 * Compatible with OpenAI Realtime API specification.
 *
 * Connection: ws(s)://host/v1/realtime?model=alia-v1-voice&token=<jwt>[&voice=alloy][&instructions=...]
 *
 * Auth: JWT token (via ?token=) or API key (via ?api_key=)
 *
 * The endpoint builds rich voice instructions including:
 * - Model-specific system prompt (from prompt-loader)
 * - User name, memory, preferences, and context (from Oxy + UserMemory)
 * - Language mirroring instructions
 * - Voice-appropriate tools (getCurrentDate)
 */

import type { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type WebSocket from 'ws';
import type { OpenAITool } from '../../internal/providers/lib/types.js';
import { voiceSessionManager } from '../../internal/providers/lib/voice-session-manager.js';
import { OxyServices } from '@oxyhq/core';
import DeveloperApiKey from '../../models/developer-api-key.js';
import { buildSystemPrompt } from '../../lib/prompt-loader.js';
import { buildUserContext } from '../../lib/user-context.js';

// ============== WEBSOCKET ENDPOINT SETUP ==============

export function setupRealtimeEndpoint(wss: WebSocketServer): void {
  console.log('[Realtime] Setting up WebSocket endpoint at /v1/realtime');

  wss.on('connection', async (ws: WebSocket, request: IncomingMessage) => {
    let userId: string | null = null;
    let sessionId: string | null = null;

    try {
      // Parse URL and query parameters
      const url = new URL(request.url!, `http://${request.headers.host}`);
      const model = url.searchParams.get('model') || 'alia-v1-voice';
      const token = url.searchParams.get('token');
      const apiKey = url.searchParams.get('api_key');
      const instructions = url.searchParams.get('instructions');
      const voice = url.searchParams.get('voice');

      console.log(`[Realtime] New connection request for model: ${model}`);

      // Authentication
      if (token) {
        // JWT authentication (user sessions via Oxy) — per-request instance for concurrency safety
        try {
          const perRequestOxy = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });
          perRequestOxy.setTokens(token);
          const valid = await perRequestOxy.validate();
          if (!valid) throw new Error('Invalid token');
          // Decode JWT payload to extract user ID
          const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
          userId = payload.userId || payload.sub || payload._id;
          if (!userId) throw new Error('No user ID in token');
          console.log(`[Realtime] Authenticated user via JWT: ${userId}`);
        } catch (error) {
          console.error('[Realtime] JWT verification failed:', error);
          ws.close(4001, 'Invalid or expired token');
          return;
        }
      } else if (apiKey) {
        // API key authentication (developer keys)
        try {
          const keyHash = (DeveloperApiKey as any).hashKey(apiKey);
          const devKey = await DeveloperApiKey.findOne({
            keyHash,
            isActive: true,
            $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
          });

          if (!devKey) {
            console.error('[Realtime] Invalid API key');
            ws.close(4001, 'Invalid API key');
            return;
          }

          userId = devKey.oxyUserId;
          console.log(`[Realtime] Authenticated user via API key: ${userId}`);
        } catch (error) {
          console.error('[Realtime] API key validation failed:', error);
          ws.close(4000, 'Authentication error');
          return;
        }
      } else {
        console.error('[Realtime] No authentication provided');
        ws.close(4001, 'Authentication required: provide token or api_key');
        return;
      }

      // Check concurrent session limit
      const userSessions = voiceSessionManager.getUserSessionsCount(userId);
      if (userSessions >= 5) {
        console.error(`[Realtime] User ${userId} exceeded max concurrent sessions`);
        ws.close(4003, 'Maximum concurrent sessions reached (5)');
        return;
      }

      // Build rich voice instructions (mirrors chat-completions.ts context building)
      let voiceInstructions = 'You are in a real-time voice conversation. Keep responses concise and conversational — avoid long lists, markdown, or code blocks. Speak naturally.\n\n';

      // Load model-specific system prompt
      try {
        const basePrompt = await buildSystemPrompt(model);
        voiceInstructions += basePrompt;
      } catch (e) {
        console.error('[Realtime] Error loading system prompt:', e);
      }

      // Add user context (name, memory, preferences, language) via shared utility
      const userContext = await buildUserContext(userId);
      voiceInstructions += userContext.contextString;
      if (userContext.language) {
        voiceInstructions += `\n\nIMPORTANT: Mirror the user's language. If their language is unclear, default to ${userContext.language}.`;
      }

      // Override with client-provided instructions if explicitly set
      if (instructions) {
        voiceInstructions = instructions;
      }

      console.log(`[Realtime] Built voice instructions (${voiceInstructions.length} chars)`);

      // Voice-appropriate tools
      const voiceTools: OpenAITool[] = [
        {
          type: 'function',
          function: {
            name: 'getCurrentDate',
            description: 'Get the current date, time, and day of the week',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
      ];

      // Create voice session
      try {
        const session = await voiceSessionManager.createSession(userId, ws, model, {
          model,
          instructions: voiceInstructions,
          voice: voice || undefined,
          tools: voiceTools,
        });

        sessionId = session.sessionId;
        console.log(`[Realtime] Session created: ${sessionId}`);

        // Send session.created event to client
        ws.send(
          JSON.stringify({
            type: 'session.created',
            session: {
              id: sessionId,
              model: session.aliaModelId,
              modalities: ['text', 'audio'],
              voice: session.config.voice || 'alloy',
              input_audio_format: session.audioFormat,
              output_audio_format: session.audioFormat,
            },
          })
        );

      } catch (error: any) {
        console.error('[Realtime] Error creating session:', error);

        // Send error event
        ws.send(
          JSON.stringify({
            type: 'error',
            error: {
              code: error.message.includes('Insufficient credits')
                ? 'insufficient_credits'
                : error.message.includes('Maximum concurrent sessions')
                ? 'rate_limit_exceeded'
                : error.message.includes('resolve model')
                ? 'invalid_request_error'
                : 'internal_error',
              message: error.message,
            },
          })
        );

        ws.close(4000, error.message);
        return;
      }

      // Setup event handlers
      ws.on('message', (data: Buffer) => {
        if (sessionId) {
          voiceSessionManager.handleClientMessage(sessionId, data);
        }
      });

      ws.on('close', async (code, reason) => {
        console.log(`[Realtime] Client disconnected: ${code} ${reason}`);
        if (sessionId) {
          await voiceSessionManager.closeSession(sessionId, 'client_disconnected');
        }
      });

      ws.on('error', async (error) => {
        console.error('[Realtime] WebSocket error:', error);
        if (sessionId) {
          await voiceSessionManager.closeSession(sessionId, 'websocket_error');
        }
      });

      // Handle ping/pong for keepalive
      ws.on('pong', () => {
        // Keep connection alive
      });

      // Send ping every 30 seconds
      const pingInterval = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          ws.ping();
        } else {
          clearInterval(pingInterval);
        }
      }, 30000);

      ws.on('close', () => {
        clearInterval(pingInterval);
      });

    } catch (error) {
      console.error('[Realtime] Unexpected error:', error);
      ws.close(4000, 'Internal error');
    }
  });

  console.log('[Realtime] WebSocket endpoint ready');
}
