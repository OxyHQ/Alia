/**
 * Show Pipeline — Orchestrates the multi-step show generation process.
 *
 * Steps:
 * 1. Generate script via LLM
 * 2. Assign voices to speakers
 * 3. Generate TTS audio for each dialogue segment (batched)
 * 4. Generate sound effects for SFX segments
 * 5. Concatenate all audio segments
 * 6. Upload final show to S3
 */

import { generateText } from 'ai';
import { Show, type IShow } from '../../models/show.js';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../chat-core.js';
import { callProviderAPI } from '../../internal/providers/lib/provider-api.js';
import { extractAudioUrl, downloadBinaryFromUrl } from '../../internal/providers/lib/digitalocean-async.js';
import { synthesizeSpeech } from '../synthesize-speech.js';
import { uploadToS3 } from '../s3.js';
import { reserveCredits, finalizeCredits } from '../credits-manager.js';
import { getOrCreateUserCredits } from '../user-credits-helpers.js';
import { sendNotification } from '../notification-service.js';
import { buildScriptSystemPrompt, buildScriptUserPrompt } from './script-prompt.js';
import { assignVoices } from './voice-roster.js';
import { concatenateAudioSegments } from './audio-concat.js';
import { log } from '../logger.js';
import { getSafeErrorMessage } from '../errors/sanitize.js';
import { getIO } from '../../socket.js';

// Max concurrent TTS calls to avoid rate limiting
const TTS_BATCH_SIZE = 3;

interface ShowScript {
  title: string;
  description: string;
  speakers: string[];
  segments: Array<{
    type: 'dialogue' | 'sfx' | 'transition';
    speaker: string;
    text: string;
    sfxPrompt?: string;
  }>;
}

/**
 * Emit progress update via Socket.IO.
 */
function emitProgress(userId: string, showId: string, data: {
  status: string;
  progress: number;
  currentStep: string;
  segmentIndex?: number;
  totalSegments?: number;
}) {
  const io = getIO();
  if (io) {
    io.to(`user:${userId}`).emit('show:progress', { showId, ...data });
  }
}

/**
 * Run the full show generation pipeline.
 */
