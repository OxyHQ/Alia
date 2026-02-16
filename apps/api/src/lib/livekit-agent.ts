/**
 * LiveKit Agent Bridge
 *
 * Joins a LiveKit room as an agent participant and bridges audio
 * between LiveKit audio tracks and a provider WebSocket (OpenAI/Grok Realtime API).
 *
 * Audio flow:
 *   User mic (LiveKit track) → PCM16 base64 → Provider WebSocket
 *   Provider WebSocket → PCM16 base64 → LiveKit AudioSource → Room
 *
 * Data flow:
 *   Transcripts, agent state, cohost events → LiveKit data channel → Client
 */

import {
  Room,
  RoomEvent,
  AudioSource,
  LocalAudioTrack,
  AudioFrame,
  AudioStream,
  TrackPublishOptions,
  TrackSource,
  TrackKind,
} from '@livekit/rtc-node';
import type WebSocket from 'ws';
import type { AgentDataMessage, LiveKitAgentBridgeRef } from '../internal/providers/lib/types-voice.js';
import { log } from './logger.js';

const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;

export class LiveKitAgentBridge implements LiveKitAgentBridgeRef {
  private room: Room;
  private audioSource: AudioSource | null = null;
  private audioTrack: LocalAudioTrack | null = null;
  private audioStreamReader: ReadableStreamDefaultReader<AudioFrame> | null = null;
  private identity: string;
  private connected = false;
  private capturedFrameCount = 0;
  private publishedFrameCount = 0;
  private publishChain: Promise<void> = Promise.resolve();

  /** Callback invoked when user audio frames arrive from LiveKit */
  onUserAudioFrame: ((base64Pcm16: string) => void) | null = null;

  /** Callback invoked when client sends a data message */
  onClientData: ((data: any) => void) | null = null;

  /** Callback invoked when the user participant disconnects */
  onUserDisconnected: (() => void) | null = null;

  constructor(identity: string) {
    this.identity = identity;
    this.room = new Room();
  }

