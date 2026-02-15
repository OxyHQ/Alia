/**
 * OpenAI Realtime Voice Provider
 *
 * OpenAI's Realtime API for voice conversations.
 * Uses the same protocol as Grok Realtime since Grok is API-compatible.
 *
 * Docs: https://platform.openai.com/docs/guides/realtime
 * Endpoint: wss://api.openai.com/v1/realtime
 * Models: gpt-4o-realtime-preview, gpt-4o-mini-realtime-preview
 */

import WebSocket from 'ws';
import type { VoiceProvider, VoiceSessionConfig } from '../types-voice.js';
import type { KeyConfig } from '../types.js';
import { log } from '../../../../lib/logger.js';

export const openaiVoiceProvider: VoiceProvider = {
  name: 'OpenAI Voice',

  isEnabled: () => true,

  voice: {
    capabilities: {
      audioFormats: ['pcm16'],
      sampleRates: [24000],
      languages: [
        'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'ko', 'zh',
        'ar', 'hi', 'tr', 'sv', 'da', 'no', 'fi', 'cs', 'el', 'he', 'id', 'ms',
        'th', 'vi', 'uk', 'ro', 'hu', 'sk', 'bg', 'hr', 'lt', 'lv', 'et', 'sl',
      ],
      maxDurationMinutes: 30,
      supportsInterruption: true,
      supportsFunctionCalling: true,
      latencyMs: 500,
    },

    async connect(key: KeyConfig, config: VoiceSessionConfig): Promise<WebSocket> {
      const model = config.model || 'gpt-4o-realtime-preview';
      const url = `wss://api.openai.com/v1/realtime?model=${model}`;

      log.providers.info({ url }, 'Connecting to OpenAI Realtime');

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

          const sessionConfig: any = {
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions: config.instructions || 'You are a helpful AI assistant.',
              voice: config.voice || 'alloy',
              input_audio_format: config.audioFormat || 'pcm16',
              output_audio_format: config.audioFormat || 'pcm16',
              input_audio_transcription: { model: 'whisper-1' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
              },
              temperature: config.temperature !== undefined ? config.temperature : 0.8,
              max_response_output_tokens: 4096,
            },
          };

          if (config.tools && config.tools.length > 0) {
            sessionConfig.session.tools = config.tools.map(tool => ({
              type: tool.type,
              name: tool.function.name,
              description: tool.function.description,
              parameters: tool.function.parameters,
            }));
          }

          ws.send(JSON.stringify(sessionConfig));
          log.providers.info('Sent session configuration');

          resolve(ws);
        });

        ws.on('error', (error) => {
          clearTimeout(timeout);
          log.providers.error({ err: error }, 'Connection error');
          reject(error);
        });
      });
    },

    // OpenAI Realtime API is the canonical format — no translation needed
    translateClientEvent: (event: any) => event,
    translateProviderEvent: (event: any) => event,
  },
};
