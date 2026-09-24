/**
 * Speech out: ask `POST /v1/audio/speech` for a clip, and play one.
 *
 * Shared by read-aloud (`useTTS`) and voice mode (`useVoiceRoom`) so both speak
 * through the one route Alia has for it — Alia → Oxy → Kaana, billed by Oxy per
 * call — with the same request body and the same error copy. Voice names are
 * the PRODUCT's (`male` / `female`); the route maps them, and no upstream voice
 * name ever appears on this side.
 */

import { createAudioLevelMeter } from './audio-level';

export type ProductVoice = 'male' | 'female';

export interface SpeechClipRequest {
  readonly apiUrl: string;
  readonly token: string;
  /** The speech routing profile; the route accepts only its own. */
  readonly model: string;
  readonly input: string;
  readonly voice: ProductVoice;
  readonly speed?: number;
  /** Both or neither: the route stores the clip on that message when given. */
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly signal: AbortSignal;
}

/** Synthesize `input` and return the private link the route answers with. */
export async function requestSpeechClip(request: SpeechClipRequest): Promise<string> {
  const response = await fetch(`${request.apiUrl}/v1/audio/speech`, {
    method: 'POST',
    signal: request.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.token}`,
    },
    body: JSON.stringify({
      model: request.model,
      input: request.input,
      voice: request.voice,
      speed: request.speed,
      conversationId: request.conversationId,
      messageId: request.messageId,
    }),
  });

  if (!response.ok) {
    if (response.status === 504) {
      throw new Error('Request timed out — please try again');
    }
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || errData.error || 'TTS failed');
  }

  const data = (await response.json()) as { audioUrl?: unknown };
  request.signal.throwIfAborted();
  if (typeof data.audioUrl !== 'string' || data.audioUrl === '') throw new Error('TTS failed');
  return data.audioUrl;
}

export interface PlayClipOptions {
  readonly signal: AbortSignal;
  /** The clip's live level, 0..1, where the platform lets playback be sampled. */
  readonly onLevel?: (level: number) => void;
}

/**
 * Play one clip to its end.
 *
 * Resolves when it finishes or when `signal` aborts (the player is released
 * either way — an interrupted answer stops at once), and rejects if the player
 * reports an error. `crossOrigin` and sampling are set as `useTTS` sets them;
 * its comments explain why.
 */
export async function playSpeechClip(uri: string, options: PlayClipOptions): Promise<void> {
  const { signal, onLevel } = options;
  if (signal.aborted) return;
  const { createAudioPlayer } = await import('expo-audio');
  if (signal.aborted) return;

  const player = createAudioPlayer({ uri }, { crossOrigin: 'anonymous' });
  const release = (): void => {
    try {
      player.remove();
    } catch {
      // Already removed.
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => resolve();
      signal.addEventListener('abort', onAbort, { once: true });
      const settle = (settleWith: () => void): void => {
        signal.removeEventListener('abort', onAbort);
        settleWith();
      };

      if (onLevel !== undefined) {
        player.setAudioSamplingEnabled(true);
        const meter = createAudioLevelMeter();
        player.addListener('audioSampleUpdate', (sample) => {
          const frames = sample.channels[0]?.frames;
          if (frames === undefined) return;
          onLevel(meter.push(frames, Date.now()));
        });
      }
      player.addListener('playbackStatusUpdate', (status) => {
        if (status.error) {
          settle(() => reject(new Error(String(status.error))));
          return;
        }
        if (status.didJustFinish) settle(resolve);
      });
      player.play();
    });
  } finally {
    release();
    onLevel?.(0);
  }
}
