/**
 * Real-time audio level monitoring using Web Audio API.
 *
 * Extracts RMS levels from LiveKit audio tracks (local mic + remote agent)
 * and returns them at ~20fps for driving wave animations.
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
    let localAnalyser: AnalyserNode | null = null;
    let remoteAnalyser: AnalyserNode | null = null;
    let localBuffer: Float32Array | null = null;
    let remoteBuffer: Float32Array | null = null;
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

    // ---------- Remote agent audio ----------
    const setupRemoteAnalyser = (mediaStreamTrack: MediaStreamTrack) => {
      if (remoteAnalyser || disposed) return; // already set up
      try {
        const source = audioCtx.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
        remoteAnalyser = audioCtx.createAnalyser();
        remoteAnalyser.fftSize = 256;
        source.connect(remoteAnalyser);
        remoteBuffer = new Float32Array(remoteAnalyser.fftSize);
      } catch {
        // Ignore errors
      }
    };

    // Check already-subscribed remote tracks
    for (const [, p] of room.remoteParticipants) {
      for (const [, pub] of p.audioTrackPublications) {
        if (pub.track?.mediaStreamTrack) {
          setupRemoteAnalyser(pub.track.mediaStreamTrack);
          break;
        }
      }
      if (remoteAnalyser) break;
    }

    // Listen for new remote audio tracks
    const onTrackSubscribed = (track: any) => {
      if (track.kind === Track.Kind.Audio && !remoteAnalyser && track.mediaStreamTrack) {
        setupRemoteAnalyser(track.mediaStreamTrack);
      }
    };
    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);

    // ---------- Poll loop (~20fps) ----------
    let lastUpdate = 0;
    const poll = (time: number) => {
      if (disposed) return;
      if (time - lastUpdate > 50) {
        lastUpdate = time;
        if (localAnalyser && localBuffer) {
          setCaptureLevel(getRMS(localAnalyser, localBuffer));
        }
        if (remoteAnalyser && remoteBuffer) {
          setPlaybackLevel(getRMS(remoteAnalyser, remoteBuffer));
        }
      }
      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);

    // ---------- Cleanup ----------
    const dispose = () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      audioCtx.close().catch(() => {});
    };
    cleanupRef.current = dispose;

    return dispose;
  }, [room, isConnected]);

  return { captureLevel, playbackLevel };
}
