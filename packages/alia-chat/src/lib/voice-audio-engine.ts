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
 * The worklets are inline source turned into a Blob URL: the SDK ships raw
 * source and a host bundler would not emit a separate worklet file.
 */

import { levelOfPcm16, pcm16ToFloat } from './pcm';
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from './voice-protocol';
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

const CAPTURE_PROCESSOR = `
class AliaVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${VOICE_SAMPLE_RATE};
    this.t = 0;
    this.prev = 0;
    this.frame = new Int16Array(${VOICE_FRAME_SAMPLES});
    this.filled = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;
    const n = input.length;
    while (this.t < n - 1) {
      const i = Math.floor(this.t);
      const f = this.t - i;
      const a = i < 0 ? this.prev : input[i];
      const b = input[i + 1];
      let s = a + (b - a) * f;
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      this.frame[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === this.frame.length) {
        const out = this.frame;
        this.port.postMessage(out.buffer, [out.buffer]);
        this.frame = new Int16Array(${VOICE_FRAME_SAMPLES});
        this.filled = 0;
      }
      this.t += this.ratio;
    }
    this.t -= n;
    this.prev = input[n - 1];
    return true;
  }
}
registerProcessor('alia-voice-capture', AliaVoiceCapture);
`;

const PLAYBACK_PROCESSOR = `
class AliaVoicePlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = ${VOICE_SAMPLE_RATE} / sampleRate;
    this.queue = [];
    this.queued = 0;
    this.pos = 0;
    this.buffering = true;
    this.lastChunkAt = 0;
    this.item = null;
    this.played = 0;
    this.sinceReport = 0;
    this.sumSquares = 0;
    this.count = 0;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'chunk') {
        this.queue.push({ itemId: message.itemId, samples: message.samples });
        this.queued += message.samples.length;
        this.lastChunkAt = currentTime;
      } else if (message.type === 'flush') {
        const playedMs = this.item === null ? null : (this.played / ${VOICE_SAMPLE_RATE}) * 1000;
        this.port.postMessage({ type: 'flushed', itemId: this.item, playedMs });
        this.queue = [];
        this.queued = 0;
        this.pos = 0;
        this.buffering = true;
        this.item = null;
        this.played = 0;
      }
    };
  }
  report(force) {
    if (!force && this.sinceReport < sampleRate / 20) return;
    const rms = this.count === 0 ? 0 : Math.sqrt(this.sumSquares / this.count);
    this.port.postMessage({
      type: 'progress',
      itemId: this.item,
      playedMs: (this.played / ${VOICE_SAMPLE_RATE}) * 1000,
      rms,
    });
    this.sinceReport = 0;
    this.sumSquares = 0;
    this.count = 0;
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (this.buffering) {
      const ready =
        this.queued >= ${(VOICE_SAMPLE_RATE * PREBUFFER_MS) / 1000} ||
        (this.queued > 0 && currentTime - this.lastChunkAt > ${PREBUFFER_IDLE_MS / 1000});
      if (!ready) {
        out.fill(0);
        for (let c = 1; c < outputs[0].length; c++) outputs[0][c].fill(0);
        return true;
      }
      this.buffering = false;
    }
    for (let k = 0; k < out.length; k++) {
      const head = this.queue[0];
      if (!head) {
        out[k] = 0;
        if (!this.buffering) {
          this.buffering = true;
          this.report(true);
          this.port.postMessage({ type: 'idle' });
        }
        continue;
      }
      if (head.itemId !== this.item) {
        this.item = head.itemId;
        this.played = 0;
        this.port.postMessage({ type: 'started', itemId: head.itemId });
      }
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      const a = head.samples[i];
      const b = i + 1 < head.samples.length ? head.samples[i + 1] : a;
      const s = a + (b - a) * f;
      out[k] = s;
      this.sumSquares += s * s;
      this.count++;
      this.pos += this.step;
      const consumed = Math.floor(this.pos);
      if (consumed > 0) {
        const taken = Math.min(consumed, head.samples.length);
        this.played += taken;
        this.queued -= taken;
        if (consumed >= head.samples.length) {
          this.queue.shift();
          this.pos = 0;
        } else {
          head.samples = head.samples.subarray(consumed);
          this.pos -= consumed;
        }
      }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    this.sinceReport += out.length;
    this.report(false);
    return true;
  }
}
registerProcessor('alia-voice-playback', AliaVoicePlayback);
`;

function moduleUrl(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
}

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
      const captureUrl = moduleUrl(CAPTURE_PROCESSOR);
      const playbackUrl = moduleUrl(PLAYBACK_PROCESSOR);
      try {
        await context.audioWorklet.addModule(captureUrl);
        await context.audioWorklet.addModule(playbackUrl);
      } catch {
        throw new VoiceAudioEngineError('voice-unavailable');
      } finally {
        URL.revokeObjectURL(captureUrl);
        URL.revokeObjectURL(playbackUrl);
      }
      await context.resume().catch(() => undefined);

      const source = context.createMediaStreamSource(stream);
      capture = new AudioWorkletNode(context, 'alia-voice-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
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
