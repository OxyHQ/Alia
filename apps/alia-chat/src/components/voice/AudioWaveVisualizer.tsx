import React, { useEffect } from 'react';
import { View, Platform, useWindowDimensions } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';
import type { AgentState } from '../../types';

const AnimatedPath = Animated.createAnimatedComponent(Path);

const GLOW_HEIGHT = 350;
const NUM_POINTS = 8;

// Ocean-style wave layers: fill from bottom to a surface level, crests undulate
interface WaveLayerConfig {
  color: string;
  surfaceY: number; // surface level as % from top (50 = middle)
  waveHeight: number; // base crest height in px
  maxWaveBoost: number; // extra crest height from audio
  phaseOffset: number;
  speed: number; // ms for one full horizontal cycle
  blur: number;
}

const WAVE_LAYERS: WaveLayerConfig[] = [
  // Deepest layer - dark blue, highest surface (closest to top)
  {
    color: 'rgba(12, 74, 110, 0.8)',
    surfaceY: 35,
    waveHeight: 14,
    maxWaveBoost: 120,
    phaseOffset: 0,
    speed: 7000,
    blur: 30,
  },
  // Mid layer - ocean blue
  {
    color: 'rgba(14, 165, 233, 0.45)',
    surfaceY: 42,
    waveHeight: 16,
    maxWaveBoost: 140,
    phaseOffset: Math.PI * 0.8,
    speed: 5500,
    blur: 22,
  },
  // Front layer - bright cyan, lowest surface
  {
    color: 'rgba(56, 189, 248, 0.35)',
    surfaceY: 50,
    waveHeight: 20,
    maxWaveBoost: 150,
    phaseOffset: Math.PI * 1.5,
    speed: 4500,
    blur: 16,
  },
  // Accent layer - indigo/purple
  {
    color: 'rgba(99, 102, 241, 0.25)',
    surfaceY: 38,
    waveHeight: 12,
    maxWaveBoost: 100,
    phaseOffset: Math.PI * 0.3,
    speed: 8000,
    blur: 28,
  },
];

// Background glow blobs for ambient color
interface BlobConfig {
  color: string;
  baseWidth: number;
  baseHeight: number;
  x: number;
  y: number;
  blur: number;
  amplitudeScale: number;
  phaseSpeed: number;
  phaseDirection: 1 | -1;
}

const BLOBS: BlobConfig[] = [
  {
    color: '#0c4a6e',
    baseWidth: 320,
    baseHeight: 200,
    x: 50,
    y: 55,
    blur: 80,
    amplitudeScale: 1.0,
    phaseSpeed: 4000,
    phaseDirection: 1,
  },
  {
    color: '#0ea5e9',
    baseWidth: 220,
    baseHeight: 140,
    x: 38,
    y: 65,
    blur: 60,
    amplitudeScale: 1.2,
    phaseSpeed: 3500,
    phaseDirection: -1,
  },
  {
    color: '#6366f1',
    baseWidth: 180,
    baseHeight: 160,
    x: 70,
    y: 55,
    blur: 70,
    amplitudeScale: 0.7,
    phaseSpeed: 4500,
    phaseDirection: -1,
  },
  {
    color: '#a855f7',
    baseWidth: 130,
    baseHeight: 110,
    x: 78,
    y: 65,
    blur: 60,
    amplitudeScale: 0.5,
    phaseSpeed: 5500,
    phaseDirection: 1,
  },
];

// Colors per agent state for waves — speaking blends blue + purple
const WAVE_COLORS: Record<AgentState, WaveLayerConfig['color'][]> = {
  idle: [
    'rgba(12, 74, 110, 0.8)',
    'rgba(14, 165, 233, 0.45)',
    'rgba(56, 189, 248, 0.35)',
    'rgba(99, 102, 241, 0.25)',
  ],
  listening: [
    'rgba(12, 74, 110, 0.8)',
    'rgba(14, 165, 233, 0.45)',
    'rgba(56, 189, 248, 0.35)',
    'rgba(99, 102, 241, 0.25)',
  ],
  thinking: [
    'rgba(120, 80, 20, 0.75)',
    'rgba(234, 179, 8, 0.45)',
    'rgba(251, 191, 36, 0.35)',
    'rgba(253, 224, 71, 0.25)',
  ],
  speaking: [
    'rgba(30, 40, 100, 0.8)',
    'rgba(99, 102, 241, 0.5)',
    'rgba(147, 51, 234, 0.4)',
    'rgba(56, 189, 248, 0.3)',
  ],
};

const BLOB_COLORS: Record<AgentState, string[]> = {
  idle: ['#0c4a6e', '#0ea5e9', '#6366f1', '#a855f7'],
  listening: ['#0c4a6e', '#0ea5e9', '#6366f1', '#a855f7'],
  thinking: ['#92400e', '#eab308', '#f59e0b', '#fbbf24'],
  speaking: ['#1e2870', '#6366f1', '#9333ea', '#0ea5e9'],
};

interface AudioWaveVisualizerProps {
  waveAmplitude: SharedValue<number>;
  agentState: AgentState;
  isConnected: boolean;
}

