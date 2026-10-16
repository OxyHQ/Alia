// The web voice call's two AudioWorklet processors (`src/lib/voice-audio-engine.ts`).
//
// Served from Alia's web origin, content-addressed (`/sdk/voice-worklets/<revision>.js`,
// `src/lib/voice-worklets.ts`), so a host page loads it under `script-src https://alia.onl`
// instead of a `blob:` URL its CSP would have to allow. Plain JavaScript with no imports: a
// worklet module runs in the AudioWorkletGlobalScope. Every number it needs arrives in
// `processorOptions`, so the bytes stay the same while the engine's settings change.

class AliaVoiceCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { streamSampleRate, frameSamples } = options.processorOptions;
    this.ratio = sampleRate / streamSampleRate;
    this.frameSamples = frameSamples;
    this.t = 0;
    this.prev = 0;
    this.frame = new Int16Array(frameSamples);
    this.filled = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
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
        this.frame = new Int16Array(this.frameSamples);
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

class AliaVoicePlayback extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { streamSampleRate, prebufferMs, prebufferIdleMs } = options.processorOptions;
    this.streamSampleRate = streamSampleRate;
    this.prebufferSamples = (streamSampleRate * prebufferMs) / 1000;
    this.prebufferIdleSeconds = prebufferIdleMs / 1000;
    this.step = streamSampleRate / sampleRate;
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
        const playedMs = this.item === null ? null : this.playedMs();
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
  playedMs() {
    return (this.played / this.streamSampleRate) * 1000;
  }
  report(force) {
    if (!force && this.sinceReport < sampleRate / 20) return;
    const rms = this.count === 0 ? 0 : Math.sqrt(this.sumSquares / this.count);
    this.port.postMessage({ type: 'progress', itemId: this.item, playedMs: this.playedMs(), rms });
    this.sinceReport = 0;
    this.sumSquares = 0;
    this.count = 0;
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (this.buffering) {
      const ready =
        this.queued >= this.prebufferSamples ||
        (this.queued > 0 && currentTime - this.lastChunkAt > this.prebufferIdleSeconds);
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
