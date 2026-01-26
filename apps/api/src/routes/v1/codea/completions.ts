import { Router, Request, Response } from 'express';
import { streamText, type ToolSet, type ModelMessage } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { loadKeys } from '../../../lib/load-balancer.js';
import { resolveAliaModel } from '../../../lib/model-resolver.js';
import { UserCredits } from '../../../models/user-credits.js';
import { UserMemory } from '../../../models/user-memory.js';
import { reserveCredits, finalizeCredits, type CreditReservation, type CreditUsage } from '../../../lib/credits-manager.js';
import { getCurrentDateTool, getTimelineTool, saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool, createSendTelegramTool } from '../../../lib/tools/index.js';
import { convertOpenAIToolsToToolSet } from '../../../lib/tool-converter.js';
import { oxyClient } from '../../../middleware/auth.js';
import type { KeyConfig } from '../../../lib/types.js';
import type { IUserMemory } from '../../../models/user-memory.js';
import * as crypto from 'crypto';

const router = Router();

// Store active sessions for usage tracking (for Cowork direct AI SDK usage)
const activeSessions = new Map<string, { userId: string; reservation: CreditReservation; aliaModelId: string }>();

/**
 * GET /v1/codea/me
 * Get current user info for API key holder
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Get full user data from Oxy
    const user = await oxyClient.getUserById(req.user.id) as any;

    // Return full user object
    res.json({
      id: user.id,
      username: user.username || null,
      email: user.email || null,
      name: user.name || null, // { first, last, full }
      avatar: user.avatar || null,
    });
  } catch (error) {
    console.error('[Codea] Get user error:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

/**
 * Convert OpenAI-format messages to AI SDK ModelMessage format.
 * Handles tool result messages which have role "tool" in OpenAI format.
 */
function convertToAISDKMessages(messages: any[], toolNameMapping: Map<string, string>): ModelMessage[] {
  const result: ModelMessage[] = [];

  // Track tool calls from assistant messages to map tool results
  const toolCallsMap = new Map<string, { name: string; index: number }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'system') {
      result.push({
        role: 'system',
        content: msg.content || ''
      });
    } else if (msg.role === 'user') {
      // User messages can have string content or array content (for images, etc.)
      result.push({
        role: 'user',
        content: msg.content
      });
    } else if (msg.role === 'assistant') {
      // Check if assistant message has tool_calls
      if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        // Track tool calls for later matching with tool results
        for (const tc of msg.tool_calls) {
          if (tc.id && tc.function?.name) {
            // Get sanitized name for internal use
            const sanitizedName = Array.from(toolNameMapping.entries())
              .find(([_, orig]) => orig === tc.function.name)?.[0] || tc.function.name;
            toolCallsMap.set(tc.id, { name: sanitizedName, index: result.length });
          }
        }

        // Convert to AI SDK assistant message with tool calls
        result.push({
          role: 'assistant',
          content: msg.content || '',
          toolCalls: msg.tool_calls.map((tc: any) => {
            // Get sanitized name for the provider
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
        } as ModelMessage);
      } else {
        // Regular assistant message
        result.push({
          role: 'assistant',
          content: msg.content || ''
        });
      }
    } else if (msg.role === 'tool') {
      // Convert OpenAI tool result to AI SDK format
      // AI SDK expects tool results as a "tool" role message with specific structure
      const toolCallId = msg.tool_call_id;
      const toolInfo = toolCallsMap.get(toolCallId);

      // Get tool name from our tracking, or try to get it from the message itself
      // Some clients include the tool name in the tool result message
      let toolName = toolInfo?.name || msg.name || 'unknown';

      // If still unknown, try to find it by looking at the previous assistant message's tool calls
      if (toolName === 'unknown' && i > 0) {
        // Look backwards for the assistant message that made this tool call
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

      // Log tool result details for debugging
      console.log(`[Codea] Converting tool result: id=${toolCallId}, name=${toolName}, content_length=${contentValue.length}`);

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
      } as ModelMessage);
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
 * POST /v1/codea/resolve-model
 * Resolve Alia model to provider model and get provider key
 * Used by Cowork to get provider credentials for direct AI SDK usage
 */
router.post('/resolve-model', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not found' });
    }

    const { model } = req.body;
    if (!model) {
      return res.status(400).json({ error: 'Model is required' });
    }

    console.log('[Codea] Resolving model:', model, 'for user:', userId);

    // Reserve credits
    await UserCredits.findByIdAndUpdate(
      userId,
      {
        $setOnInsert: {
          _id: userId,
          credits: { free: 1000, freeLimit: 1000, dailyRefresh: 300, lastRefresh: new Date(), paid: 0 },
        },
      },
      { upsert: true, new: true }
    );

    const reservation = await reserveCredits(userId);
    if (!reservation) {
      return res.status(402).json({
        error: 'Insufficient credits',
        details: 'You need credits to use the API'
      });
    }

    // Resolve model
    const keyPool = await loadKeys();
    const resolved = await resolveAliaModel(model, keyPool);

    if (!resolved) {
      return res.status(503).json({ error: 'No models available', requested_model: model });
    }

    // Generate session ID for usage tracking
    const sessionId = crypto.randomBytes(16).toString('hex');

    // Store session for later usage reporting
    activeSessions.set(sessionId, {
      userId,
      reservation,
      aliaModelId: resolved.aliasModelId
    });

    console.log('[Codea] Resolved to:', resolved.provider, resolved.modelId, 'sessionId:', sessionId);

    res.json({
      provider: resolved.provider,
      modelId: resolved.modelId,
      providerKey: resolved.keyConfig.key,
      sessionId
    });
  } catch (error: any) {
    console.error('[Codea] Error resolving model:', error);
    res.status(500).json({ error: error.message || 'Failed to resolve model' });
  }
});

