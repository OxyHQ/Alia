/**
 * The iOS / Android voice-call engine, on `react-native-audio-api` (Software
 * Mansion) — capture and playback in ONE native audio stack, because the
 * platform echo canceller only removes what that same stack plays (ADR 0017
 * §4). `expo-audio` cannot do this: its stream captures without echo
 * cancellation and it cannot play a PCM stream.
 *
 * - **iOS:** the audio session is `playAndRecord` in mode `voiceChat`, which is
 *   Apple's voice-processing path (echo cancellation, noise suppression, gain
 *   control), with the loudspeaker as default output and Bluetooth headsets
 *   allowed.
 * - **Android:** `react-native-audio-api` 0.13.6 opens its recorder through
 *   Oboe with the default input preset and exposes no `voiceCommunication`
 *   preset, so the platform echo canceller is NOT engaged by this engine. That
 *   is the Android AEC gate of ADR 0017 §4, to be measured on the Pixel 8a; if
 *   it fails, the ADR's fallback is a small Expo module of Alia's own around
 *   `AudioRecord(VOICE_COMMUNICATION)` behind this same interface.
 *
 * A new native build is required: the library's config plugin is in
 * `packages/app/app.json`.
 */

import {
  type AudioBufferQueueSourceNode,
  AudioContext,
  AudioManager,
  AudioRecorder,
} from 'react-native-audio-api';
import { floatToPcm16, levelOfPcm16, pcm16ToFloat } from './pcm';
import { pcmBytesToMs, VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from './voice-protocol';
import {
  VoiceAudioEngineError,
  type VoiceAudioEngine,
  type VoiceAudioEngineHandlers,
} from './voice-audio-engine-types';

export * from './voice-audio-engine-types';

/** Held before the first buffer of a burst, so network jitter does not stutter it. */
const PREBUFFER_MS = 80;
/** A burst shorter than that still plays once nothing more arrives for this long. */
const PREBUFFER_IDLE_MS = 100;

interface Queued {
  readonly id: string;
  readonly itemId: string;
  readonly ms: number;
  readonly level: number;
}

export function createVoiceAudioEngine(): VoiceAudioEngine {
  let context: AudioContext | null = null;
  let recorder: AudioRecorder | null = null;
  let player: AudioBufferQueueSourceNode | null = null;
  let handlers: VoiceAudioEngineHandlers | null = null;
  let stopped = false;

  /** Buffers handed to the player, oldest (playing) first. */
  let queued: Queued[] = [];
  /** Chunks held back until the prebuffer is full. */
  let pending: Array<{ itemId: string; pcm: Uint8Array }> = [];
  let pendingMs = 0;
  let prebufferTimer: ReturnType<typeof setTimeout> | null = null;
  /** The item playing now, how much of it has finished, and when its current buffer began. */
  let current: { itemId: string; playedMs: number; bufferStartedAt: number } | null = null;

  const beginBuffer = (entry: Queued): void => {
    if (context === null || handlers === null) return;
    if (current === null || current.itemId !== entry.itemId) {
      current = { itemId: entry.itemId, playedMs: 0, bufferStartedAt: context.currentTime };
      handlers.onPlaybackStarted(entry.itemId);
    } else {
      current.bufferStartedAt = context.currentTime;
    }
    handlers.onPlaybackLevel(entry.level);
  };

  const releasePlayer = (): void => {
    if (player === null) return;
    const old = player;
    player = null;
    old.onBufferEnded = null;
    try {
      old.clearBuffers();
      old.stop();
    } catch {
      // Already stopped.
    }
    old.disconnect();
  };

  /** A fresh player per burst: a queue source that ran dry is not relied on to resume. */
  const ensurePlayer = (): AudioBufferQueueSourceNode | null => {
    if (player !== null || context === null) return player;
    const node = context.createBufferQueueSource();
    node.connect(context.destination);
    node.onBufferEnded = ({ bufferId }) => {
      if (stopped || node !== player) return;
      const index = queued.findIndex((entry) => entry.id === bufferId);
      if (index === -1) return;
      const [ended] = queued.splice(index, 1);
      if (ended && current?.itemId === ended.itemId) current.playedMs += ended.ms;
      const next = queued[0];
      if (next !== undefined) {
        beginBuffer(next);
        return;
      }
      releasePlayer();
      handlers?.onPlaybackLevel(0);
      handlers?.onPlaybackIdle();
    };
    node.start();
    player = node;
    return node;
  };

  const push = (itemId: string, pcm: Uint8Array): void => {
    const node = ensurePlayer();
    if (node === null || context === null) return;
    const samples = pcm16ToFloat(pcm);
    if (samples.length === 0) return;
    const buffer = context.createBuffer(1, samples.length, VOICE_SAMPLE_RATE);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const id = node.enqueueBuffer(buffer);
    const entry: Queued = {
      id,
      itemId,
      ms: pcmBytesToMs(pcm.byteLength),
      level: levelOfPcm16(pcm),
    };
    queued.push(entry);
    if (queued.length === 1) beginBuffer(entry);
  };

  const releasePending = (): void => {
    if (prebufferTimer !== null) clearTimeout(prebufferTimer);
    prebufferTimer = null;
    const chunks = pending;
    pending = [];
    pendingMs = 0;
    for (const chunk of chunks) push(chunk.itemId, chunk.pcm);
  };

  return {
    async start(nextHandlers: VoiceAudioEngineHandlers): Promise<void> {
      handlers = nextHandlers;
      AudioManager.setAudioSessionOptions({
        iosCategory: 'playAndRecord',
        iosMode: 'voiceChat',
        iosOptions: ['defaultToSpeaker', 'allowBluetoothHFP'],
      });
      const permission = await AudioManager.requestRecordingPermissions().catch(() => 'Denied');
      if (permission !== 'Granted') throw new VoiceAudioEngineError('mic-denied');
      try {
        await AudioManager.setAudioSessionActivity(true);
      } catch {
        throw new VoiceAudioEngineError('mic-unavailable');
      }
      if (stopped) return;

      context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
      recorder = new AudioRecorder();
      const ready = recorder.onAudioReady(
        { sampleRate: VOICE_SAMPLE_RATE, bufferLength: VOICE_FRAME_SAMPLES, channelCount: 1 },
        ({ buffer }) => {
          if (stopped) return;
          const pcm = floatToPcm16(buffer.getChannelData(0));
          handlers?.onCaptureLevel(levelOfPcm16(pcm));
          handlers?.onCaptureFrame(pcm);
        },
      );
      if (ready.status === 'error')
        throw new VoiceAudioEngineError('mic-unavailable', ready.message);
      const started = await recorder.start();
      if (started.status === 'error')
        throw new VoiceAudioEngineError('mic-unavailable', started.message);
    },

    enqueue(itemId: string, pcm16: Uint8Array): void {
      if (stopped || context === null) return;
      if (player !== null) {
        push(itemId, pcm16);
        return;
      }
      pending.push({ itemId, pcm: pcm16 });
      pendingMs += pcmBytesToMs(pcm16.byteLength);
      if (prebufferTimer !== null) clearTimeout(prebufferTimer);
      if (pendingMs >= PREBUFFER_MS) releasePending();
      else prebufferTimer = setTimeout(releasePending, PREBUFFER_IDLE_MS);
    },

    async flush(): Promise<{ itemId: string; playedMs: number } | null> {
      if (prebufferTimer !== null) clearTimeout(prebufferTimer);
      prebufferTimer = null;
      pending = [];
      pendingMs = 0;
      const playing = current;
      const head = queued[0];
      let heard: { itemId: string; playedMs: number } | null = null;
      if (playing !== null && context !== null) {
        const intoBuffer =
          head !== undefined && head.itemId === playing.itemId
            ? Math.min(head.ms, Math.max(0, (context.currentTime - playing.bufferStartedAt) * 1000))
            : 0;
        heard = { itemId: playing.itemId, playedMs: Math.round(playing.playedMs + intoBuffer) };
      }
      queued = [];
      current = null;
      releasePlayer();
      handlers?.onPlaybackLevel(0);
      return heard;
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      if (prebufferTimer !== null) clearTimeout(prebufferTimer);
      releasePlayer();
      if (recorder !== null) {
        recorder.clearOnAudioReady();
        void recorder.stop().catch(() => undefined);
      }
      void context?.close().catch(() => undefined);
      void AudioManager.setAudioSessionActivity(false).catch(() => undefined);
      recorder = null;
      context = null;
      handlers = null;
      queued = [];
      pending = [];
    },
  };
}
