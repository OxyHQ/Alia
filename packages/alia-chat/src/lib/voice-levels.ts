import { clampLevel } from './speech-recognition-types';

/**
 * The two live levels of a voice call — what the microphone hears and what the
 * call is saying — for whatever draws them.
 *
 * It replaced the LiveKit `Room` that `useAudioLevelMonitor` used to take and
 * put analysers on. The voice loop writes here from the recognizer's level
 * events and the clip player's samples; the monitor subscribes and hands React
 * a throttled copy. Writes are cheap and never render anything by themselves.
 */
export interface VoiceLevelSource {
  readonly capture: number;
  readonly playback: number;
  subscribe(listener: () => void): () => void;
}

export class VoiceLevelChannel implements VoiceLevelSource {
  private captureLevel = 0;
  private playbackLevel = 0;
  private readonly listeners = new Set<() => void>();

  get capture(): number {
    return this.captureLevel;
  }

  get playback(): number {
    return this.playbackLevel;
  }

  setCapture(level: number): void {
    const next = clampLevel(level);
    if (next === this.captureLevel) return;
    this.captureLevel = next;
    this.emit();
  }

  setPlayback(level: number): void {
    const next = clampLevel(level);
    if (next === this.playbackLevel) return;
    this.playbackLevel = next;
    this.emit();
  }

  reset(): void {
    this.setCapture(0);
    this.setPlayback(0);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
