import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
} from "react-native-reanimated";
import { useAliaColors } from "../theme";

const thinkingPhrases = [
  "Thinking...",
  "Crafting...",
  "Pondering...",
  "Computing...",
  "Processing...",
  "Analyzing...",
  "Reasoning...",
  "Cooking...",
  "Brewing...",
  "Conjuring...",
];

const workingPhrases = [
  "Working...",
  "Executing...",
  "Running...",
  "Building...",
  "Creating...",
  "Doing the thing...",
];

export function ThinkingIndicator({ isWorking = false, statusText }: { isWorking?: boolean; statusText?: string }) {
  const colors = useAliaColors();
  const phrases = isWorking ? workingPhrases : thinkingPhrases;
  const [phraseIndex, setPhraseIndex] = useState(() =>
    Math.floor(Math.random() * phrases.length)
  );
  const [displayText, setDisplayText] = useState("");
  const [isTyping, setIsTyping] = useState(true);

  // Reset phraseIndex when isWorking changes (arrays have different lengths)
  useEffect(() => {
    setPhraseIndex(Math.floor(Math.random() * phrases.length));
  }, [isWorking]);

  // Spinning asterisk animation
  const rotation = useSharedValue(0);
  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, { duration: 2000, easing: Easing.linear }),
      -1
    );
  }, [rotation]);

  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  // Pulsing cursor animation
  const cursorOpacity = useSharedValue(1);
  useEffect(() => {
    cursorOpacity.value = withRepeat(
      withSequence(
        withTiming(0.2, { duration: 400 }),
        withTiming(1, { duration: 400 })
      ),
      -1
    );
  }, [cursorOpacity]);

  const cursorStyle = useAnimatedStyle(() => ({
    opacity: cursorOpacity.value,
  }));

  // Typewriter effect — skipped when statusText is provided (real-time status shown directly)
  useEffect(() => {
    if (statusText) return;
    const phrase = phrases[phraseIndex % phrases.length];
    let charIndex = 0;
    setIsTyping(true);
    setDisplayText("");

    const typeInterval = setInterval(() => {
      if (charIndex < phrase.length) {
        setDisplayText(phrase.slice(0, charIndex + 1));
        charIndex++;
      } else {
        clearInterval(typeInterval);
        setIsTyping(false);

        // Wait then switch to next phrase
        setTimeout(() => {
          setPhraseIndex((prev) => (prev + 1) % phrases.length);
        }, 1500);
      }
    }, 40);

    return () => clearInterval(typeInterval);
  }, [phraseIndex, phrases, statusText]);

  const shownText = statusText || displayText;

  return (
    <View style={styles.container}>
      <Animated.View style={spinStyle}>
        <Text style={{ fontSize: 16, color: colors.mutedForeground }}>✱</Text>
      </Animated.View>
      <View style={styles.textRow}>
        <Text style={{ fontSize: 16, color: colors.mutedForeground }}>{shownText}</Text>
        {(statusText || isTyping) && (
          <Animated.View style={cursorStyle}>
            <Text style={{ fontSize: 16, color: colors.mutedForeground }}>|</Text>
          </Animated.View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  textRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