  /**
   * Join a LiveKit room as an agent participant.
   */
  async join(url: string, token: string): Promise<void> {
    log.providers.info({ identity: this.identity }, 'LiveKit agent joining room');

    await this.room.connect(url, token, { autoSubscribe: true });
    this.connected = true;

    log.providers.info({
      identity: this.identity,
      remoteParticipants: this.room.remoteParticipants.size,
      localParticipant: this.room.localParticipant?.identity,
    }, '[Voice] Agent connected to room');

    // Set up audio output (agent → room)
    this.audioSource = new AudioSource(SAMPLE_RATE, NUM_CHANNELS);
    this.audioTrack = LocalAudioTrack.createAudioTrack(`${this.identity}-audio`, this.audioSource);
    const pubOptions = new TrackPublishOptions();
    pubOptions.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(this.audioTrack, pubOptions);

    log.providers.info({ identity: this.identity }, 'LiveKit agent published audio track');

    // Listen for remote audio tracks (user's microphone)
    this.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      log.providers.info({ kind: track.kind, participant: participant.identity, identity: this.identity }, '[Voice] TrackSubscribed event');
      // Only subscribe to audio from non-agent participants
      if (track.kind === TrackKind.KIND_AUDIO && !participant.identity.startsWith('alia-')) {
        this.startAudioCapture(track, participant.identity);
      }
    });

    // Log when participants join
    this.room.on(RoomEvent.ParticipantConnected, (participant) => {
      log.providers.info({ participant: participant.identity, identity: this.identity }, '[Voice] Participant connected to room');
    });

    // Listen for data messages from client
    this.room.on(RoomEvent.DataReceived, (data, participant) => {
      if (!participant || participant.identity === this.identity) return;
      try {
        const message = JSON.parse(new TextDecoder().decode(data));
        this.onClientData?.(message);
      } catch {
        // Ignore non-JSON data
      }
    });

    // Listen for participant disconnect
    this.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      // If the user (non-agent) disconnects, notify
      if (!participant.identity.startsWith('alia-')) {
        log.providers.info({ participant: participant.identity }, 'User disconnected from LiveKit room');
        this.onUserDisconnected?.();
      }
    });

    // Also check for already-connected participants with audio tracks
    for (const [, participant] of this.room.remoteParticipants) {
      if (participant.identity.startsWith('alia-')) continue;
      for (const [, publication] of participant.trackPublications) {
        if (publication.track && publication.track.kind === TrackKind.KIND_AUDIO) {
          this.startAudioCapture(publication.track, participant.identity);
        }
      }
    }
  }

  /**
   * Start capturing audio frames from a remote participant's track
   * and forwarding them as base64 PCM16 to the provider.
   */
  private async startAudioCapture(track: any, participantIdentity: string): Promise<void> {
    log.providers.info({ participant: participantIdentity, identity: this.identity }, 'Subscribing to audio track');

    const audioStream = new AudioStream(track, { sampleRate: SAMPLE_RATE, numChannels: NUM_CHANNELS });
    this.audioStreamReader = audioStream.getReader();

    try {
      while (true) {
        const { done, value } = await this.audioStreamReader.read();
        if (done || !this.connected) break;

        // Convert Int16Array to base64 PCM16
        const buffer = Buffer.from(value.data.buffer, value.data.byteOffset, value.data.byteLength);
        const base64 = buffer.toString('base64');
        if (this.capturedFrameCount === 0) {
          log.providers.info({ participant: participantIdentity, bufferSize: buffer.length }, '[Voice] First audio frame received from user');
        }
        this.capturedFrameCount++;
        this.onUserAudioFrame?.(base64);
      }
    } catch (err: any) {
      if (this.connected) {
        log.providers.error({ err, identity: this.identity }, 'Error reading audio stream');
      }
    }
  }

  /**
   * Push AI audio (from provider) to the LiveKit room.
   * Input: base64-encoded PCM16 audio at 24kHz mono.
   */
  async publishAudioFrame(base64Pcm16: string): Promise<void> {
    if (!this.audioSource || !this.connected) return;

    const buffer = Buffer.from(base64Pcm16, 'base64');
    const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
    const frame = new AudioFrame(int16, SAMPLE_RATE, NUM_CHANNELS, int16.length);

    if (this.publishedFrameCount === 0) {
      log.providers.info({ identity: this.identity, bufferSize: buffer.length }, '[Voice] Publishing first AI audio frame to LiveKit');
    }
    this.publishedFrameCount++;

    // Serialize captureFrame calls — concurrent calls cause InvalidState errors
    // because WebSocket 'message' events fire without waiting for async handlers
    this.publishChain = this.publishChain.then(async () => {
      if (!this.audioSource || !this.connected) return;
      try {
        await this.audioSource.captureFrame(frame);
      } catch {
        // Transient frame drop — non-fatal, audio continues
      }
    }).catch(() => {});
  }

  /**
   * Send a data message to all participants in the room (transcripts, state, etc.).
   */
  async publishData(data: object): Promise<void> {
    if (!this.connected || !this.room.localParticipant) return;

    const encoded = new TextEncoder().encode(JSON.stringify(data));
    await this.room.localParticipant.publishData(encoded, { reliable: true });
  }

  /**
   * Send a typed agent data message.
   */
  async sendAgentMessage(message: AgentDataMessage): Promise<void> {
    await this.publishData(message);
  }

  /**
   * Disconnect from the LiveKit room and clean up resources.
   */
  async disconnect(): Promise<void> {
    this.connected = false;
    this.publishChain = Promise.resolve();

    if (this.audioStreamReader) {
      try { this.audioStreamReader.cancel(); } catch {}
      this.audioStreamReader = null;
    }

    if (this.audioTrack) {
      try { await this.audioTrack.close(); } catch {}
      this.audioTrack = null;
    }

    if (this.audioSource) {
      try { await this.audioSource.close(); } catch {}
      this.audioSource = null;
    }

    try { await this.room.disconnect(); } catch {}

    log.providers.info({ identity: this.identity }, 'LiveKit agent disconnected');
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
