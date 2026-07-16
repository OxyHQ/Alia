import React, { useState, useEffect } from "react";
import { View, Text } from "react-native";
import Animated, {
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
} from "react-native-reanimated";
import { AliaMark } from "./AliaMark";

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

export function ThinkingIndicator({ isWorking = false, statusText, color }: { isWorking?: boolean; statusText?: string; color?: string }) {
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

  // Pulsing cursor animation (effect-free, declarative)
  const cursorStyle = useAnimatedStyle(() => ({
    opacity: withRepeat(
      withSequence(
        withTiming(0.2, { duration: 400 }),
        withTiming(1, { duration: 400 })
      ),
      -1
    ),
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
    <View className="flex-row items-center gap-2 py-2">
      <AliaMark size={16} state={isWorking ? 'working' : 'thinking'} color={color} />
      <View className="flex-row items-center">
        <Text className="text-base text-muted-foreground">{shownText}</Text>
        {(statusText || isTyping) && (
          <Animated.View style={cursorStyle}>
            <Text className="text-base text-muted-foreground">|</Text>
          </Animated.View>
        )}
      </View>
    </View>
  );
}
