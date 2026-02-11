/**
 * LiveKit Voice Agent
 *
 * Uses @livekit/agents to create a voice pipeline agent that:
 * - Listens to user speech via STT (Deepgram/OpenAI Whisper)
 * - Processes with LLM (routed through Alia's model system)
 * - Responds with TTS (OpenAI TTS)
 *
 * Requires self-hosted LiveKit Server and LIVEKIT_* env vars.
 * All LiveKit packages are optional — the agent gracefully degrades if not installed.
 */

import { createRequire } from 'module';
import { isLiveKitConfigured } from './livekit-token.js';

// Type declarations for the optional @livekit/agents packages
interface LiveKitJobContext {
  connect(): Promise<void>;
  room: { name: string };
  waitForParticipant(): Promise<{ identity: string }>;
}

interface LiveKitSession {
  on(event: string, handler: () => void): void;
}

interface LiveKitAgentDefinition {
  entry: (ctx: LiveKitJobContext) => Promise<void>;
}

interface LiveKitWorkerOptions {
  agent: string;
  apiKey: string | undefined;
  apiSecret: string | undefined;
  wsURL: string | undefined;
}

let agentStarted = false;

export async function startLiveKitAgent(): Promise<void> {
  if (agentStarted) return;
  if (!isLiveKitConfigured()) {
    console.log('[LiveKit] Agent not started - LiveKit not configured');
    return;
  }

  // createRequire allows loading CJS/optional packages in an ESM context
  const require = createRequire(import.meta.url);

  try {
    // These are optional dependencies — try/catch handles missing packages
    const agents = require('@livekit/agents') as {
      WorkerOptions: new (opts: LiveKitWorkerOptions) => unknown;
      cli: { runApp(opts: unknown): void };
      defineAgent(def: LiveKitAgentDefinition): void;
      multimodal: {
        MultimodalAgent: new (opts: { model: unknown }) => {
          start(room: unknown, participant: unknown): Promise<LiveKitSession>;
        };
      };
    };

    const openaiPlugin = require('@livekit/agents/plugins/openai') as {
      OpenAI: {
        RealtimeModel: new (opts: {
          model: string;
          voice: string;
          temperature: number;
          instructions: string;
        }) => unknown;
      };
    };

    agents.defineAgent({
      entry: async (ctx: LiveKitJobContext) => {
        await ctx.connect();
        console.log(`[LiveKit] Agent connected to room: ${ctx.room.name}`);

        const participant = await ctx.waitForParticipant();
        console.log(`[LiveKit] Participant joined: ${participant.identity}`);

        const model = new openaiPlugin.OpenAI.RealtimeModel({
          model: 'gpt-4o-realtime-preview',
          voice: 'alloy',
          temperature: 0.6,
          instructions: 'You are Alia, a helpful AI assistant. Be conversational, friendly, and concise in voice responses. Respond in the same language the user speaks.',
        });

        const agent = new agents.multimodal.MultimodalAgent({ model });
        const session = await agent.start(ctx.room, participant);

        console.log(`[LiveKit] Voice session started for ${participant.identity}`);

        session.on('close', () => {
          console.log(`[LiveKit] Voice session ended for ${participant.identity}`);
        });
      },
    });

    const workerOptions = new agents.WorkerOptions({
      agent: 'voice-agent',
      apiKey: process.env.LIVEKIT_API_KEY,
      apiSecret: process.env.LIVEKIT_API_SECRET,
      wsURL: process.env.LIVEKIT_URL,
    });

    agents.cli.runApp(workerOptions);
    agentStarted = true;
    console.log('[LiveKit] Agent worker started');
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      console.log('[LiveKit] Agent packages not installed - voice agent disabled');
    } else {
      console.error('[LiveKit] Agent startup error:', err.message);
    }
  }
}
