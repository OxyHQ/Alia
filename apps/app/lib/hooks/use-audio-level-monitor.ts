/**
 * Real-time audio level monitoring using Web Audio API.
 *
 * Extracts RMS levels from LiveKit audio tracks (local mic + remote agents)
 * and returns them at ~20fps for driving wave animations.
 *
 * Supports multiple remote audio tracks (primary + cohost) by taking
 * the max RMS level across all subscribed remote tracks.
 */

import { useState, useEffect, useRef } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';

/** Compute RMS (root mean square) amplitude from an AnalyserNode. Returns 0–1. */
function getRMS(analyser: AnalyserNode, buffer: Float32Array): number {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.min(1, Math.sqrt(sum / buffer.length) * 8);
}

export function useAudioLevelMonitor(room: Room | null, isConnected: boolean) {
  const [captureLevel, setCaptureLevel] = useState(0);
  const [playbackLevel, setPlaybackLevel] = useState(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Tear down previous monitors
    cleanupRef.current?.();
    cleanupRef.current = null;

    if (!room || !isConnected) {
      setCaptureLevel(0);
      setPlaybackLevel(0);
      return;
    }

    // Guard: Web Audio API required
    if (typeof AudioContext === 'undefined') return;

    const audioCtx = new AudioContext();
    // Resume AudioContext (may be suspended until user gesture on mobile/WebView)
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    let localAnalyser: AnalyserNode | null = null;
    let localBuffer: Float32Array | null = null;
    const remoteAnalysers = new Map<string, { analyser: AnalyserNode; buffer: Float32Array }>();
    let rafId = 0;
    let disposed = false;

    // ---------- Local mic ----------
    const localTrack = room.localParticipant?.getTrackPublication(Track.Source.Microphone)?.track;
    if (localTrack?.mediaStreamTrack) {
      try {
        const source = audioCtx.createMediaStreamSource(new MediaStream([localTrack.mediaStreamTrack]));
        localAnalyser = audioCtx.createAnalyser();
        localAnalyser.fftSize = 256;
        source.connect(localAnalyser);
        localBuffer = new Float32Array(localAnalyser.fftSize);
      } catch {
        // MediaStream creation can fail in some environments
      }
    }

    // ---------- Remote agent audio (supports multiple tracks) ----------
    const setupRemoteAnalyser = (mediaStreamTrack: MediaStreamTrack, key: string) => {
      if (remoteAnalysers.has(key) || disposed) return;
      try {
        const source = audioCtx.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const buffer = new Float32Array(analyser.fftSize);
        remoteAnalysers.set(key, { analyser, buffer });
      } catch {
        // Ignore errors
      }
    };

    // Check already-subscribed remote tracks
    for (const [, p] of room.remoteParticipants) {
      for (const [, pub] of p.audioTrackPublications) {
        if (pub.track?.mediaStreamTrack) {
          setupRemoteAnalyser(pub.track.mediaStreamTrack, `${p.identity}-${pub.trackSid}`);
        }
      }
    }

    // Listen for new remote audio tracks
    const onTrackSubscribed = (track: any, publication: any, participant: any) => {
      if (track.kind === Track.Kind.Audio && track.mediaStreamTrack) {
        setupRemoteAnalyser(track.mediaStreamTrack, `${participant.identity}-${publication.trackSid}`);
      }
    };
    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);

    // Clean up stale analysers when tracks are unsubscribed
    const onTrackUnsubscribed = (track: any, publication: any, participant: any) => {
      const key = `${participant.identity}-${publication.trackSid}`;
      remoteAnalysers.delete(key);
    };
    room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);

    // ---------- Poll loop (~20fps) ----------
    let lastUpdate = 0;
    const poll = (time: number) => {
      if (disposed) return;
      if (time - lastUpdate > 50) {
        lastUpdate = time;
        if (localAnalyser && localBuffer) {
          setCaptureLevel(getRMS(localAnalyser, localBuffer));
        }
        // Take max RMS across all remote tracks (primary + cohost)
        let maxRemoteLevel = 0;
        for (const [, { analyser, buffer }] of remoteAnalysers) {
          const level = getRMS(analyser, buffer);
          if (level > maxRemoteLevel) maxRemoteLevel = level;
        }
        setPlaybackLevel(maxRemoteLevel);
      }
      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);

    // ---------- Cleanup ----------
    const dispose = () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
      remoteAnalysers.clear();
      audioCtx.close().catch(() => {});
    };
    cleanupRef.current = dispose;

    return dispose;
  }, [room, isConnected]);

  return { captureLevel, playbackLevel };
}
