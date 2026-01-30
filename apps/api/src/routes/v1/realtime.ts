/**
 * Realtime Voice API Endpoint
 *
 * WebSocket endpoint for real-time voice conversations
 * Compatible with OpenAI Realtime API specification
 *
 * Endpoint: ws://localhost:3001/v1/realtime?model=alia-v1-voice&token=<jwt>
 */

import type { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type WebSocket from 'ws';
import { voiceSessionManager } from '../../internal/providers/lib/voice-session-manager.js';
import { oxyClient } from '../../middleware/auth.js';
import DeveloperApiKey from '../../models/developer-api-key.js';

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
        // JWT authentication (user sessions via Oxy)
        try {
          oxyClient.setTokens(token);
          const session = await oxyClient.user.getSession();
          userId = session.user._id;
          console.log(`[Realtime] Authenticated user via JWT: ${userId}`);
        } catch (error) {
          console.error('[Realtime] JWT verification failed:', error);
          ws.close(4001, 'Invalid or expired token');
          return;
        }
      } else if (apiKey) {
        // API key authentication (developer keys)
        try {
          const devKey = await DeveloperApiKey.findOne({
            keyHash: apiKey,
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

      // Create voice session
      try {
        const session = await voiceSessionManager.createSession(userId, ws, model, {
          model,
          instructions: instructions || undefined,
          voice: voice || undefined,
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
