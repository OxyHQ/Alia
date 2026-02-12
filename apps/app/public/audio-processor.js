/**
 * AudioWorklet processor for real-time PCM16 audio capture and playback.
 * Used by the voice chat component to interface with the Realtime API.
 *
 * Capture: Converts Float32 microphone samples to Int16 PCM, buffers, and emits chunks.
 * Playback: Receives Int16 PCM chunks and converts to Float32 for output.
 */

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(2400); // 100ms at 24kHz
    this._bufferIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0];
    for (let i = 0; i < samples.length; i++) {
      // Clamp and convert Float32 [-1, 1] to Int16 [-32768, 32767]
      const s = Math.max(-1, Math.min(1, samples[i]));
      this._buffer[this._bufferIndex++] = s < 0 ? s * 0x8000 : s * 0x7FFF;

      if (this._bufferIndex >= this._buffer.length) {
        // Send buffer as transferable
        const chunk = this._buffer.slice();
        this.port.postMessage({ type: 'audio', data: chunk.buffer }, [chunk.buffer]);
        this._buffer = new Int16Array(2400);
        this._bufferIndex = 0;
      }
    }
    return true;
  }
}

class AudioPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue = [];
    this._currentBuffer = null;
    this._currentIndex = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === 'audio') {
        this._queue.push(new Int16Array(e.data.data));
      } else if (e.data.type === 'clear') {
        this._queue = [];
        this._currentBuffer = null;
        this._currentIndex = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const channel = output[0];
    for (let i = 0; i < channel.length; i++) {
      if (!this._currentBuffer || this._currentIndex >= this._currentBuffer.length) {
        this._currentBuffer = this._queue.shift() || null;
        this._currentIndex = 0;
      }

      if (this._currentBuffer) {
        // Convert Int16 to Float32
        channel[i] = this._currentBuffer[this._currentIndex++] / 0x8000;
      } else {
        channel[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
registerProcessor('audio-playback-processor', AudioPlaybackProcessor);
