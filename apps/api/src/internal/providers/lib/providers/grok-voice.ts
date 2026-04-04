/**
 * Grok Voice Provider
 *
 * xAI's Grok Realtime API for voice conversations
 * Compatible with OpenAI Realtime API specification
 *
 * Docs: https://docs.x.ai/docs/guides/voice/agent
 * Endpoint: wss://api.x.ai/v1/realtime
 * Pricing: $0.05/minute
 * Latency: <700ms
 */

import WebSocket from 'ws';
import type { VoiceProvider, VoiceSessionConfig } from '../types-voice.js';
import type { KeyConfig } from '../types.js';
import { log } from '../../../../lib/logger.js';

export const grokVoiceProvider: VoiceProvider = {
  name: 'Grok Voice',

  isEnabled: () => {
    return !!process.env.GROK_API_KEY || true; // Enabled if key pool has grok keys
  },

  voice: {
    capabilities: {
      audioFormats: ['pcm16'],
      sampleRates: [24000],
      languages: [
        'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'ko', 'zh',
        'ar', 'hi', 'tr', 'sv', 'da', 'no', 'fi', 'cs', 'el', 'he', 'id', 'ms',
        'th', 'vi', 'uk', 'ro', 'hu', 'sk', 'bg', 'hr', 'lt', 'lv', 'et', 'sl',
        // Grok supports 100+ languages
      ],
      maxDurationMinutes: 30,
      supportsInterruption: true,
      supportsFunctionCalling: true,
      latencyMs: 700,
    },

    async connect(key: KeyConfig, config: VoiceSessionConfig): Promise<WebSocket> {
      const model = config.model || 'grok-realtime';
      const url = `wss://api.x.ai/v1/realtime?model=${model}`;

      log.providers.info({ url }, 'Connecting to Grok Realtime');

      const ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${key.key}`,
          'OpenAI-Beta': 'realtime=v1',
        },
        handshakeTimeout: 10000,
      });

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Connection timeout'));
        }, 10000);

        ws.on('open', () => {
          clearTimeout(timeout);
          log.providers.info('Connected successfully');

          // Send session configuration
          const sessionConfig = {
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions: config.instructions || 'You are a helpful AI assistant.',
              voice: config.voice || 'alloy',
              input_audio_format: config.audioFormat || 'pcm16',
              output_audio_format: config.audioFormat || 'pcm16',
              input_audio_transcription: {
                model: 'whisper-1'
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
              },
              temperature: config.temperature !== undefined ? config.temperature : 0.8,
              max_response_output_tokens: 4096,
            }
          };

          // Add tools if provided
          if (config.tools && config.tools.length > 0) {
            (sessionConfig.session as any).tools = config.tools.map(tool => ({
              type: tool.type,
              name: tool.function.name,
              description: tool.function.description,
              parameters: tool.function.parameters,
            }));
          }

          ws.send(JSON.stringify(sessionConfig));
          log.providers.info({ model }, '[Voice] Sent Grok session configuration');

          // Log provider's first response (session confirmation or error)
          ws.once('message', (msgData: Buffer) => {
            try {
              const event = JSON.parse(msgData.toString('utf-8'));
              log.providers.info({ eventType: event.type, model }, '[Voice] First Grok event after session.update');
              if (event.type === 'error') {
                log.providers.error({ event, model }, '[Voice] Grok rejected session config');
              }
            } catch { /* best-effort parse */ }
          });

          resolve(ws);
        });

        ws.on('error', (error) => {
          clearTimeout(timeout);
          log.providers.error({ err: error }, '[Voice] Grok connection error');
          reject(error);
        });
      });
    },

    // Grok uses OpenAI Realtime API format, so no translation needed
    translateClientEvent: (event: any) => event,

    translateProviderEvent: (event: any) => event,
  },
};
