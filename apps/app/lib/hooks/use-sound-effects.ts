/**
 * Sound effects hook for voice mode.
 * Plays short audio cues when the AI is thinking, using tools,
 * or when voice connection state changes.
 *
 * Replace the placeholder MP3 files with your own sounds at:
 *   apps/app/assets/sounds/thinking.mp3
 *   apps/app/assets/sounds/tool-call.mp3
 *   apps/app/assets/sounds/voice-connect.mp3
 *   apps/app/assets/sounds/voice-disconnect.mp3
 */

import { useEffect, useRef, useCallback } from 'react';
import type { AgentState } from '@/lib/hooks/use-voice-room';

type SoundName = 'thinking' | 'toolCall' | 'voiceConnect' | 'voiceDisconnect';

// Static require() calls — Metro needs these to be static literals
const SOUND_SOURCES: Record<SoundName, any> = {
  thinking: require('@/assets/sounds/thinking.mp3'),
  toolCall: require('@/assets/sounds/tool-call.mp3'),
  voiceConnect: require('@/assets/sounds/voice-connect.mp3'),
  voiceDisconnect: require('@/assets/sounds/voice-disconnect.mp3'),
};

const SOUND_NAMES: SoundName[] = ['thinking', 'toolCall', 'voiceConnect', 'voiceDisconnect'];

export function useSoundEffects(enabled: boolean = false) {
  const playersRef = useRef<Map<SoundName, any>>(new Map());
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!enabled || loadedRef.current) return;

    let mounted = true;

    (async () => {
      try {
        const { createAudioPlayer } = await import('expo-audio');
        if (!mounted) return;

        for (const name of SOUND_NAMES) {
          try {
            const player = createAudioPlayer(SOUND_SOURCES[name]);
            playersRef.current.set(name, player);
          } catch {
            // Individual sound failed to load — skip it
          }
        }
        loadedRef.current = true;
      } catch {
        // expo-audio not available — degrade silently
      }
    })();

    return () => {
      mounted = false;
      for (const player of playersRef.current.values()) {
        try { player.release(); } catch {}
      }
      playersRef.current.clear();
      loadedRef.current = false;
    };
  }, [enabled]);

  const play = useCallback((sound: SoundName) => {
    if (!enabled) return;
    const player = playersRef.current.get(sound);
    if (player) {
      try {
        player.seekTo(0);
        player.play();
      } catch {
        // Playback failed — ignore
      }
    }
  }, [enabled]);

  return { play };
}

/**
 * Hook that automatically triggers sound effects based on voice state changes.
 * Wire this into the conversation page alongside useVoiceMode.
 */
export function useVoiceSoundEffects({
  isVoiceActive,
  agentState,
  isConnected,
}: {
  isVoiceActive: boolean;
  agentState: AgentState;
  isConnected: boolean;
}) {
  const { play } = useSoundEffects(isVoiceActive);
  const prevAgentStateRef = useRef<AgentState>('idle');
  const prevConnectedRef = useRef(false);

  // Play sound on agent state transitions
  useEffect(() => {
    if (!isVoiceActive) return;

    const prev = prevAgentStateRef.current;
    prevAgentStateRef.current = agentState;

    if (agentState === 'thinking' && prev !== 'thinking') {
      play('thinking');
    }
  }, [agentState, isVoiceActive, play]);

  // Play sound on connection state changes
  useEffect(() => {
    if (!isVoiceActive) return;

    const wasConnected = prevConnectedRef.current;
    prevConnectedRef.current = isConnected;

    if (isConnected && !wasConnected) {
      play('voiceConnect');
    } else if (!isConnected && wasConnected) {
      play('voiceDisconnect');
    }
  }, [isConnected, isVoiceActive, play]);
}
