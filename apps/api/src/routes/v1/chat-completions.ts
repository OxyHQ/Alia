import { Router, Request, Response } from 'express';
import { streamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { loadKeys } from '../../lib/load-balancer.js';
import { resolveAliaModel, getDefaultAliaModel } from '../../lib/model-resolver.js';
import { UserCredits } from '../../models/user-credits.js';
import { reserveCredits, finalizeCredits, type CreditReservation, type CreditUsage } from '../../lib/credits-manager.js';
import type { KeyConfig } from '../../lib/types.js';

const router = Router();

// Create AI SDK provider based on key
function getAIModel(keyConfig: KeyConfig) {
  const apiKey = keyConfig.key;
  const modelId = keyConfig.modelId;

  switch (keyConfig.provider) {
    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelId || 'gemini-2.0-flash-exp');
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey });
      return openai(modelId || 'gpt-4o-mini');
    }
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelId || 'claude-sonnet-4-20250514');
    }
    case 'groq': {
      const groq = createOpenAI({
        apiKey,
        baseURL: 'https://api.groq.com/openai/v1'
      });
      return groq(modelId || 'llama-3.3-70b-versatile');
    }
    case 'together': {
      const together = createOpenAI({
        apiKey,
        baseURL: 'https://api.together.ai/v1'
      });
      return together(modelId || 'meta-llama/Llama-3.3-70B-Instruct-Turbo');
    }
    case 'cerebras': {
      const cerebras = createOpenAI({
        apiKey,
        baseURL: 'https://api.cerebras.ai/v1'
      });
      return cerebras(modelId || 'llama-3.3-70b');
    }
    default:
      throw new Error(`Provider "${keyConfig.provider}" not supported`);
  }
}

/**
 * POST /v1/chat/completions
 * OpenAI-compatible chat completions endpoint with streaming support
 */
router.post('/', async (req: Request, res: Response) => {
  let creditReservation: CreditReservation | null = null;

  try {
    console.log('📬 [V1/Chat] Request received');
    const body = req.body;

    // Validate request body
    if (!body || typeof body !== 'object') {
      res.status(400).json({
        error: 'Invalid request body',
        details: 'Request body must be a JSON object'
      });
      return;
    }

    // Support both "messages" (OpenAI standard) and "input" (Cursor format)
    const messages = body.messages || body.input;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        error: 'Invalid messages',
        details: 'Request body must include a "messages" array with at least one message'
      });
      return;
    }

    console.log(`✅ [V1/Chat] Processing ${messages.length} messages`);

    // Reserve credits if user is authenticated
    if (req.user) {
      try {
        // Get or create credits record
        await UserCredits.findByIdAndUpdate(
          req.user.id,
          {
            $setOnInsert: {
              _id: req.user.id,
              credits: { free: 1000, freeLimit: 1000, dailyRefresh: 300, lastRefresh: new Date(), paid: 0 },
            },
          },
          { upsert: true, new: true }
        );

        // Reserve credits
        creditReservation = await reserveCredits(req.user.id);

        if (!creditReservation) {
          res.status(402).json({
            error: 'Insufficient credits',
            details: 'You need credits to use the API'
          });
          return;
        }
      } catch (error) {
        console.error('[V1/Chat] Error reserving credits:', error);
      }
    }

    // Resolve Alia model to concrete provider/model
    const requestedModel = body.model || getDefaultAliaModel();
    const keyPool = await loadKeys();
    const resolved = await resolveAliaModel(requestedModel, keyPool);

    if (!resolved) {
      res.status(503).json({ error: 'No models available', requested_model: requestedModel });
      return;
    }

    const model = getAIModel(resolved.keyConfig);
    const aliasModelId = resolved.aliasModelId;

    // Track token usage
    let tokenUsage: CreditUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const streamConfig: any = {
      model,
      messages: messages as any,
      temperature: body.temperature ?? 0.7,
      onFinish: async (result: any) => {
        // Capture token usage from AI SDK
        if (result.usage) {
          tokenUsage = {
            promptTokens: result.usage.inputTokens || 0,
            completionTokens: result.usage.outputTokens || 0,
            totalTokens: result.usage.totalTokens || 0,
          };
          console.log('[V1/Chat] Token usage captured:', tokenUsage);
        }
      },
    };

    if (body.max_tokens) {
      streamConfig.maxTokens = body.max_tokens;
    }

    if (body.tools) {
      streamConfig.tools = body.tools;
    }

    const result = streamText(streamConfig);

    // Stream OpenAI-compatible chunks
    for await (const chunk of result.fullStream) {
      if (chunk.type === 'text-delta') {
        const openAIChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: aliasModelId,
          choices: [{
            index: 0,
            delta: { content: chunk.text },
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);
      } else if (chunk.type === 'finish') {
        const finishChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: aliasModelId,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: chunk.finishReason || 'stop'
          }]
        };
        res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
      }
    }

    // Finalize credits based on actual token usage and model tier
    if (creditReservation && req.user) {
      try {
        const { creditsCharged, creditsRemaining } = await finalizeCredits(
          creditReservation,
          tokenUsage,
          aliasModelId
        );

        // Send usage info as metadata chunk
        const usageChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: aliasModelId,
          usage: {
            prompt_tokens: tokenUsage.promptTokens,
            completion_tokens: tokenUsage.completionTokens,
            total_tokens: tokenUsage.totalTokens,
            credits_charged: creditsCharged,
            credits_remaining: creditsRemaining
          }
        };
        res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
      } catch (error) {
        console.error('[V1/Chat] Error finalizing credits:', error);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (e: unknown) {
    console.error('❌ [V1/Chat] Error:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    } else {
      res.end();
    }
  }
});

/**
 * GET /v1/chat/completions
 * Health check and stats endpoint
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    console.log('📡 [API/GET] Request received');
    const keyPool = await loadKeys();
    const stats = {
      total: keyPool.length,
      free: keyPool.filter(k => !k.isPaid).length,
      paid: keyPool.filter(k => k.isPaid).length,
      providers: [...new Set(keyPool.map(k => k.provider))]
    };

    res.json({
      status: '🟢 Online',
      service: 'Alia AI Agent System',
      keys: stats,
      endpoint: '/v1/chat/completions'
    });
  } catch (e: unknown) {
    console.error('❌ [API/GET] Error:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

export default router;
