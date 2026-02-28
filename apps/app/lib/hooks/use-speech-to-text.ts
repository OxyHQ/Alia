import { useState, useCallback, useRef, useEffect } from 'react';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { useOxy } from '@oxyhq/services';
import { useSTTStore } from '@/lib/stores/stt-store';
import config from '../config';

type STTState = 'idle' | 'recording' | 'transcribing';

const METERING_PRESET = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };

export function useSpeechToText() {
  const [state, setState] = useState<STTState>('idle');
  const [error, setError] = useState<string | null>(null);
  const isRecordingRef = useRef(false);
  const { oxyServices } = useOxy();

  const audioRecorder = useAudioRecorder(METERING_PRESET);
  const recorderState = useAudioRecorderState(audioRecorder, 100);

  const sttStore = useSTTStore;

  // Push metering to store while recording
  useEffect(() => {
    if (state === 'recording' && recorderState.metering != null) {
      // dBFS: -160 (silence) to 0 (max). Normalize using -60 as practical floor.
      const normalized = Math.min(1, Math.max(0, (recorderState.metering + 60) / 60));
      sttStore.getState().setMetering(normalized);
    }
  }, [state, recorderState.metering]);

  // Sync recording state to store
  useEffect(() => {
    sttStore.getState().setRecording(state === 'recording');
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
      const token = oxyServices.getAccessToken();
      const transcribeResponse = await fetch(`${config.apiUrl}/v1/voice/transcribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          audio: base64,
          format: 'audio/m4a',
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
  }, [audioRecorder, oxyServices]);

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
