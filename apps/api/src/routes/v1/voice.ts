import { Router } from 'express';
import { randomUUID } from 'crypto';
import { createVoiceToken, isLiveKitConfigured, getLiveKitUrl } from '../../lib/livekit-token.js';
import { resolveModel } from '../../lib/chat-core.js';
import { getBestKeyForModel } from '../../internal/providers/lib/key-manager.js';
import { reserveCredits, finalizeCredits } from '../../lib/credits-manager.js';
import { UserCredits } from '../../models/user-credits.js';
import type { Request, Response } from 'express';

const router = Router();

/**
 * POST /v1/voice/token
 * Get a LiveKit token to join a voice room
 */
router.post('/token', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!isLiveKitConfigured()) {
      return res.status(503).json({ error: 'Voice mode is not available. LiveKit is not configured.' });
    }

    const { conversationId } = req.body;
    const roomName = `voice-${conversationId || randomUUID()}`;

    const token = await createVoiceToken(userId, roomName);

    res.json({
      token,
      url: getLiveKitUrl(),
      roomName,
    });
  } catch (error: any) {
    console.error('[Voice] Token error:', error);
    res.status(500).json({ error: error.message || 'Failed to create voice token' });
  }
});

/**
 * POST /v1/voice/transcribe
 * Speech-to-text transcription using OpenAI Whisper API
 */
router.post('/transcribe', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { audio, format } = req.body as { audio?: string; format?: string };
    if (!audio) {
      return res.status(400).json({ error: 'Audio data is required (base64 encoded)' });
    }

    // Ensure user has credits
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
      return res.status(402).json({ error: 'Insufficient credits' });
    }

    // Find an OpenAI key for Whisper
    let apiKey: string | null = null;
    try {
      const resolved = await resolveModel('alia-v1');
      if (resolved?.keyConfig.provider === 'openai') {
        apiKey = resolved.keyConfig.key;
      }
    } catch {}

    // Try fetching an OpenAI key directly from providers
    if (!apiKey) {
      try {
        const openaiKey = await getBestKeyForModel('openai', 'whisper-1');
        if (openaiKey?.key) {
          apiKey = openaiKey.key;
        }
      } catch {}
    }

    // Fallback to env var
    if (!apiKey) {
      apiKey = process.env.OPENAI_API_KEY || null;
    }

    if (!apiKey) {
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      return res.status(503).json({ error: 'No transcription provider available' });
    }

    // Convert base64 to buffer
    const audioBuffer = Buffer.from(audio, 'base64');
    const mimeType = format || 'audio/m4a';
    const ext = mimeType.split('/')[1] || 'm4a';

    // Call OpenAI Whisper API
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    formData.append('file', blob, `audio.${ext}`);
    formData.append('model', 'whisper-1');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('[Voice] Whisper API error:', errorBody);
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      return res.status(502).json({ error: 'Transcription failed' });
    }

    const result = await response.json() as { text: string };

    // Charge minimal credits for transcription (~100 tokens equivalent)
    await finalizeCredits(reservation, {
      promptTokens: 50,
      completionTokens: 50,
      totalTokens: 100,
    });

    res.json({ text: result.text });
  } catch (error: any) {
    console.error('[Voice] Transcribe error:', error);
    res.status(500).json({ error: error.message || 'Transcription failed' });
  }
});

export default router;
