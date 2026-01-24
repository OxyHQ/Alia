import { Router, Request, Response } from 'express';
import { streamText, type ToolSet } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { loadKeys } from '../../../lib/load-balancer.js';
import { resolveAliaModel } from '../../../lib/model-resolver.js';
import { UserCredits } from '../../../models/user-credits.js';
import { UserMemory } from '../../../models/user-memory.js';
import { reserveCredits, finalizeCredits, type CreditReservation, type CreditUsage } from '../../../lib/credits-manager.js';
import { getCurrentDateTool, getTimelineTool, saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool } from '../../../lib/tools/index.js';
import type { KeyConfig } from '../../../lib/types.js';
import type { IUserMemory } from '../../../models/user-memory.js';

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
 * POST /v1/codea/completions
 * Code editor endpoint (Cursor, VS Code, etc.) that always uses alia-v1-codea model
 * OpenAI-compatible streaming API optimized for coding tasks
 */
router.post('/', async (req: Request, res: Response) => {
  let creditReservation: CreditReservation | null = null;

  try {
    console.log('📬 [Codea] Request received');
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

    console.log(`✅ [Codea] Processing ${messages.length} messages`);

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
        console.error('[Codea] Error reserving credits:', error);
      }
    }

    // Always use alia-v1-codea for code editors
    const keyPool = await loadKeys();
    const resolved = await resolveAliaModel('alia-v1-codea', keyPool);

    if (!resolved) {
      res.status(503).json({ error: 'Codea model not available' });
      return;
    }

    const model = getAIModel(resolved.keyConfig);
    const aliasModelId = resolved.aliasModelId;

    // Load user memory if authenticated
    let userMemory: IUserMemory | null = null;
    if (req.user) {
      try {
        userMemory = await UserMemory.findById(req.user.id);
        console.log('[Codea] User memory loaded for:', req.user.id);
      } catch (error) {
        console.error('[Codea] Error loading user memory:', error);
      }
    }

    // Build Alia internal tools (always available)
    const aliaTools: ToolSet = {
      getCurrentDate: getCurrentDateTool,
      getTimeline: getTimelineTool,
      ...(req.user ? {
        saveUserMemory: saveUserMemoryTool,
        updateUserPreferences: updateUserPreferencesTool,
        updateUserContext: updateUserContextTool,
      } : {}),
    };

    // Combine with editor tools if provided
    const editorTools = body.tools || {};
    const allTools = { ...aliaTools, ...editorTools };

    // Build system message with user context
    let systemMessage = 'You are Alia, an AI coding assistant. You help users write, debug, and understand code.';

    if (userMemory) {
      systemMessage += '\n\n## User Information';
      if (userMemory.facts && userMemory.facts.length > 0) {
        systemMessage += '\n### Known Facts:\n' + userMemory.facts.map(f => `- ${f}`).join('\n');
      }
      if (userMemory.preferences && userMemory.preferences.length > 0) {
        systemMessage += '\n### User Preferences:\n' + userMemory.preferences.map(p => `- ${p}`).join('\n');
      }
      if (userMemory.context && userMemory.context.length > 0) {
        systemMessage += '\n### Context:\n' + userMemory.context.map(c => `- ${c}`).join('\n');
      }
    }

    // Inject system message at the start if not present
    const processedMessages = [...messages];
    if (processedMessages.length === 0 || processedMessages[0].role !== 'system') {
      processedMessages.unshift({ role: 'system', content: systemMessage });
    } else {
      // Append to existing system message
      processedMessages[0].content += '\n\n' + systemMessage;
    }

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
      messages: processedMessages as any,
      temperature: body.temperature ?? 0.7,
      tools: allTools,
      onFinish: async (result: any) => {
        // Capture token usage from AI SDK
        if (result.usage) {
          tokenUsage = {
            promptTokens: result.usage.inputTokens || 0,
            completionTokens: result.usage.outputTokens || 0,
            totalTokens: result.usage.totalTokens || 0,
          };
          console.log('[Codea] Token usage captured:', tokenUsage);
        }
      },
    };

    if (body.max_tokens) {
      streamConfig.maxTokens = body.max_tokens;
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
      } else if (chunk.type === 'tool-call') {
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
                  name: chunk.toolName,
                  arguments: JSON.stringify(chunk.args)
                }
              }]
            },
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(toolCallChunk)}\n\n`);
      } else if (chunk.type === 'tool-result') {
        // Tool results are handled by the client in function calling flow
        // Just log for debugging
        console.log('[Codea] Tool result:', chunk.toolName, chunk.result);
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
        console.error('[Codea] Error finalizing credits:', error);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (e: unknown) {
    console.error('❌ [Codea] Error:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    } else {
      res.end();
    }
  }
});

export default router;
