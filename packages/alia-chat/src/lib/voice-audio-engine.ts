/**
 * The web voice-call engine: one `AudioContext`, the microphone through
 * `getUserMedia` (echo cancellation, noise suppression, automatic gain), an
 * `AudioWorklet` that turns it into 24 kHz PCM16 frames, and a second
 * `AudioWorklet` that plays the answer from a jitter-buffered queue.
 *
 * Both worklets run in the same context, so the page's audio graph is one
 * stack. Whether Chrome's echo canceller removes Web Audio playback (it is
 * proven for audio played through an `RTCPeerConnection`) is a release gate of
 * ADR 0017 §4, measured on real hardware; the fallback it names (routing
 * playback through a local `RTCPeerConnection` loopback) is not built until the
 * measurement says it is needed.
 *
 * The worklets are one module served by Alia's web app (`./voice-worklets.ts`),
 * never a `blob:` URL a host's CSP would have to allow as script. Their numbers
 * (stream rate, frame size, prebuffer) are passed as `processorOptions`.
 */

import { levelOfPcm16, pcm16ToFloat } from './pcm';
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from './voice-protocol';
import { VOICE_WORKLETS_URL } from './voice-worklets';
import {
  VoiceAudioEngineError,
  type VoiceAudioEngine,
  type VoiceAudioEngineHandlers,
} from './voice-audio-engine-types';

export * from './voice-audio-engine-types';

/** Played before the first sample of a burst, so network jitter does not stutter it. */
const PREBUFFER_MS = 80;
/** A burst shorter than the prebuffer still plays once nothing more arrives for this long. */
const PREBUFFER_IDLE_MS = 100;

function deviceError(caught: unknown): VoiceAudioEngineError {
  const name = (caught as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return new VoiceAudioEngineError('mic-denied');
  return new VoiceAudioEngineError(
    'mic-unavailable',
    typeof name === 'string' ? name : 'The microphone could not be opened',
  );
}

/** Level of the RMS a worklet reported, on the dictation meter's dBFS scale. */
function levelOfRms(rms: number): number {
  if (rms <= 0) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(rms) + 60) / 60));
}

export function createVoiceAudioEngine(): VoiceAudioEngine {
  let context: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let capture: AudioWorkletNode | null = null;
  let playback: AudioWorkletNode | null = null;
  let stopped = false;
  let pendingFlush: ((value: { itemId: string; playedMs: number } | null) => void) | null = null;
  let lastProgress: { itemId: string; playedMs: number } | null = null;

  return {
    async start(handlers: VoiceAudioEngineHandlers): Promise<void> {
      const media = globalThis.navigator?.mediaDevices;
      const AudioContextCtor = globalThis.AudioContext;
      if (!media?.getUserMedia || !AudioContextCtor || !('AudioWorkletNode' in globalThis)) {
        throw new VoiceAudioEngineError('voice-unavailable');
      }
      try {
        stream = await media.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
      } catch (caught: unknown) {
        throw deviceError(caught);
      }
      if (stopped) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      context = new AudioContextCtor({ latencyHint: 'interactive' });
      try {
        await context.audioWorklet.addModule(VOICE_WORKLETS_URL);
      } catch {
        throw new VoiceAudioEngineError('voice-unavailable');
      }
      await context.resume().catch(() => undefined);

      const source = context.createMediaStreamSource(stream);
      capture = new AudioWorkletNode(context, 'alia-voice-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        processorOptions: {
          streamSampleRate: VOICE_SAMPLE_RATE,
          frameSamples: VOICE_FRAME_SAMPLES,
        },
      });
      capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (stopped) return;
        const pcm = new Uint8Array(event.data);
        handlers.onCaptureLevel(levelOfPcm16(pcm));
        handlers.onCaptureFrame(pcm);
      };
      source.connect(capture);

      playback = new AudioWorkletNode(context, 'alia-voice-playback', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [context.destination.channelCount || 2],
        processorOptions: {
          streamSampleRate: VOICE_SAMPLE_RATE,
          prebufferMs: PREBUFFER_MS,
          prebufferIdleMs: PREBUFFER_IDLE_MS,
        },
      });
      playback.port.onmessage = (event: MessageEvent) => {
        const message = event.data as
          | { type: 'started'; itemId: string }
          | { type: 'progress'; itemId: string | null; playedMs: number; rms: number }
          | { type: 'idle' }
          | { type: 'flushed'; itemId: string | null; playedMs: number | null };
        if (stopped) return;
        switch (message.type) {
          case 'started':
            handlers.onPlaybackStarted(message.itemId);
            return;
          case 'progress':
            lastProgress =
              message.itemId === null
                ? null
                : { itemId: message.itemId, playedMs: message.playedMs };
            handlers.onPlaybackLevel(levelOfRms(message.rms));
            return;
          case 'idle':
            handlers.onPlaybackLevel(0);
            handlers.onPlaybackIdle();
            return;
          case 'flushed': {
            const resolve = pendingFlush;
            pendingFlush = null;
            handlers.onPlaybackLevel(0);
            resolve?.(
              message.itemId === null || message.playedMs === null
                ? null
                : { itemId: message.itemId, playedMs: Math.round(message.playedMs) },
            );
          }
        }
      };
      playback.connect(context.destination);

      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', () => {
          if (!stopped) handlers.onError(new VoiceAudioEngineError('mic-unavailable'));
        });
      }
    },

    enqueue(itemId: string, pcm16: Uint8Array): void {
      if (stopped || playback === null) return;
      const samples = pcm16ToFloat(pcm16);
      playback.port.postMessage({ type: 'chunk', itemId, samples }, [samples.buffer]);
    },

    flush(): Promise<{ itemId: string; playedMs: number } | null> {
      if (stopped || playback === null) return Promise.resolve(null);
      const fallback = lastProgress;
      return new Promise((resolve) => {
        // The worklet answers within a render quantum; if the context is
        // suspended it never will, and the last progress report is the answer.
        const timer = setTimeout(() => {
          pendingFlush = null;
          resolve(
            fallback === null ? null : { ...fallback, playedMs: Math.round(fallback.playedMs) },
          );
        }, 250);
        pendingFlush = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        playback?.port.postMessage({ type: 'flush' });
      });
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      pendingFlush?.(null);
      pendingFlush = null;
      capture?.port.close();
      playback?.port.close();
      capture?.disconnect();
      playback?.disconnect();
      for (const track of stream?.getTracks() ?? []) track.stop();
      void context?.close().catch(() => undefined);
      capture = null;
      playback = null;
      stream = null;
      context = null;
    },
  };
}
