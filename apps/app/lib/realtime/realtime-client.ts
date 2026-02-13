/**
 * Realtime API WebSocket client.
 *
 * Manages the WebSocket connection to the /v1/realtime endpoint,
 * which proxies to Grok, OpenAI, or other Realtime API-compatible providers.
 *
 * Follows the OpenAI Realtime API protocol:
 * - Client sends `input_audio_buffer.append` with base64 PCM16 audio
 * - Server sends `response.audio.delta` with base64 PCM16 audio
 * - Server handles VAD (voice activity detection) and turn management
 */

export type RealtimeEvent =
  | { type: 'session.created'; session: { id: string; model: string } }
  | { type: 'response.created' }
  | { type: 'response.audio.delta'; delta: string }
  | { type: 'response.audio.done' }
  | { type: 'response.text.delta'; delta: string }
  | { type: 'response.audio_transcript.delta'; delta: string }
  | { type: 'response.audio_transcript.done'; transcript: string }
  | { type: 'response.done' }
  | { type: 'conversation.item.input_audio_transcription.completed'; transcript: string }
  | { type: 'input_audio_buffer.speech_started' }
  | { type: 'input_audio_buffer.speech_stopped' }
  | { type: 'error'; error: { message: string; code?: string } }
  | { type: string; [key: string]: any };

export type RealtimeState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface RealtimeClientCallbacks {
  onStateChange: (state: RealtimeState) => void;
  onAudioDelta: (base64Pcm16: string) => void;
  onSpeechStarted: () => void;
  onSpeechStopped: () => void;
  onResponseCreated: () => void;
  onResponseDone: () => void;
  onError: (message: string) => void;
  onTranscriptDelta?: (delta: string) => void;
  onTranscriptDone?: (transcript: string) => void;
  onUserTranscriptCompleted?: (transcript: string) => void;
}

export interface RealtimeClientConfig {
  apiUrl: string;
  token: string;
  model?: string;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private callbacks: RealtimeClientCallbacks;
  private config: RealtimeClientConfig;

  constructor(config: RealtimeClientConfig, callbacks: RealtimeClientCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  /** Connect to the realtime endpoint. */
  connect(): void {
    if (this.ws) return;

    this.callbacks.onStateChange('connecting');

    const wsProtocol = this.config.apiUrl.startsWith('https') ? 'wss' : 'ws';
    const wsHost = this.config.apiUrl.replace(/^https?:\/\//, '');
    const model = this.config.model || 'alia-v1-voice';
    const url = `${wsProtocol}://${wsHost}/v1/realtime?model=${model}&token=${encodeURIComponent(this.config.token)}`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      console.log('[RealtimeClient] Connected');
      this.callbacks.onStateChange('connected');
    };

    ws.onclose = (event) => {
      console.log(`[RealtimeClient] Closed: ${event.code} ${event.reason}`);
      this.ws = null;
      this.callbacks.onStateChange('disconnected');
    };

    ws.onerror = () => {
      this.callbacks.onError('WebSocket connection failed');
      this.callbacks.onStateChange('error');
    };

    ws.onmessage = (event) => {
      try {
        const data: RealtimeEvent = JSON.parse(event.data);
        this.handleEvent(data);
      } catch {
        // Ignore non-JSON messages
      }
    };
  }

  /** Disconnect from the realtime endpoint. */
  disconnect(): void {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Client disconnected');
      }
      this.ws = null;
    }
  }

  /** Send base64-encoded PCM16 audio to the server. */
  sendAudio(base64Pcm16: string): void {
    this.send({
      type: 'input_audio_buffer.append',
      audio: base64Pcm16,
    });
  }

  /** Commit the current audio buffer (triggers a response). */
  commitAudio(): void {
    this.send({ type: 'input_audio_buffer.commit' });
  }

  /** Check if the WebSocket is connected. */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private send(data: Record<string, any>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private handleEvent(event: RealtimeEvent): void {
    switch (event.type) {
      case 'session.created':
        console.log('[RealtimeClient] Session:', event.session?.id);
        break;

      case 'response.created':
        this.callbacks.onResponseCreated();
        break;

      case 'response.audio.delta':
        if (event.delta) {
          this.callbacks.onAudioDelta(event.delta);
        }
        break;

      case 'response.audio.done':
      case 'response.done':
        this.callbacks.onResponseDone();
        break;

      case 'response.audio_transcript.delta':
        if (event.delta) {
          this.callbacks.onTranscriptDelta?.(event.delta);
        }
        break;

      case 'response.audio_transcript.done':
        if (event.transcript) {
          this.callbacks.onTranscriptDone?.(event.transcript);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          this.callbacks.onUserTranscriptCompleted?.(event.transcript);
        }
        break;

      case 'input_audio_buffer.speech_started':
        this.callbacks.onSpeechStarted();
        break;

      case 'input_audio_buffer.speech_stopped':
        this.callbacks.onSpeechStopped();
        break;

      case 'error':
        console.error('[RealtimeClient] Error:', event.error);
        this.callbacks.onError(event.error?.message || 'Server error');
        break;
    }
  }
}