export async function runShowPipeline(showId: string): Promise<void> {
  const show = await Show.findById(showId);
  if (!show) throw new Error(`Show ${showId} not found`);

  const userId = show.userId.toString();

  try {
    // Reserve credits
    await getOrCreateUserCredits(userId);
    const reservation = await reserveCredits(userId);
    if (!reservation) {
      await updateShow(show, { status: 'failed', error: 'Insufficient credits' });
      return;
    }

    // Step 1: Generate script
    await updateShow(show, { status: 'generating_script', progress: 5 });
    emitProgress(userId, showId, { status: 'generating_script', progress: 5, currentStep: 'Generating script...' });

    const script = await generateScript(show);
    if (!script) {
      await updateShow(show, { status: 'failed', error: 'Failed to generate show script' });
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      return;
    }

    // Step 2: Assign voices
    const speakers = assignVoices(
      script.speakers,
      show.format,
    );

    const indexedSegments = script.segments.map((seg, i) => ({
      ...seg,
      index: i,
      audioUrl: undefined as string | undefined,
      durationMs: undefined as number | undefined,
    }));

    await updateShow(show, {
      title: script.title || show.title,
      description: script.description || show.description,
      speakers,
      segments: indexedSegments,
      progress: 15,
    });

    emitProgress(userId, showId, { status: 'generating_audio', progress: 15, currentStep: 'Generating audio...' });

    // Step 3: Generate audio for each segment (batched)
    // Process dialogue (TTS) first, then SFX/transitions — prevents SFX timeouts
    // from poisoning the provider key pool before TTS completes.
    await updateShow(show, { status: 'generating_audio' });

    const totalSegments = indexedSegments.length;
    const segmentBuffers: Array<{ index: number; buffer: Buffer }> = [];

    const dialogueSegments = indexedSegments.filter(s => s.type === 'dialogue');
    const sfxSegments = indexedSegments.filter(s => s.type === 'sfx' || s.type === 'transition');
    const orderedSegments = [...dialogueSegments, ...sfxSegments];
    let completedCount = 0;

    for (let batchStart = 0; batchStart < orderedSegments.length; batchStart += TTS_BATCH_SIZE) {
      const batch = orderedSegments.slice(batchStart, batchStart + TTS_BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (segment) => {
          if (segment.type === 'dialogue') {
            return generateTTSSegment(segment.text, speakers, segment.speaker);
          } else if (segment.type === 'sfx' || segment.type === 'transition') {
            return generateSFXSegment(segment.sfxPrompt || 'short transition sound, 2 seconds');
          }
          return null;
        }),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const segment = batch[i];

        if (result.status === 'fulfilled' && result.value) {
          segmentBuffers.push({ index: segment.index, buffer: result.value.buffer });

          // Upload segment to S3 for individual access
          const segmentUrl = await uploadToS3(
            result.value.buffer,
            `segment.${result.value.format}`,
            `shows/${userId}/${showId}`,
            `segment-${segment.index}`,
          );
          indexedSegments[segment.index].audioUrl = segmentUrl;
        } else {
          log.general.warn({ segmentIndex: segment.index, reason: result.status === 'rejected' ? result.reason : 'null' },
            'Show segment generation failed, skipping');
        }
      }

      completedCount += batch.length;
      const progress = 15 + Math.round((completedCount / totalSegments) * 65);
      await updateShow(show, { segments: indexedSegments, progress });
      emitProgress(userId, showId, {
        status: 'generating_audio',
        progress,
        currentStep: 'Generating audio...',
        segmentIndex: completedCount,
        totalSegments,
      });
    }

    // Step 4: Concatenate
    await updateShow(show, { status: 'concatenating', progress: 82 });
    emitProgress(userId, showId, { status: 'concatenating', progress: 82, currentStep: 'Assembling show...' });

    // Sort buffers by index
    segmentBuffers.sort((a, b) => a.index - b.index);
    const orderedBuffers = segmentBuffers.map(s => s.buffer);

    let finalBuffer: Buffer;
    if (orderedBuffers.length === 0) {
      await updateShow(show, { status: 'failed', error: 'No audio segments were generated' });
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      return;
    } else if (orderedBuffers.length === 1) {
      finalBuffer = orderedBuffers[0];
    } else {
      finalBuffer = await concatenateAudioSegments(orderedBuffers);
    }

    // Step 5: Upload final show
    emitProgress(userId, showId, { status: 'concatenating', progress: 92, currentStep: 'Uploading show...' });

    const audioUrl = await uploadToS3(
      finalBuffer,
      'show.mp3',
      `shows/${userId}`,
      showId,
    );

    // Estimate duration from file size (~128kbps MP3)
    const estimatedDurationMs = Math.round((finalBuffer.length / (128 * 1024 / 8)) * 1000);

    // Charge credits: ~1 credit per 30 seconds of show + 2 for script gen
    const durationCredits = Math.max(1, Math.ceil(estimatedDurationMs / 30000));
    const totalCredits = durationCredits + 2;

    await finalizeCredits(reservation, {
      promptTokens: totalCredits * 50,
      completionTokens: 0,
      totalTokens: totalCredits * 50,
    });

    await updateShow(show, {
      status: 'completed',
      audioUrl,
      durationMs: estimatedDurationMs,
      segments: indexedSegments,
      creditsCharged: totalCredits,
      progress: 100,
    });

    emitProgress(userId, showId, { status: 'completed', progress: 100, currentStep: 'Done!' });

    // Send notification
    await sendNotification({
      userId,
      type: 'agent_task_complete',
      title: 'Show Ready',
      body: `Your show "${script.title || show.title}" is ready to listen.`,
      data: { showId, audioUrl },
    }).catch(err => {
      log.general.warn({ err }, 'Failed to send show completion notification');
    });

  } catch (error: unknown) {
    log.general.error({ err: error, showId }, 'Show pipeline failed');
    await updateShow(show, {
      status: 'failed',
      error: getSafeErrorMessage(error, 'Show generation failed'),
    });
    emitProgress(userId, showId, { status: 'failed', progress: 0, currentStep: 'Failed' });
  }
}