/**
 * POST /v1/codea/report-usage
 * Report token usage for credit tracking
 * Used by Cowork to report usage after direct AI SDK calls
 */
router.post('/report-usage', async (req: Request, res: Response) => {
  try {
    const { sessionId, usage } = req.body;

    if (!sessionId || !usage) {
      return res.status(400).json({ error: 'sessionId and usage are required' });
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
      console.warn('[Codea] Session not found for usage reporting:', sessionId);
      return res.status(404).json({ error: 'Session not found' });
    }

    console.log('[Codea] Reporting usage for session:', sessionId, 'tokens:', usage.totalTokens);

    // Finalize credits
    const { creditsCharged, creditsRemaining } = await finalizeCredits(
      session.reservation,
      usage,
      session.aliaModelId
    );

    // Clean up session
    activeSessions.delete(sessionId);

    console.log('[Codea] Charged', creditsCharged, 'credits, remaining:', creditsRemaining);

    res.json({
      success: true,
      creditsCharged,
      creditsRemaining
    });
  } catch (error: any) {
    console.error('[Codea] Error reporting usage:', error);
    res.status(500).json({ error: error.message || 'Failed to report usage' });
  }
});

/**
 * POST /v1/codea/chat/completions
 * Code editor endpoint (Cursor, VS Code, etc.) that always uses alia-v1-codea model
 * OpenAI-compatible streaming API optimized for coding tasks
 */
