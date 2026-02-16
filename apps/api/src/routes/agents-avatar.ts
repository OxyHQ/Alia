import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateText } from 'ai';
import { authenticateToken } from '../middleware/auth.js';
import { resolveModel, getAIModel, reportModelUsage } from '../lib/chat-core.js';
import { getBestKeyForModel, recordKeyUsage, recordKeySuccess, recordKeyFailure } from '../internal/providers/lib/key-manager.js';
import { uploadToS3 } from '../lib/s3.js';
import { log } from '../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

// Load the static reference image once at startup
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMAGE_PATH = path.join(__dirname, '..', 'assets', 'agent-avatar-reference.png');

let referenceImageBase64: string | null = null;
try {
  const buf = fs.readFileSync(REFERENCE_IMAGE_PATH);
  referenceImageBase64 = buf.toString('base64');
  log.agents.info('Loaded agent avatar reference image');
} catch {
  log.agents.warn('No reference image found at assets/agent-avatar-reference.png — will generate from scratch');
}

/**
 * Describe the static reference image using an Alia vision model.
 * Result is cached since the image never changes.
 * Uses the internal provider system — no credits charged.
 */
let cachedReferenceDescription: string | null = null;

async function getReferenceDescription(): Promise<string> {
  if (cachedReferenceDescription) return cachedReferenceDescription;
  if (!referenceImageBase64) return '';

  const resolved = await resolveModel('alia-v1-vision');
  if (!resolved) {
    log.agents.warn('No vision model available for reference image description');
    return '';
  }

  try {
    const model = getAIModel(resolved.keyConfig);
    const startMs = Date.now();

    const result = await generateText({
      model,
      maxTokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Describe this image in detail for recreating it. Focus on: the person/character appearance (face shape, hair style, hair color, skin tone, facial features, expression, body type), the art style (realistic, cartoon, 3D, anime, etc.), the pose/angle, and background. Do NOT describe the clothing. Be very specific and concise (3-4 sentences max).',
            },
            {
              type: 'image',
              image: Buffer.from(referenceImageBase64!, 'base64'),
            },
          ],
        },
      ],
      maxRetries: 0,
    });

    await reportModelUsage(
      resolved.keyConfig.keyId,
      resolved.provider,
      resolved.modelId,
      true,
      Date.now() - startMs
    );

    cachedReferenceDescription = result.text || '';
    log.agents.info({ provider: resolved.provider, model: resolved.modelId }, 'Cached reference image description');
    return cachedReferenceDescription;
  } catch (err: any) {
    await reportModelUsage(
      resolved.keyConfig.keyId,
      resolved.provider,
      resolved.modelId,
      false,
      0,
      err?.message
    );
    log.agents.warn({ err }, 'Failed to describe reference image');
    return '';
  }
}

// POST /agents/avatar/generate - Generate an avatar for an agent
router.post('/generate', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { name, description } = req.body;

    if (!name || !description) {
      return res.status(400).json({ error: 'name and description are required' });
    }

    // Get an OpenAI key through the Alia provider system
    const keyConfig = await getBestKeyForModel('openai', 'dall-e-3');
    if (!keyConfig) {
      log.agents.error('No OpenAI keys available for image generation');
      return res.status(503).json({ error: 'Image generation service unavailable' });
    }

    // Build the generation prompt
    let imagePrompt: string;

    if (referenceImageBase64) {
      // Reference image mode: describe once (cached), then generate with outfit change
      const characterDescription = await getReferenceDescription();

      if (characterDescription) {
        imagePrompt = `Recreate this exact character as an avatar: ${characterDescription} ` +
          `Now dress this character as a "${name}" (${description}). ` +
          `Only change the outfit/clothing to match the role. Keep the same person, same face, same art style, same pose, same perspective, same image size. ` +
          `You can adjust skin tone if it fits the character better (but keep it consistent across the whole body). ` +
          `Add appropriate hair if needed. No logos. No added hands or extra body parts. ` +
          `The image should work as a circular social media profile picture. No text, letters, or words in the image.`;
      } else {
        imagePrompt = `Create a professional avatar/profile picture for an AI agent named "${name}". ` +
          `Agent description: ${description}. Style: Clean, modern digital art. ` +
          `The image should work as a circular social media profile picture. No text, letters, or words in the image.`;
      }
    } else {
      // No reference image on server: generate from scratch
      imagePrompt = `Create a professional avatar/profile picture for an AI agent named "${name}". ` +
        `Agent description: ${description}. Style: Clean, modern digital art. ` +
        `The image should work as a circular social media profile picture. No text, letters, or words in the image.`;
    }

    // Generate image via OpenAI DALL-E 3 (1024x1024 is the smallest DALL-E 3 supports)
    const generateRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keyConfig.key}`,
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: imagePrompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
        response_format: 'b64_json', // Get base64 directly, skip extra download step
      }),
    });

    if (!generateRes.ok) {
      const err = await generateRes.text();
      await recordKeyFailure(keyConfig.keyId, `DALL-E generation failed: ${generateRes.status}`);
      log.agents.error({ status: generateRes.status, err }, 'DALL-E image generation failed');
      return res.status(502).json({ error: 'Image generation failed' });
    }

    const generateData = await generateRes.json() as any;
    const b64Image = generateData.data?.[0]?.b64_json;

    if (!b64Image) {
      await recordKeyFailure(keyConfig.keyId, 'DALL-E returned no image data');
      return res.status(502).json({ error: 'Image generation returned no result' });
    }

    // Record successful generation
    await recordKeyUsage(keyConfig.keyId, 0, 'openai', 'dall-e-3');
    await recordKeySuccess(keyConfig.keyId);

    // Convert to buffer — upload as WebP for smaller S3 size
    const imageBuffer = Buffer.from(b64Image, 'base64');

    // Upload to S3
    const avatarUrl = await uploadToS3(
      imageBuffer,
      'avatar.webp',
      `agents/${req.user.id}`,
      'avatar'
    );

    res.json({ avatarUrl });
  } catch (error) {
    log.agents.error({ err: error }, 'Error generating agent avatar');
    res.status(500).json({ error: 'Failed to generate avatar' });
  }
});

export default router;
