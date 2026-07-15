import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Play, Pause, Square, Download } from 'lucide-react-native';
import * as Linking from 'expo-linking';

interface ShowPlayerProps {
  audioUrl: string;
  title: string;
  durationMs?: number;
}

type PlayerState = 'idle' | 'playing' | 'paused';

export function ShowPlayer({ audioUrl, title, durationMs }: ShowPlayerProps) {
  const [playerState, setPlayerState] = useState<PlayerState>('idle');
  const playerRef = useRef<any>(null);

  const formatDuration = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const releasePlayer = useCallback(() => {
    try {
      playerRef.current?.remove();
    } catch {
      // Player may already be released by the native side; nothing to clean up.
    }
    playerRef.current = null;
  }, []);

  const handlePlay = useCallback(async () => {
    if (playerState === 'playing') {
      playerRef.current?.pause();
      setPlayerState('paused');
      return;
    }

    if (playerState === 'paused' && playerRef.current) {
      playerRef.current.play();
      setPlayerState('playing');
      return;
    }

    // Start fresh
    releasePlayer();

    try {
      const { createAudioPlayer } = await import('expo-audio');
      const player = createAudioPlayer({ uri: audioUrl });
      playerRef.current = player;

      player.addListener('playbackStatusUpdate', (status: any) => {
        if (status.didJustFinish) {
          releasePlayer();
          setPlayerState('idle');
        }
      });

      player.play();
      setPlayerState('playing');
    } catch {
      setPlayerState('idle');
    }
  }, [audioUrl, playerState, releasePlayer]);

  const handleStop = useCallback(() => {
    releasePlayer();
    setPlayerState('idle');
  }, [releasePlayer]);

  const handleDownload = useCallback(() => {
    Linking.openURL(audioUrl);
  }, [audioUrl]);

  useEffect(() => {
    return () => {
      releasePlayer();
    };
  }, [releasePlayer]);

  return (
    <View className="flex-row items-center gap-3 p-3 bg-card rounded-xl border border-border">
      <Pressable
        onPress={handlePlay}
        className="w-10 h-10 rounded-full bg-primary items-center justify-center active:opacity-80"
      >
        {playerState === 'playing' ? (
          <Pause size={18} className="text-primary-foreground" fill="currentColor" />
        ) : (
          <Play size={18} className="text-primary-foreground" fill="currentColor" />
        )}
      </Pressable>

      <View className="flex-1">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {title}
        </Text>
        {durationMs ? (
          <Text className="text-xs text-muted-foreground">
            {formatDuration(durationMs)}
          </Text>
        ) : null}
      </View>

      {playerState === 'playing' && (
        <Pressable onPress={handleStop} className="p-2 active:opacity-70">
          <Square size={16} className="text-muted-foreground" fill="currentColor" />
        </Pressable>
      )}

      <Pressable onPress={handleDownload} className="p-2 active:opacity-70">
        <Download size={16} className="text-muted-foreground" />
      </Pressable>
    </View>
  );
}