async function handleCodeaCompletions(req: Request, res: Response) {
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

    // Log message types for debugging
    const msgTypes = messages.map((m: any) => m.role);
    console.log(`[Codea] Message roles: ${msgTypes.join(', ')}`);

    // Log tool message details
    const toolMsgs = messages.filter((m: any) => m.role === 'tool');
    if (toolMsgs.length > 0) {
      console.log(`[Codea] Found ${toolMsgs.length} tool result messages:`);
      toolMsgs.forEach((tm: any, idx: number) => {
        const contentPreview = typeof tm.content === 'string'
          ? tm.content.substring(0, 100) + (tm.content.length > 100 ? '...' : '')
          : JSON.stringify(tm.content).substring(0, 100);
        console.log(`  [${idx}] tool_call_id=${tm.tool_call_id}, content_length=${tm.content?.length || 0}, preview: ${contentPreview}`);
      });
    }

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

    // Resolve model - the resolver handles fallback between providers
    const keyPool = await loadKeys();
    const resolved = await resolveAliaModel('alia-v1-codea', keyPool);

    if (!resolved) {
      res.status(503).json({ error: 'Codea model not available' });
      return;
    }

    const model = getAIModel(resolved.keyConfig);
    const aliasModelId = resolved.aliasModelId;
    console.log(`[Codea] Using provider: ${resolved.provider}/${resolved.modelId}`);

    // Load user memory if authenticated
    let userMemory: IUserMemory | null = null;
    if (req.user) {
      try {
        userMemory = await UserMemory.findOne({ oxyUserId: req.user.id });
        console.log('[Codea] User memory loaded for:', req.user.id, userMemory ? `(${userMemory.memories?.length || 0} memories)` : '(none)');
      } catch (error) {
        console.error('[Codea] Error loading user memory:', error);
      }
    }

    // Build Alia internal tools (always available)
    const aliaTools: ToolSet = {
      getCurrentDate: getCurrentDateTool,
      getTimeline: getTimelineTool,
      ...(req.user ? {
        saveUserMemory: saveUserMemoryTool(req.user.id),
        updateUserPreferences: updateUserPreferencesTool(req.user.id),
        updateUserContext: updateUserContextTool(req.user.id),
        sendTelegram: createSendTelegramTool(req.user.id),
      } : {}),
    };

    // Convert editor tools from OpenAI format and sanitize names for Google compatibility
    // Track name mapping to restore original names in responses
    const toolNameMapping = new Map<string, string>();
    const editorTools = Array.isArray(body.tools) ? convertOpenAIToolsToToolSet(body.tools, toolNameMapping) : {};
    const allTools = { ...aliaTools, ...editorTools };

    // Log tool schemas for debugging (first request only)
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      console.log(`[Codea] Received ${body.tools.length} tools from editor`);
      // Log first few tools to see their parameter schemas
      body.tools.slice(0, 3).forEach((t: any) => {
        if (t.function) {
          const paramNames = t.function.parameters?.properties
            ? Object.keys(t.function.parameters.properties)
            : [];
          console.log(`  Tool: ${t.function.name}, params: [${paramNames.join(', ')}]`);
        }
      });
    }

    // Build system message with user context
    let systemMessage = 'You are Alia, an AI coding assistant. You help users write, debug, and understand code.';

    if (req.user) {
      // Get user's name from Oxy
      try {
        const user = await oxyClient.getUserById(req.user.id) as any;
        console.log('[Codea] User data from Oxy:', { id: req.user.id, name: user?.name, username: user?.username });
        const userName = user?.name?.full || user?.name?.first || user?.username;
        if (userName) {
          systemMessage += `\n\nThe user's name is ${userName}.`;
          console.log('[Codea] Added user name to system message:', userName);
        }
      } catch (e: any) {
        console.error('[Codea] Error fetching user from Oxy:', e.message);
      }
      systemMessage += '\n\nYou can send Telegram notifications to the user when they request it (e.g., when a task is complete).';
    }

    if (userMemory) {
      systemMessage += '\n\n## User Information';
      if (userMemory.memories && userMemory.memories.length > 0) {
        systemMessage += '\n### Known Facts:\n' + userMemory.memories.map(m => `- ${m.key}: ${m.value}`).join('\n');
      }
      if (userMemory.preferences && Object.keys(userMemory.preferences).length > 0) {
        const prefs = Object.entries(userMemory.preferences)
          .filter(([_, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        if (prefs.length > 0) {
          systemMessage += '\n### User Preferences:\n' + prefs.join('\n');
        }
      }
      if (userMemory.context && Object.keys(userMemory.context).length > 0) {
        const ctx = Object.entries(userMemory.context)
          .filter(([_, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `- ${k}: ${v}`);
        if (ctx.length > 0) {
          systemMessage += '\n### Context:\n' + ctx.join('\n');
        }
      }
    }

    // Inject system message at the start if not present
    const rawMessages = [...messages];
    if (rawMessages.length === 0 || rawMessages[0].role !== 'system') {
      rawMessages.unshift({ role: 'system', content: systemMessage });
    } else {
      // Append to existing system message
      rawMessages[0].content += '\n\n' + systemMessage;
    }

    // Convert OpenAI-format messages to AI SDK format (handles tool messages)
    const processedMessages = convertToAISDKMessages(rawMessages, toolNameMapping);
    console.log(`[Codea] Converted ${rawMessages.length} messages to AI SDK format`);
    console.log(`[Codea] System message preview:`, rawMessages[0]?.content?.substring(0, 500));

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
      messages: processedMessages,
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
        // Restore original tool name if it was sanitized
        const originalToolName = toolNameMapping.get(chunk.toolName) || chunk.toolName;

        // Log the tool call arguments being sent to the editor
        console.log(`[Codea] Streaming tool call: ${originalToolName}, args:`, JSON.stringify(chunk.input));

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
        // Tool results are handled by the client in function calling flow
        // Just log for debugging
        console.log('[Codea] Tool result:', chunk.toolName, chunk.output);
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
}

// OpenAI-compatible path for Cursor/VS Code
router.post('/chat/completions', handleCodeaCompletions);

export default router;
