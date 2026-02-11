import { useState, useCallback, useRef } from 'react';
import {
  useAudioRecorder,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { useOxy } from '@oxyhq/services';
import config from '../config';

type VoiceState = 'idle' | 'connecting' | 'recording' | 'processing' | 'playing';

export function useVoiceChat() {
  const [state, setState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const permissionGrantedRef = useRef(false);
  const isRecordingRef = useRef(false);
  const { oxyServices } = useOxy();

  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const connect = useCallback(async () => {
    try {
      setState('connecting');
      setError(null);

      const permStatus = await requestRecordingPermissionsAsync();
      if (!permStatus.granted) {
        setError('Microphone permission required');
        setState('idle');
        return;
      }
      permissionGrantedRef.current = true;

      const token = oxyServices.getAccessToken();
      const wsUrl = config.apiUrl.replace(/^http/, 'ws') + '/v1/realtime';
      const ws = new WebSocket(`${wsUrl}?token=${token}`);

      ws.onopen = () => {
        setState('idle');
        console.log('[VoiceChat] WebSocket connected');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'transcript') {
            setTranscript(data.text || '');
          } else if (data.type === 'audio') {
            setState('playing');
          } else if (data.type === 'done') {
            setState('idle');
          } else if (data.type === 'error') {
            setError(data.message);
            setState('idle');
          }
        } catch (e) {
          console.error('[VoiceChat] Parse error:', e);
        }
      };

      ws.onerror = () => {
        setError('Connection failed');
        setState('idle');
      };

      ws.onclose = () => {
        setState('idle');
      };

      wsRef.current = ws;
    } catch (e: any) {
      setError(e.message);
      setState('idle');
    }
  }, [oxyServices]);

  const startRecording = useCallback(async () => {
    try {
      if (!permissionGrantedRef.current) {
        setError('Microphone permission not granted');
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
      console.error('[VoiceChat] Recording error:', e);
      setError('Failed to start recording');
      setState('idle');
      isRecordingRef.current = false;
    }
  }, [audioRecorder]);

  const stopRecording = useCallback(async () => {
    if (!isRecordingRef.current) return;

    try {
      setState('processing');
      isRecordingRef.current = false;
      await audioRecorder.stop();
      const uri = audioRecorder.uri;

      if (uri && wsRef.current?.readyState === WebSocket.OPEN) {
        const response = await fetch(uri);
        const blob = await response.blob();
        const reader = new FileReader();
        reader.onload = () => {
          if (reader.result && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'audio',
              data: (reader.result as string).split(',')[1],
              format: 'audio/m4a',
            }));
          }
          setState('idle');
        };
        reader.onerror = () => {
          setError('Failed to read audio file');
          setState('idle');
        };
        reader.readAsDataURL(blob);
      } else {
        setState('idle');
      }
    } catch (e: any) {
      console.error('[VoiceChat] Stop recording error:', e);
      setError('Failed to process recording');
      setState('idle');
    }
  }, [audioRecorder]);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    // Only stop recorder if we actually started recording
    if (isRecordingRef.current) {
      isRecordingRef.current = false;
      // Use Promise.catch since stop() is async
      Promise.resolve(audioRecorder.stop()).catch(() => {});
    }
    setState('idle');
    setTranscript('');
    setError(null);
  }, [audioRecorder]);

  return {
    state,
    transcript,
    error,
    connect,
    startRecording,
    stopRecording,
    disconnect,
    isConnected: wsRef.current?.readyState === WebSocket.OPEN,
  };
}
