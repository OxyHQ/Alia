import { Router, Request, Response } from 'express';
import { streamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { loadKeys } from '../../lib/load-balancer.js';
import { resolveAliaModel, getDefaultAliaModel } from '../../lib/model-resolver.js';
import { UserCredits } from '../../models/user-credits.js';
import { reserveCredits, finalizeCredits, type CreditReservation, type CreditUsage } from '../../lib/credits-manager.js';
import { convertOpenAIToolsToToolSet } from '../../lib/tool-converter.js';
import type { KeyConfig } from '../../lib/types.js';

const router = Router();

/**
 * Convert OpenAI-format messages to AI SDK ModelMessage format.
 * Handles tool result messages which have role "tool" in OpenAI format.
 */
function convertToAISDKMessages(messages: any[], toolNameMapping: Map<string, string>): any[] {
  const result: any[] = [];
  const toolCallsMap = new Map<string, { name: string; index: number }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'system') {
      result.push({
        role: 'system',
        content: msg.content || ''
      });
    } else if (msg.role === 'user') {
      result.push({
        role: 'user',
        content: msg.content
      });
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        // Track tool calls for matching with results
        for (const tc of msg.tool_calls) {
          if (tc.id && tc.function?.name) {
            const sanitizedName = Array.from(toolNameMapping.entries())
              .find(([_, orig]) => orig === tc.function.name)?.[0] || tc.function.name;
            toolCallsMap.set(tc.id, { name: sanitizedName, index: result.length });
          }
        }

        result.push({
          role: 'assistant',
          content: msg.content || '',
          toolCalls: msg.tool_calls.map((tc: any) => {
            const sanitizedName = Array.from(toolNameMapping.entries())
              .find(([_, orig]) => orig === tc.function?.name)?.[0] || tc.function?.name || 'unknown';

            return {
              toolCallId: tc.id,
              toolName: sanitizedName,
              args: typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : (tc.function?.arguments || {})
            };
          })
        });
      } else {
        result.push({
          role: 'assistant',
          content: msg.content || ''
        });
      }
    } else if (msg.role === 'tool') {
      // Convert OpenAI tool result to AI SDK format
      const toolCallId = msg.tool_call_id;
      const toolInfo = toolCallsMap.get(toolCallId);
      let toolName = toolInfo?.name || msg.name || 'unknown';

      // Try to find tool name from previous assistant message if unknown
      if (toolName === 'unknown' && i > 0) {
        for (let j = i - 1; j >= 0; j--) {
          const prevMsg = messages[j];
          if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
            const matchingCall = prevMsg.tool_calls.find((tc: any) => tc.id === toolCallId);
            if (matchingCall) {
              toolName = matchingCall.function?.name || 'unknown';
              break;
            }
          }
        }
      }

      const contentValue = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

      result.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: toolCallId,
          toolName: toolName,
          output: {
            type: 'text',
            value: contentValue
          }
        }]
      });
    }
  }

  return result;
}

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

    // Convert OpenAI-format tools to AI SDK format if provided
    const toolNameMapping = new Map<string, string>();
    let convertedTools: Record<string, any> | undefined;
    if (body.tools && Array.isArray(body.tools)) {
      console.log(`[V1/Chat] Converting ${body.tools.length} tools from OpenAI format to AI SDK format`);
      convertedTools = convertOpenAIToolsToToolSet(body.tools, toolNameMapping);
    }

    // Convert messages to AI SDK format (handles tool results)
    const convertedMessages = convertToAISDKMessages(messages, toolNameMapping);
    console.log(`[V1/Chat] Converted ${messages.length} messages to AI SDK format`);

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
      messages: convertedMessages,
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

    if (convertedTools) {
      streamConfig.tools = convertedTools;
    }

    // Configure provider-specific features for reasoning
    const providerMetadata: any = {};

    if (resolved.provider === 'google') {
      // Enable thought summaries for Gemini
      providerMetadata.google = { includeThoughts: true };
      console.log('[V1/Chat] Enabled Gemini thought summaries');
    }

    if (Object.keys(providerMetadata).length > 0) {
      streamConfig.experimental_providerMetadata = providerMetadata;
    }

    const result = streamText(streamConfig);

    // Stream OpenAI-compatible chunks
    console.log('[V1/Chat] Starting to process AI SDK stream...');
    let chunkCount = 0;
    for await (const chunk of result.fullStream) {
      chunkCount++;
      console.log(`[V1/Chat] Chunk ${chunkCount} type:`, chunk.type);
      console.log(`[V1/Chat] Chunk ${chunkCount} full:`, JSON.stringify(chunk, null, 2));

      if (chunk.type === 'text-delta' && chunk.textDelta) {
        // Extract <thinking> tags for chain-of-thought (Anthropic, DeepSeek, etc.)
        const thinkingMatch = chunk.textDelta.match(/<thinking>([\s\S]*?)<\/thinking>/g);
        if (thinkingMatch) {
          // Send thinking content as reasoning chunk
          thinkingMatch.forEach(match => {
            const content = match.replace(/<\/?thinking>/g, '').trim();
            if (content) {
              const reasoningChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: aliasModelId,
                choices: [{
                  index: 0,
                  delta: {
                    reasoning: content,
                    role: 'assistant'
                  },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(reasoningChunk)}\n\n`);
              console.log('[V1/Chat] Reasoning chunk (thinking tag):', content.slice(0, 100));
            }
          });
        }

        // Filter out thinking tags from the main message
        const filtered = chunk.textDelta.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
        if (filtered) {
          const openAIChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: aliasModelId,
            choices: [{
              index: 0,
              delta: { content: filtered },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);
        }
      } else if ((chunk as any).type === 'thought-delta' || (chunk as any).type === 'reasoning-delta') {
        // Handle Gemini thought summaries and other reasoning tokens
        const reasoningText = (chunk as any).text || (chunk as any).thoughtDelta || (chunk as any).reasoningDelta;
        if (reasoningText && typeof reasoningText === 'string' && reasoningText.trim()) {
          const reasoningChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: aliasModelId,
            choices: [{
              index: 0,
              delta: {
                reasoning: reasoningText.trim(),
                role: 'assistant'
              },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(reasoningChunk)}\n\n`);
          console.log('[V1/Chat] Reasoning chunk (provider):', reasoningText.slice(0, 100));
        }
      } else if (chunk.type === 'tool-call') {
        // Restore original tool name if it was sanitized
        const originalToolName = toolNameMapping.get(chunk.toolName) || chunk.toolName;

        const toolCallChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: aliasModelId,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: chunk.toolCallId,
                type: 'function',
                function: {
                  name: originalToolName,
                  arguments: JSON.stringify(chunk.input || {})
                }
              }]
            },
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(toolCallChunk)}\n\n`);
      } else if (chunk.type === 'tool-result') {
        console.log('[V1/Chat] Tool result:', chunk.toolName, chunk.output);
      } else if (chunk.type === 'finish') {
        console.log('[V1/Chat] Finish chunk received');
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
      } else {
        console.warn('[V1/Chat] Unhandled chunk type:', chunk.type, 'Chunk:', JSON.stringify(chunk, null, 2));
      }
    }

    console.log('[V1/Chat] Stream processing complete, total chunks:', chunkCount);

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
