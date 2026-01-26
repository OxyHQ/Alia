import { Router, Request, Response } from 'express';
import { streamText, type ToolSet } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { loadKeys } from '../../lib/load-balancer.js';
import { resolveAliaModel, getDefaultAliaModel } from '../../lib/model-resolver.js';
import { UserCredits } from '../../models/user-credits.js';
import { UserMemory } from '../../models/user-memory.js';
import { Conversation } from '../../models/conversation.js';
import { reserveCredits, finalizeCredits, type CreditReservation, type CreditUsage } from '../../lib/credits-manager.js';
import { convertOpenAIToolsToToolSet } from '../../lib/tool-converter.js';
import { getCurrentDateTool, getTimelineTool, saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool, createSendTelegramTool } from '../../lib/tools/index.js';
import { oxyClient } from '../../middleware/auth.js';
import type { KeyConfig } from '../../lib/types.js';
import type { IUserMemory } from '../../models/user-memory.js';
import { estimateMessageTokens } from '../../lib/token-counter.js';

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

    // Extract optional parameters for Alia internal features
    const conversationId = body.conversationId as string | undefined;
    const thinkingMode = body.thinkingMode as boolean | undefined;

    console.log(`✅ [V1/Chat] Processing ${messages.length} messages${conversationId ? ` (conversation: ${conversationId})` : ''}${thinkingMode ? ' (thinking mode enabled)' : ''}`);

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
    console.log(`[V1/Chat] Using provider: ${resolved.provider}/${resolved.modelId}`);

    // Extract client context from first system message if present (from editor/client)
    let clientContext: string | undefined;
    if (messages.length > 0 && messages[0].role === 'system') {
      clientContext = messages[0].content as string;
    }

    // Load model-specific system prompt from markdown files
    const { buildSystemPrompt } = await import('../../lib/prompt-loader.js');
    const baseSystemPrompt = await buildSystemPrompt(aliasModelId, clientContext);

    // Load user memory if authenticated
    let userMemory: IUserMemory | null = null;
    if (req.user) {
      try {
        userMemory = await UserMemory.findOne({ oxyUserId: req.user.id });
        console.log('[V1/Chat] User memory loaded for:', req.user.id, userMemory ? `(${userMemory.memories?.length || 0} memories)` : '(none)');
      } catch (error) {
        console.error('[V1/Chat] Error loading user memory:', error);
      }
    }

    // Convert editor tools from OpenAI format and sanitize names for Google compatibility
    const toolNameMapping = new Map<string, string>();
    const editorTools = Array.isArray(body.tools) ? convertOpenAIToolsToToolSet(body.tools, toolNameMapping) : {};

    // Alia internal tools are server-executed
    // Editor tools are client-executed (VS Code, Cursor, Cowork)
    const hasEditorTools = Object.keys(editorTools).length > 0;

    // Always include server-only tools (no conflicts with client tools):
    // - getCurrentDate: Server time/date
    // - sendTelegram: Server-side Telegram API
    // - saveUserMemory/updateUserPreferences/updateUserContext: Server-side DB operations
    //
    // Only exclude tools that might conflict with editor tools:
    // - getTimeline: Might conflict with client-side timeline tools
    const aliaTools: ToolSet = {
      getCurrentDate: getCurrentDateTool,
      ...(req.user ? {
        sendTelegram: createSendTelegramTool(req.user.id),
        saveUserMemory: saveUserMemoryTool(req.user.id),
        updateUserPreferences: updateUserPreferencesTool(req.user.id),
        updateUserContext: updateUserContextTool(req.user.id),
      } : {}),
      // Include these only if no editor tools (to avoid conflicts)
      ...(hasEditorTools ? {} : {
        getTimeline: getTimelineTool,
      }),
    };

    const allTools = { ...aliaTools, ...editorTools };

    // Log tool schemas for debugging
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      console.log(`[V1/Chat] Received ${body.tools.length} tools from client`);
    }

    // Build system message with user context
    // Add language instruction at the VERY BEGINNING (most important)
    const userLanguage = userMemory?.preferences?.language;
    let languageInstruction = '';
    if (userLanguage) {
      languageInstruction = `🔴 CRITICAL LANGUAGE RULE 🔴
You MUST respond EXCLUSIVELY in ${userLanguage}.
- Every word, every sentence, EVERYTHING must be in ${userLanguage}
- NO English words allowed (unless quoting code/technical terms)
- This rule OVERRIDES all other instructions
- NO EXCEPTIONS

`;
    } else {
      languageInstruction = `🔴 CRITICAL LANGUAGE RULE 🔴
You MUST respond in the EXACT SAME language the user writes to you:
- User writes Spanish → You respond ONLY in Spanish
- User writes English → You respond ONLY in English
- User writes French → You respond ONLY in French
- MIRROR their language in EVERY response
- This rule OVERRIDES all other instructions
- NO EXCEPTIONS

`;
    }

    languageInstruction += `🔧 TOOL USAGE RULE 🔧
When you use a tool successfully:
- Acknowledge what you did in your response
- Be honest about tool capabilities
- NEVER say you "can't" do something if you have a tool for it

`;

    let systemMessage = languageInstruction + baseSystemPrompt;

    if (req.user) {
      // Get user's name from Oxy
      try {
        const user = await oxyClient.getUserById(req.user.id) as any;
        console.log('[V1/Chat] User data from Oxy:', { id: req.user.id, name: user?.name, username: user?.username });
        const userName = user?.name?.full || user?.name?.first || user?.username;
        if (userName) {
          systemMessage += `\n\nThe user's name is ${userName}.`;
          console.log('[V1/Chat] Added user name to system message:', userName);
        }
      } catch (e: any) {
        console.error('[V1/Chat] Error fetching user from Oxy:', e.message);
      }
      systemMessage += '\n\n**IMPORTANT**: You have a `sendTelegram` tool available. Use it IMMEDIATELY when the user asks you to send them a Telegram message (e.g., "send me X on Telegram", "enviame un telegram", "remind me via Telegram"). Do NOT say you can\'t - you CAN send Telegram messages using this tool!';
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

    // Replace or inject system message
    const rawMessages = [...messages];
    if (rawMessages.length === 0 || rawMessages[0].role !== 'system') {
      // No system message, add ours at the start
      rawMessages.unshift({ role: 'system', content: systemMessage });
    } else {
      // Replace client's system message with our complete one (which already includes client context)
      rawMessages[0] = { role: 'system', content: systemMessage };
    }

    // Estimate system prompt tokens (for credit calculation)
    const systemPromptTokens = estimateMessageTokens('system', systemMessage);
    console.log(`[V1/Chat] Estimated system prompt tokens: ${systemPromptTokens}`);

    // Convert OpenAI-format messages to AI SDK format (handles tool messages)
    const convertedMessages = convertToAISDKMessages(rawMessages, toolNameMapping);
    console.log(`[V1/Chat] Converted ${rawMessages.length} messages to AI SDK format`);
    console.log(`[V1/Chat] System message preview:`, rawMessages[0]?.content?.substring(0, 500));

    // Track token usage
    let tokenUsage: CreditUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      systemPromptTokens,
    };

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const streamConfig: any = {
      model,
      messages: convertedMessages,
      temperature: body.temperature ?? 0.7,
      tools: allTools,
      onFinish: async (result: any) => {
        // Capture token usage from AI SDK
        if (result.usage) {
          tokenUsage = {
            promptTokens: result.usage.inputTokens || 0,
            completionTokens: result.usage.outputTokens || 0,
            totalTokens: result.usage.totalTokens || 0,
            systemPromptTokens, // Keep our estimated system prompt tokens
          };
          console.log('[V1/Chat] Token usage captured:', tokenUsage);
        }
      },
    };

    if (body.max_tokens) {
      streamConfig.maxTokens = body.max_tokens;
    }

    // Enable thinking mode for Anthropic if requested
    if (thinkingMode && resolved.provider === 'anthropic') {
      streamConfig.experimental_thinking = true;
      console.log('[V1/Chat] Enabled Anthropic thinking mode');
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

    console.log('[V1/Chat] AI SDK stream config:', JSON.stringify({
      modelProvider: resolved.provider,
      model: resolved.keyConfig.modelId,
      messageCount: streamConfig.messages.length,
      hasTools: !!streamConfig.tools,
      toolCount: streamConfig.tools ? Object.keys(streamConfig.tools).length : 0,
      temperature: streamConfig.temperature,
      maxTokens: streamConfig.maxTokens
    }, null, 2));
    console.log('[V1/Chat] Messages:', JSON.stringify(streamConfig.messages.map((m: any) => ({
      role: m.role,
      contentLength: typeof m.content === 'string' ? m.content.length : (Array.isArray(m.content) ? m.content.length : 0),
      hasToolCalls: !!m.toolCalls
    })), null, 2));

    const result = streamText(streamConfig);

    // Stream OpenAI-compatible chunks
    console.log('[V1/Chat] Starting to process AI SDK stream...');
    let chunkCount = 0;
    let assistantResponse = ''; // Track assistant's response for conversation save
    for await (const chunk of result.fullStream) {
      chunkCount++;
      console.log(`[V1/Chat] Chunk ${chunkCount} type:`, chunk.type);
      console.log(`[V1/Chat] Chunk ${chunkCount} full:`, JSON.stringify(chunk, null, 2));

      if (chunk.type === 'text-delta' && chunk.text) {
        // Extract <thinking> tags for chain-of-thought (Anthropic, DeepSeek, etc.)
        const thinkingMatch = chunk.text.match(/<thinking>([\s\S]*?)<\/thinking>/g);
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
        const filtered = chunk.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
        if (filtered) {
          assistantResponse += filtered; // Accumulate response for conversation save
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

        // Log the tool call arguments being sent to the client
        console.log(`[V1/Chat] Streaming tool call: ${originalToolName}, args:`, JSON.stringify(chunk.input));

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
      } else if (chunk.type === 'start') {
        console.log('[V1/Chat] Stream started');
      } else if (chunk.type === 'start-step') {
        console.log('[V1/Chat] Step started');
      } else if (chunk.type === 'text-start') {
        console.log('[V1/Chat] Text generation started');
      } else if (chunk.type === 'text-end') {
        console.log('[V1/Chat] Text generation ended');
      } else if (chunk.type === 'finish-step') {
        console.log('[V1/Chat] Step finished');
        // Log usage from finish-step if available
        if ((chunk as any).usage) {
          console.log('[V1/Chat] Step usage:', (chunk as any).usage);
        }
      } else if (chunk.type === 'error') {
        console.error('[V1/Chat] Error chunk received:', (chunk as any).error);
        const errorMessage = (chunk as any).error?.message || (chunk as any).error || 'Unknown error';
        const errorChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: aliasModelId,
          choices: [{
            index: 0,
            delta: {
              content: `\n\n⚠️ Error: ${errorMessage}`
            },
            finish_reason: 'error'
          }]
        };
        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
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

    // Auto-save conversation if conversationId provided and user is authenticated
    if (conversationId && typeof conversationId === 'string' && conversationId.trim() && req.user && assistantResponse) {
      try {
        // Build complete messages array (user messages + assistant response)
        const allMessages = [
          ...messages.filter(m => m && m.role).map((m: any) => ({
            role: m.role,
            content: m.content,
            toolInvocations: m.toolInvocations
          })),
          {
            role: 'assistant',
            content: assistantResponse,
          }
        ].filter(msg => msg != null && msg.role && msg.content !== undefined);

        // Extract title from assistant response if present
        let title: string | undefined;
        const titleMatch = assistantResponse.match(/\[TITLE\](.*?)\[\/TITLE\]/);
        if (titleMatch) {
          title = titleMatch[1].trim();
          console.log(`[V1/Chat] Extracted conversation title: "${title}"`);
        }

        // Save or update conversation
        await Conversation.findOneAndUpdate(
          { oxyUserId: req.user.id, conversationId: conversationId },
          {
            conversationId: conversationId,
            oxyUserId: req.user.id,
            messages: allMessages,
            ...(title && { title }),
            updatedAt: new Date(),
          },
          { upsert: true, new: true }
        );

        console.log(`[V1/Chat] Conversation ${conversationId} saved successfully${title ? ` with title: "${title}"` : ''}`);
      } catch (error) {
        console.error('[V1/Chat] Error saving conversation:', error);
        console.error('[V1/Chat] ConversationId:', conversationId);
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
            system_prompt_tokens: tokenUsage.systemPromptTokens || 0,
            billable_tokens: Math.max(0, tokenUsage.totalTokens - (tokenUsage.systemPromptTokens || 0)),
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
    const stack = e instanceof Error ? e.stack : undefined;
    console.error('❌ [V1/Chat] Stack:', stack);

    if (!res.headersSent) {
      res.status(500).json({ error: message });
    } else {
      // Headers already sent (streaming started), send error as SSE chunk
      const errorChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'alia-v1',
        choices: [{
          index: 0,
          delta: {
            content: `\n\n⚠️ Error: ${message}`
          },
          finish_reason: 'error'
        }]
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
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
