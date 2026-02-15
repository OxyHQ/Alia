/**
 * Web Audio API pipeline for real-time voice capture and playback.
 *
 * Uses AudioWorklet processors for low-latency PCM16 conversion:
 * - Capture: microphone → AudioWorklet → PCM16 chunks
 * - Playback: PCM16 chunks → AudioWorklet → speakers
 *
 * Web-only. Native platforms should use expo-av or similar.
 */

import { pcm16ToBase64, base64ToPcm16, REALTIME_SAMPLE_RATE } from './audio-utils';

export interface AudioPipelineCallbacks {
  /** Called with base64-encoded PCM16 audio ready to send. */
  onCapturedAudio: (base64Pcm16: string) => void;
  /** Called with mic capture RMS level (0-1). */
  onCaptureLevel?: (level: number) => void;
  /** Called with playback RMS level (0-1). */
  onPlaybackLevel?: (level: number) => void;
}

export class AudioPipeline {
  private audioContext: AudioContext | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private playbackNode: AudioWorkletNode | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private callbacks: AudioPipelineCallbacks;
  private _isMuted = false;

  constructor(callbacks: AudioPipelineCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Initialize the audio pipeline: request mic, set up worklets.
   * Must be called after a user gesture (browser autoplay policy).
   */
  async start(): Promise<void> {
    // Create AudioContext at the Realtime API sample rate
    const ctx = new AudioContext({ sampleRate: REALTIME_SAMPLE_RATE });
    this.audioContext = ctx;

    // Load worklet processors
    await ctx.audioWorklet.addModule('/audio-processor.js');

    // Create worklet nodes
    this.captureNode = new AudioWorkletNode(ctx, 'audio-capture-processor');
    this.playbackNode = new AudioWorkletNode(ctx, 'audio-playback-processor');

    // Connect playback to speakers
    this.playbackNode.connect(ctx.destination);

    // Forward playback levels for visualization
    this.playbackNode.port.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'level') {
        this.callbacks.onPlaybackLevel?.(e.data.level);
      }
    };

    // Get microphone
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: REALTIME_SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Connect mic → capture worklet
    this.sourceNode = ctx.createMediaStreamSource(this.mediaStream);
    this.sourceNode.connect(this.captureNode);

    // Forward captured audio chunks and levels
    this.captureNode.port.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'audio' && !this._isMuted) {
        this.callbacks.onCapturedAudio(pcm16ToBase64(e.data.data));
      }
      if (e.data.type === 'level') {
        this.callbacks.onCaptureLevel?.(this._isMuted ? 0 : e.data.level);
      }
    };
  }

  /** Enqueue PCM16 audio (base64) for playback. */
  playAudio(base64Pcm16: string): void {
    if (!this.playbackNode) return;
    const pcm = base64ToPcm16(base64Pcm16);
    this.playbackNode.port.postMessage(
      { type: 'audio', data: pcm.buffer },
      [pcm.buffer],
    );
  }

  /** Clear the playback buffer (e.g. on interruption). */
  clearPlayback(): void {
    this.playbackNode?.port.postMessage({ type: 'clear' });
  }

  /** Mute/unmute the microphone capture. */
  setMuted(muted: boolean): void {
    this._isMuted = muted;
    // Also disable the media stream track for a visual mic indicator
    this.mediaStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }

  get isMuted(): boolean {
    return this._isMuted;
  }

  /** Tear down all audio resources. */
  destroy(): void {
    this.sourceNode?.disconnect();
    this.captureNode?.disconnect();
    this.playbackNode?.disconnect();

    this.mediaStream?.getTracks().forEach((t) => t.stop());

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }

    this.audioContext = null;
    this.captureNode = null;
    this.playbackNode = null;
    this.mediaStream = null;
    this.sourceNode = null;
  }
}
