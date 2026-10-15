import { vi } from 'vitest';
import type { VoiceSocket } from '../../src/lib/voice-call';
import {
  VoiceAudioEngineError,
  type VoiceAudioEngine,
  type VoiceAudioEngineErrorCode,
  type VoiceAudioEngineHandlers,
} from '../../src/lib/voice-audio-engine-types';
import { encodeAssistantAudioFrame } from '../../src/lib/voice-protocol';

/**
 * A socket the test drives by hand: what the client sent is in `sent`, and
 * the server's frames are delivered with `receive` / `receiveAudio`.
 */
export class FakeSocket implements VoiceSocket {
  binaryType = 'blob';
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: Array<string | Uint8Array> = [];
  readonly close = vi.fn(() => {
    this.readyState = 3;
  });

  constructor(readonly url: string) {}

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === 'string') this.sent.push(data);
    else if (ArrayBuffer.isView(data))
      this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    else this.sent.push(new Uint8Array(data as ArrayBuffer));
  }

  /** The server accepted the connection. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(event: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  receiveAudio(itemId: string, pcm: Uint8Array): void {
    const frame = encodeAssistantAudioFrame(itemId, pcm);
    this.onmessage?.({ data: frame.buffer });
  }

  /** The network dropped it, without a `session.closed`. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  /** The JSON events the client sent, parsed. */
  events(): Array<Record<string, unknown>> {
    return this.sent
      .filter((frame): frame is string => typeof frame === 'string')
      .map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }

  /** The binary (microphone) frames the client sent. */
  audio(): Uint8Array[] {
    return this.sent.filter((frame): frame is Uint8Array => typeof frame !== 'string');
  }
}

/**
 * An audio engine with no device behind it: the test captures frames, makes
 * an item start playing, and decides what a flush reports as heard.
 */
export class FakeEngine implements VoiceAudioEngine {
  handlers: VoiceAudioEngineHandlers | null = null;
  readonly enqueued: Array<{ itemId: string; bytes: number }> = [];
  failWith: VoiceAudioEngineErrorCode | null = null;
  heard: { itemId: string; playedMs: number } | null = null;
  flushes = 0;
  stopped = false;

  async start(handlers: VoiceAudioEngineHandlers): Promise<void> {
    if (this.failWith !== null) throw new VoiceAudioEngineError(this.failWith);
    this.handlers = handlers;
  }

  enqueue(itemId: string, pcm16: Uint8Array): void {
    this.enqueued.push({ itemId, bytes: pcm16.byteLength });
  }

  async flush(): Promise<{ itemId: string; playedMs: number } | null> {
    this.flushes += 1;
    const heard = this.heard;
    this.heard = null;
    return heard;
  }

  stop(): void {
    this.stopped = true;
  }

  /** The microphone delivered a frame of ~40 ms. */
  capture(level = 0.3): void {
    this.handlers?.onCaptureLevel(level);
    this.handlers?.onCaptureFrame(new Uint8Array(1920));
  }

  /** The first sample of `itemId` is playing. */
  play(itemId: string): void {
    this.handlers?.onPlaybackStarted(itemId);
  }

  /** The queue ran dry. */
  drain(): void {
    this.handlers?.onPlaybackIdle();
  }
}

/** Let promise callbacks (the engine's start, a flush) settle. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}
