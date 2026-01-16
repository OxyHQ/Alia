import { Router, Request, Response } from 'express';
import { getBestAvailableKey, loadKeys } from '../../lib/load-balancer.js';
import { getProvider } from '../../lib/providers/index.js';
import type { OpenAIMessage, OpenAITool } from '../../lib/types.js';

const router = Router();

/**
 * POST /v1/chat/completions
 * OpenAI-compatible chat completions endpoint with streaming support
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    console.log('📬 [API/POST] Request received');
    const body = req.body;
    console.log('📦 [API/POST] Body:', JSON.stringify(body).slice(0, 100) + '...');

    // Validate messages
    if (!Array.isArray(body.messages) || !body.messages.length) {
      res.status(400).json({ error: 'Se requiere "messages"' });
      return;
    }

    // Get best available API key
    const keyPool = await loadKeys();
    const key = await getBestAvailableKey(keyPool);
    if (!key) {
      res.status(503).json({ error: 'Todos los proveedores saturados' });
      return;
    }

    // Get provider implementation
    const provider = getProvider(key.provider);
    if (!provider) {
      res.status(400).json({ error: `Proveedor "${key.provider}" no implementado` });
      return;
    }

    // Configure request
    const config = {
      temperature: body.temperature ?? 0.7,
      maxTokens: body.max_tokens || body.max_completion_tokens || 8192
    };

    // Get streaming response from provider
    const stream = await provider.proxy(
      key,
      body.messages as OpenAIMessage[],
      body.tools as OpenAITool[] | undefined,
      config
    );

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Pipe the stream to response
    const reader = stream.getReader();
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            break;
          }
          res.write(value);
        }
      } catch (error) {
        console.error('❌ [API/POST] Stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Stream error' });
        } else {
          res.end();
        }
      }
    };

    await pump();

  } catch (e: unknown) {
    console.error('❌ [API/POST] Error:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    if (!res.headersSent) {
      res.status(500).json({ error: message });
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
