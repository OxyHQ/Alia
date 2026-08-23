import { Router, Request, Response, NextFunction } from 'express';
import { log } from '../../lib/logger.js';

const router = Router();

/**
 * POST /v1/responses
 * OpenAI Responses API adapter - converts to Chat Completions format
 * This allows Vercel AI SDK to work without needing .chat() method
 *
 * Simply converts the request format and forwards to /v1/chat/completions
 */
router.post('/', (req: Request, res: Response, next: NextFunction) => {
  log.v1.info('Request received, converting to chat completions format');

  const body = req.body;

  // Convert Responses API format to Chat Completions format
  // Responses API uses "input" (array of Items), Chat Completions uses "messages"
  let messages: any[] = [];

  if (body.input) {
    // Handle Responses API input format
    if (typeof body.input === 'string') {
      // Simple string input
      messages = [{ role: 'user', content: body.input }];
    } else if (Array.isArray(body.input)) {
      // Array of items - convert to messages format
      messages = body.input.map((item: any) => {
        if (typeof item === 'string') {
          return { role: 'user', content: item };
        } else if (item.type === 'message' || item.role) {
          // Already message-like format
          return {
            role: item.role || 'user',
            content: item.content || item.text || ''
          };
        } else if (item.type === 'text') {
          return { role: 'user', content: item.text };
        }
        // Fallback: treat as user message
        return { role: 'user', content: JSON.stringify(item) };
      });
    }
  } else if (body.messages) {
    // Already in chat completions format (some SDKs send this)
    messages = body.messages;
  }

  if (messages.length === 0) {
    return res.status(400).json({
      error: {
        message: 'Invalid input: expected "input" array or "messages" array',
        type: 'invalid_request_error',
        code: 'invalid_input'
      }
    });
  }

  // Convert request body to chat completions format
  req.body = {
    /**
     * Passed through UNRESOLVED, so the default is applied once, downstream.
     *
     * This restated `|| 'alia-v1'` while `lib/chat/request-context.ts` applies
     * `getDefaultAliaModel()`, which answers `alia-lite`. The two are a 2x
     * credit multiplier apart, so the identical "no model named" request was
     * billed at twice the rate for choosing this endpoint over
     * `/v1/chat/completions` — and this endpoint forwards INTO that one, so the
     * divergence was invisible from either side alone.
     *
     * Not reconciled by restating the owner's value here: a second copy of a
     * default is the thing that diverged in the first place. `undefined`
     * reaches the one site that owns it, and there is now nothing to keep in
     * step. `lib/__tests__/defaultChatModel.test.ts` no longer carries a census
     * line for this file, because there is no longer a literal to freeze.
     */
    model: body.model,
    messages,
    temperature: body.temperature,
    max_tokens: body.max_tokens || body.max_output_tokens,
    stream: body.stream !== false, // Default to streaming
    tools: body.tools,
    // Pass through Alia-specific params
    conversationId: body.conversationId,
    reasoningEffort: body.reasoningEffort,
    // The boolean spelling of the same intent, still sent by every published
    // SDK copy in the wild. `reasoningEffortOf` is where the two meet.
    thinkingMode: body.thinkingMode,
    webSearch: body.webSearch,
    mcpServerId: body.mcpServerId,
  };

  log.v1.info({ messageCount: messages.length, model: req.body.model, stream: req.body.stream }, 'Responses API converted to chat completions format');

  // Rewrite URL and forward to chat completions handler
  req.url = '/';
  req.originalUrl = '/v1/chat/completions';

  // Import and use the chat completions router
  import('./chat-completions.js').then(module => {
    module.default(req, res, next);
  }).catch(err => {
    log.v1.error({ err: err }, 'Error loading chat-completions');
    res.status(500).json({
      error: {
        message: 'Internal server error',
        type: 'internal_error',
        code: 'internal_error'
      }
    });
  });
});

export default router;