export function AudioWaveVisualizer({
  waveAmplitude,
  agentState = 'idle',
  isConnected,
}: AudioWaveVisualizerProps) {
  const { width: screenWidth } = useWindowDimensions();
  const state = WAVE_COLORS[agentState] ? agentState : 'idle';

  return (
    <View
      style={{
        width: screenWidth,
        height: GLOW_HEIGHT,
        position: 'relative',
      }}
    >
      {/* Background glow blobs */}
      {BLOBS.map((blob, i) => (
        <GlowBlob
          key={`blob-${i}`}
          blob={blob}
          color={BLOB_COLORS[state][i]}
          waveAmplitude={waveAmplitude}
          isConnected={isConnected}
          screenWidth={screenWidth}
        />
      ))}

      {/* Ocean wave layers — filled from surface down to bottom, with blur */}
      {WAVE_LAYERS.map((layer, i) => (
        <OceanWave
          key={`wave-${i}`}
          layer={layer}
          color={WAVE_COLORS[state][i]}
          waveAmplitude={waveAmplitude}
          isConnected={isConnected}
          screenWidth={screenWidth}
        />
      ))}
    </View>
  );
}

// Ocean wave: surface undulates horizontally, filled from surface to bottom
function OceanWave({
  layer,
  color,
  waveAmplitude,
  isConnected,
  screenWidth,
}: {
  layer: WaveLayerConfig;
  color: string;
  waveAmplitude: SharedValue<number>;
  isConnected: boolean;
  screenWidth: number;
}) {
  const phase = useSharedValue(0);

  useEffect(() => {
    phase.value = 0;
    phase.value = withRepeat(
      withTiming(Math.PI * 2, { duration: layer.speed, easing: Easing.linear }),
      -1,
      false,
    );
  }, []);

  const animatedProps = useAnimatedProps(() => {
    const amp = waveAmplitude.value;
    // Surface Y position (fixed, doesn't move with audio)
    const surfaceY = (layer.surfaceY / 100) * GLOW_HEIGHT;
    // Wave crest height: base + audio boost
    const crestHeight = layer.waveHeight + amp * layer.maxWaveBoost;
    const currentPhase = phase.value + layer.phaseOffset;
    const segW = screenWidth / NUM_POINTS;

    // Start at bottom-left corner
    let d = `M 0 ${GLOW_HEIGHT}`;

    // Up to first surface point
    const firstY = surfaceY + Math.sin(currentPhase) * crestHeight;
    d += ` L 0 ${firstY}`;

    // Draw undulating surface across the width
    for (let i = 0; i < NUM_POINTS; i++) {
      const x1 = (i + 1) * segW;
      const y0 =
        surfaceY +
        Math.sin(currentPhase + (i / NUM_POINTS) * Math.PI * 2) * crestHeight;
      const y1 =
        surfaceY +
        Math.sin(currentPhase + ((i + 1) / NUM_POINTS) * Math.PI * 2) * crestHeight;

      const cp1x = i * segW + segW * 0.5;
      const cp2x = x1 - segW * 0.5;

      d += ` C ${cp1x} ${y0}, ${cp2x} ${y1}, ${x1} ${y1}`;
    }

    // Close: down to bottom-right, across to bottom-left
    d += ` L ${screenWidth} ${GLOW_HEIGHT} Z`;

    return { d };
  });

  const webBlurStyle =
    Platform.OS === 'web'
      ? ({
          filter: `blur(${layer.blur}px)`,
          WebkitFilter: `blur(${layer.blur}px)`,
        } as any)
      : {};

  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        opacity: isConnected ? 1 : 0,
        ...webBlurStyle,
        pointerEvents: 'none',
      }}
    >
      <Svg width={screenWidth} height={GLOW_HEIGHT}>
        <AnimatedPath animatedProps={animatedProps} fill={color} />
      </Svg>
    </View>
  );
}

// Ambient glow blob
function GlowBlob({
  blob,
  color,
  waveAmplitude,
  isConnected,
  screenWidth,
}: {
  blob: BlobConfig;
  color: string;
  waveAmplitude: SharedValue<number>;
  isConnected: boolean;
  screenWidth: number;
}) {
  const drift = useSharedValue(0);

  useEffect(() => {
    drift.value = 0;
    drift.value = withRepeat(
      withSequence(
        withTiming(1, {
          duration: blob.phaseSpeed,
          easing: Easing.bezier(0.37, 0, 0.63, 1),
        }),
        withTiming(0, {
          duration: blob.phaseSpeed,
          easing: Easing.bezier(0.37, 0, 0.63, 1),
        }),
      ),
      -1,
      false,
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => {
    const amp = waveAmplitude.value;
    const scale = 1 + amp * 0.3 * blob.amplitudeScale;
    const driftOffset = (drift.value - 0.5) * 20 * blob.phaseDirection;
    const opacity = isConnected ? 0.45 + amp * 0.35 * blob.amplitudeScale : 0;

    const w = blob.baseWidth * scale;
    const h = blob.baseHeight * scale;
    const left = (blob.x / 100) * screenWidth - w / 2 + driftOffset;
    const top = (blob.y / 100) * GLOW_HEIGHT - h / 2;

    return {
      position: 'absolute' as const,
      width: w,
      height: h,
      left,
      top,
      borderRadius: w / 2,
      backgroundColor: color,
      opacity,
      transform: [{ scale }],
    };
  });

  const webBlurStyle =
    Platform.OS === 'web'
      ? ({
          filter: `blur(${blob.blur}px)`,
          WebkitFilter: `blur(${blob.blur}px)`,
        } as any)
      : {};

  return <Animated.View style={[animatedStyle, webBlurStyle]} />;
}
