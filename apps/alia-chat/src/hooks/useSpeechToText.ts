import { useState, useCallback, useRef, useEffect } from 'react';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { useOxy } from '@oxyhq/services';
import { create } from 'zustand';

const API_URL = process.env.EXPO_PUBLIC_ALIA_API_URL ?? 'https://api.alia.onl';

// ============== OPTIONS ==============

export interface UseSTTOptions {
  apiUrl?: string;
  accessToken?: string;
}

// ============== INLINE STT STORE ==============

interface STTStoreState {
  isRecording: boolean;
  metering: number;
  setRecording: (v: boolean) => void;
  setMetering: (v: number) => void;
}

export const useSTTStore = create<STTStoreState>((set) => ({
  isRecording: false,
  metering: 0,
  setRecording: (isRecording) => set({ isRecording }),
  setMetering: (metering) => set({ metering }),
}));

// ============== HOOK ==============

type STTState = 'idle' | 'recording' | 'transcribing';

const METERING_PRESET = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };

export function useSpeechToText(options: UseSTTOptions = {}) {
  const apiUrl = options.apiUrl || API_URL;

  const [state, setState] = useState<STTState>('idle');
  const [error, setError] = useState<string | null>(null);
  const isRecordingRef = useRef(false);
  const { oxyServices } = useOxy();

  const audioRecorder = useAudioRecorder(METERING_PRESET);
  const recorderState = useAudioRecorderState(audioRecorder, 100);

  const sttStore = useSTTStore;

  // ============== AUTH ==============

  const getToken = useCallback((): string | null => {
    if (options.accessToken) return options.accessToken;
    return oxyServices.httpService.getAccessToken();
  }, [options.accessToken, oxyServices]);

  // Push metering to store while recording (with epsilon guard to avoid thrashing subscribers)
  const lastMeteringRef = useRef(0);
  useEffect(() => {
    if (state === 'recording') {
      let target: number;
      if (recorderState.metering != null) {
        // dBFS: -160 (silence) to 0 (max). Normalize using -60 as practical floor.
        target = Math.min(1, Math.max(0, (recorderState.metering + 60) / 60));
      } else {
        // Metering unavailable — simulate gentle activity
        target = 0.12 + Math.random() * 0.18;
      }
      if (Math.abs(target - lastMeteringRef.current) >= 0.02) {
        lastMeteringRef.current = target;
        sttStore.getState().setMetering(target);
      }
    }
  }, [state, recorderState.metering, recorderState.durationMillis]);

  // Sync recording state to store + reset metering on stop
  useEffect(() => {
    sttStore.getState().setRecording(state === 'recording');
    if (state !== 'recording') {
      lastMeteringRef.current = 0;
      sttStore.getState().setMetering(0);
    }
  }, [state]);

  const startRecording = useCallback(async () => {
    try {
      setError(null);

      const permStatus = await requestRecordingPermissionsAsync();
      if (!permStatus.granted) {
        setError('Microphone permission required');
        return;
      }

      setState('recording');

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      isRecordingRef.current = true;
    } catch (e: any) {
      console.error('[STT] Recording error:', e);
      setError('Failed to start recording');
      setState('idle');
      isRecordingRef.current = false;
    }
  }, [audioRecorder]);

  const stopAndTranscribe = useCallback(async (): Promise<string | null> => {
    if (!isRecordingRef.current) return null;

    try {
      setState('transcribing');
      isRecordingRef.current = false;
      await audioRecorder.stop();
      const uri = audioRecorder.uri;

      if (!uri) {
        setState('idle');
        return null;
      }

      // Read audio file as base64
      const response = await fetch(uri);
      const blob = await response.blob();
      // Detect actual MIME type (web records webm, native records m4a)
      const detectedFormat = blob.type?.split(';')[0] || 'audio/m4a';
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(',')[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      // Send to transcription API
      const token = getToken();
      const transcribeResponse = await fetch(`${apiUrl}/v1/voice/transcribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          audio: base64,
          format: detectedFormat,
        }),
      });

      if (!transcribeResponse.ok) {
        const errorData = await transcribeResponse.json().catch(() => ({}));
        throw new Error(errorData.error || 'Transcription failed');
      }

      const result = await transcribeResponse.json() as { text: string };
      setState('idle');
      return result.text || null;
    } catch (e: any) {
      console.error('[STT] Transcription error:', e);
      setError(e.message || 'Transcription failed');
      setState('idle');
      return null;
    }
  }, [audioRecorder, getToken, apiUrl]);

  const cancel = useCallback(() => {
    if (isRecordingRef.current) {
      isRecordingRef.current = false;
      Promise.resolve(audioRecorder.stop()).catch(() => {});
    }
    setState('idle');
    setError(null);
  }, [audioRecorder]);

  return {
    state,
    error,
    startRecording,
    stopAndTranscribe,
    cancel,
    isRecording: state === 'recording',
    isTranscribing: state === 'transcribing',
  };
}
