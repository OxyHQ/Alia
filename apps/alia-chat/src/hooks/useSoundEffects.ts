/**
 * Sound effects hook for voice mode.
 * Plays short audio cues when the AI is thinking, using tools,
 * or when voice connection state changes.
 *
 * Sounds are provided via options instead of hardcoded require() calls,
 * making this hook portable across different bundlers and apps.
 */

import { useEffect, useRef, useCallback } from 'react';
import type { AgentState } from '../types';

export type SoundName = 'thinking' | 'toolCall' | 'voiceConnect' | 'voiceDisconnect';

export interface SoundSources {
  thinking?: any;
  toolCall?: any;
  voiceConnect?: any;
  voiceDisconnect?: any;
}

const SOUND_NAMES: SoundName[] = ['thinking', 'toolCall', 'voiceConnect', 'voiceDisconnect'];

export function useSoundEffects(enabled: boolean = false, sounds: SoundSources = {}) {
  const playersRef = useRef<Map<SoundName, any>>(new Map());
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!enabled || loadedRef.current) return;

    // Only load sounds that were actually provided
    const hasAnySounds = SOUND_NAMES.some((name) => sounds[name] != null);
    if (!hasAnySounds) return;

    let mounted = true;

    (async () => {
      try {
        const { createAudioPlayer } = await import('expo-audio');
        if (!mounted) return;

        for (const name of SOUND_NAMES) {
          const source = sounds[name];
          if (source == null) continue;
          try {
            const player = createAudioPlayer(source);
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
  }, [enabled, sounds]);

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
  sounds = {},
}: {
  isVoiceActive: boolean;
  agentState: AgentState;
  isConnected: boolean;
  sounds?: SoundSources;
}) {
  const { play } = useSoundEffects(isVoiceActive, sounds);
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