/**
 * Generate a show script using an LLM.
 */
async function generateScript(show: IShow): Promise<ShowScript | null> {
  const MAX_RETRIES = 3;
  const skipProviders = new Set<string>();

  const targetMinutes = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const resolved = await resolveModel(getDefaultAliaModel(), skipProviders);
    if (!resolved) break;

    try {
      const model = getAIModel(resolved.keyConfig);
      const result = await generateText({
        model,
        messages: [
          {
            role: 'system',
            content: buildScriptSystemPrompt(show.format),
          },
          {
            role: 'user',
            content: buildScriptUserPrompt(
              show.topic,
              targetMinutes,
              show.sourceNotes || undefined,
            ),
          },
        ],
        temperature: 0.8,
        maxRetries: 0,
      });

      const text = result.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log.general.warn({ text: text.slice(0, 200) }, 'No JSON in show script response');
        skipProviders.add(resolved.provider);
        continue;
      }

      const parsed = JSON.parse(jsonMatch[0]) as ShowScript;

      // Validate minimum structure
      if (!parsed.segments || !Array.isArray(parsed.segments) || parsed.segments.length < 3) {
        log.general.warn('Show script has too few segments');
        skipProviders.add(resolved.provider);
        continue;
      }

      if (!parsed.speakers || !Array.isArray(parsed.speakers) || parsed.speakers.length === 0) {
        // Try to extract speaker names from segments
        const speakerSet = new Set(
          parsed.segments.filter(s => s.type === 'dialogue' && s.speaker).map(s => s.speaker),
        );
        parsed.speakers = Array.from(speakerSet);
      }

      return parsed;
    } catch (err: unknown) {
      log.general.error({ err, provider: resolved.provider, attempt }, 'Script generation failed');
      skipProviders.add(resolved.provider);
    }
  }

  return null;
}

interface SegmentAudio {
  buffer: Buffer;
  format: string;
}

/**
 * Generate TTS audio for a single dialogue segment via the shared multi-provider
 * synthesis path (same fail-over the read-aloud endpoint uses).
 */
async function generateTTSSegment(
  text: string,
  speakers: Array<{ name: string; voiceId: string }>,
  speakerName: string,
): Promise<SegmentAudio | null> {
  const speaker = speakers.find(s => s.name === speakerName);
  if (!speaker) {
    log.general.warn({ speakerName }, 'Speaker not found in roster');
    return null;
  }

  const synthesized = await synthesizeSpeech({ input: text, voice: speaker.voiceId, format: 'mp3' });
  return synthesized ? { buffer: synthesized.audio, format: synthesized.format } : null;
}

/**
 * Generate a sound effect segment.
 */
async function generateSFXSegment(prompt: string): Promise<SegmentAudio | null> {
  try {
    const sfxOutput = await callProviderAPI<any>({
      provider: 'digitalocean',
      modelId: 'fal-ai/stable-audio-25/text-to-audio',
      endpoint: '/v1/async-invoke',
      body: {
        input: {
          prompt,
          seconds_total: 5,
        },
      },
      timeout: 170_000, // fal-ai audio gen: queue + cold start + synthesis can take 60-90s
      maxAttempts: 1,
    });

    const audioUrl = extractAudioUrl(sfxOutput);
    if (!audioUrl) return null;

    return { buffer: await downloadBinaryFromUrl(audioUrl), format: 'mp3' };
  } catch (err: unknown) {
    log.general.warn({ err, prompt }, 'SFX generation failed');
    return null;
  }
}

/**
 * Update show document with partial data.
 */
async function updateShow(show: IShow, data: Partial<IShow>): Promise<void> {
  Object.assign(show, data);
  await show.save();
}
