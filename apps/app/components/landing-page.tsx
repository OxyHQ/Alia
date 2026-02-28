import { useEffect, useRef, useState } from "react";
import {
  View,
  ScrollView,
  Pressable,
  useWindowDimensions,
} from "react-native";
import { useRouter } from "expo-router";
import * as Linking from "expo-linking";
import Animated, {
  FadeIn,
  FadeInUp,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import {
  MessageCircle,
  Eye,
  Bot,
  Code,
  ChevronDown,
  ArrowUp,
  Plus,
  Mic,
} from "lucide-react-native";
import { OxySignInButton, useAuth } from "@oxyhq/services";
import { Text } from "@/components/ui/text";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { AliaFace, type AliaExpression } from "@/components/alia-face";
import { useTranslation } from "@/hooks/useTranslation";
import { useColorScheme } from "@/lib/useColorScheme";

interface LandingPageProps {
  returnTo?: string;
}

// ---------------------------------------------------------------------------
// Floating orb — decorative background element
// ---------------------------------------------------------------------------
function FloatingOrb({
  size,
  color,
  style,
}: {
  size: number;
  color: string;
  style?: object;
}) {
  const translateY = useSharedValue(0);
  const translateX = useSharedValue(0);

  useEffect(() => {
    translateY.value = withRepeat(
      withSequence(
        withTiming(-20, {
          duration: 3000,
          easing: Easing.inOut(Easing.ease),
        }),
        withTiming(20, { duration: 3000, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      true
    );
    translateX.value = withRepeat(
      withSequence(
        withTiming(10, { duration: 4000, easing: Easing.inOut(Easing.ease) }),
        withTiming(-10, { duration: 4000, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      true
    );
  }, []);

  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: translateY.value },
      { translateX: translateX.value },
    ],
  }));

  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          opacity: 0.12,
        },
        style,
        animStyle,
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Blinking cursor
// ---------------------------------------------------------------------------
function BlinkingCursor() {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0, { duration: 530, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 530, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      true
    );
  }, []);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={[{ display: "inline-flex" as any }, animStyle]}>
      <Text className="text-base text-primary font-light">|</Text>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Demo prompt input — decorative, pixel-perfect match to real PromptInput
// ---------------------------------------------------------------------------
function DemoPromptInput({ typedText }: { typedText: string }) {
  return (
    <View className="w-full">
      <View className="rounded-[24px] border border-border bg-background overflow-hidden shadow-lg shadow-foreground/5">
        {/* Text area row */}
        <View className="min-h-[44px] px-4 py-3 justify-center">
          <View className="flex-row items-center">
            <Text
              className="text-base text-muted-foreground flex-1"
              numberOfLines={1}
            >
              {typedText}
            </Text>
            <BlinkingCursor />
          </View>
        </View>

        {/* Actions bar */}
        <View className="flex-row items-center justify-between gap-2 mb-1 px-3">
          <View className="flex-row items-center gap-1.5">
            <View className="h-8 w-8 rounded-full items-center justify-center">
              <Plus size={16} className="text-muted-foreground" />
            </View>
          </View>
          <View className="flex-row items-center gap-1.5">
            <View className="h-8 w-8 rounded-full items-center justify-center">
              <Mic size={16} className="text-muted-foreground" />
            </View>
            <View className="h-8 w-8 rounded-full bg-primary items-center justify-center">
              <ArrowUp size={16} color="white" />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Capability card
// ---------------------------------------------------------------------------
const CAPABILITIES = [
  {
    icon: MessageCircle,
    titleKey: "landing.cap1Title",
    descKey: "landing.cap1Desc",
  },
  { icon: Eye, titleKey: "landing.cap2Title", descKey: "landing.cap2Desc" },
  { icon: Bot, titleKey: "landing.cap3Title", descKey: "landing.cap3Desc" },
  { icon: Code, titleKey: "landing.cap4Title", descKey: "landing.cap4Desc" },
] as const;

function CapabilityCard({
  icon: Icon,
  title,
  description,
  index,
  isLargeScreen,
}: {
  icon: typeof MessageCircle;
  title: string;
  description: string;
  index: number;
  isLargeScreen: boolean;
}) {
  return (
    <Animated.View
      entering={FadeInUp.delay(400 + index * 150)
        .duration(600)
        .springify()}
      style={isLargeScreen ? { width: "48%" } : undefined}
      className={`rounded-2xl border border-border bg-background p-8 shadow-sm shadow-foreground/5 ${isLargeScreen ? "" : "w-full"}`}
    >
      <View className="w-14 h-14 rounded-2xl bg-primary/10 items-center justify-center mb-5">
        <Icon size={26} className="text-primary" />
      </View>
      <Text className="text-lg font-bold text-foreground mb-2">{title}</Text>
      <Text className="text-sm text-muted-foreground leading-6">
        {description}
      </Text>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Bouncing scroll indicator
// ---------------------------------------------------------------------------
function ScrollIndicator() {
  const bounceY = useSharedValue(0);

  useEffect(() => {
    bounceY.value = withRepeat(
      withSequence(
        withTiming(8, { duration: 1000, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 1000, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      true
    );
  }, []);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: bounceY.value }],
  }));

  return (
    <Animated.View
      style={[animStyle, { alignSelf: "center" }]}
      className="mt-8 opacity-40"
    >
      <ChevronDown size={28} className="text-muted-foreground" />
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HERO_EXPRESSIONS: AliaExpression[] = [
  "Greeting",
  "Interesting",
  "Idle A",
  "Thinking",
  "Searching F",
];

const DEMO_KEYS = [
  "landing.demo1",
  "landing.demo2",
  "landing.demo3",
  "landing.demo4",
  "landing.demo5",
] as const;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function LandingPage({ returnTo }: LandingPageProps) {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();
  const { t } = useTranslation();
  const { width, height } = useWindowDimensions();
  const { colors } = useColorScheme();
  const isLargeScreen = width >= 768;

  // Auth redirect
  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      router.replace((returnTo || "/") as any);
    }
  }, [isAuthenticated, isLoading]);

  // Expression cycling
  const [expression, setExpression] = useState<AliaExpression>("Greeting");
  useEffect(() => {
    let idx = 0;
    const interval = setInterval(() => {
      idx = (idx + 1) % HERO_EXPRESSIONS.length;
      setExpression(HERO_EXPRESSIONS[idx]);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  // Typewriter effect
  const [typedText, setTypedText] = useState("");
  const typewriterRef = useRef({
    promptIdx: 0,
    charIdx: 0,
    phase: "typing" as "typing" | "pausing" | "clearing",
  });

  useEffect(() => {
    const prompts = DEMO_KEYS.map((k) => t(k));
    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      const { promptIdx, charIdx, phase } = typewriterRef.current;
      const currentPrompt = prompts[promptIdx];

      if (phase === "typing") {
        if (charIdx < currentPrompt.length) {
          typewriterRef.current.charIdx = charIdx + 1;
          setTypedText(currentPrompt.slice(0, charIdx + 1));
          timer = setTimeout(tick, 18);
        } else {
          typewriterRef.current.phase = "pausing";
          timer = setTimeout(tick, 1500);
        }
      } else if (phase === "pausing") {
        typewriterRef.current.phase = "clearing";
        setTypedText("");
        typewriterRef.current.charIdx = 0;
        typewriterRef.current.promptIdx = (promptIdx + 1) % prompts.length;
        timer = setTimeout(tick, 300);
      } else {
        typewriterRef.current.phase = "typing";
        timer = setTimeout(tick, 18);
      }
    };

    timer = setTimeout(tick, 800);
    return () => clearTimeout(timer);
  }, [t]);

  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">{t("common.loading")}</Text>
      </View>
    );
  }

  if (isAuthenticated) return null;

  const faceSize = isLargeScreen ? 200 : 140;

  return (
    <View className="flex-1">
      <ScrollView
        className="flex-1 bg-background"
        showsVerticalScrollIndicator={false}
      >
        {/* ==================== HERO (full-bleed) ==================== */}
        <View
          style={{ minHeight: height, overflow: "hidden" }}
          className="items-center justify-center px-6 relative"
        >
          {/* Subtle hero gradient overlay */}
          <LinearGradient
            colors={[
              "transparent",
              "rgba(202, 82, 233, 0.03)",
              "transparent",
            ]}
            locations={[0, 0.5, 1]}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
            }}
            pointerEvents="none"
          />

          {/* Floating orbs */}
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              overflow: "hidden",
            }}
          >
            <FloatingOrb
              size={260}
              color="#ca52e9"
              style={{ top: "10%", left: "-10%" }}
            />
            <FloatingOrb
              size={180}
              color="#8b5cf6"
              style={{ bottom: "15%", right: "-5%" }}
            />
            <FloatingOrb
              size={120}
              color="#3b82f6"
              style={{ top: "40%", left: "70%" }}
            />
          </View>

          {/* Content */}
          <Animated.View
            entering={FadeIn.duration(800)}
            className="items-center w-full max-w-2xl"
          >
            <AliaFace expression={expression} size={faceSize} />
            <View className="mt-6 mb-2">
              <TextShimmer
                duration={6}
                spread={30}
                className={`font-bold text-center ${isLargeScreen ? "text-7xl" : "text-5xl"}`}
              >
                Alia
              </TextShimmer>
            </View>
            <Text
              className={`text-muted-foreground text-center mb-10 font-light ${isLargeScreen ? "text-xl" : "text-lg"}`}
            >
              {t("landing.tagline")}
            </Text>

            <OxySignInButton />

            <ScrollIndicator />
          </Animated.View>
        </View>

        {/* ==================== CAPABILITIES (bg-surface band) ==================== */}
        <View className="w-full bg-surface">
          <View
            className={`px-6 ${isLargeScreen ? "py-28" : "py-20"}`}
            style={{ maxWidth: 960, alignSelf: "center", width: "100%" }}
          >
            <Animated.View
              entering={FadeInUp.delay(200).duration(700).springify()}
            >
              <Text
                className={`font-bold text-foreground text-center mb-12 ${isLargeScreen ? "text-4xl" : "text-2xl"}`}
              >
                {t("landing.capabilitiesTitle")}
              </Text>
            </Animated.View>

            <View
              className={`gap-5 ${isLargeScreen ? "flex-row flex-wrap justify-between" : ""}`}
            >
              {CAPABILITIES.map((cap, idx) => (
                <CapabilityCard
                  key={cap.titleKey}
                  icon={cap.icon}
                  title={t(cap.titleKey)}
                  description={t(cap.descKey)}
                  index={idx}
                  isLargeScreen={isLargeScreen}
                />
              ))}
            </View>
          </View>
        </View>

        {/* ==================== BOTTOM CTA (gradient band) ==================== */}
        <View className="w-full relative">
          <LinearGradient
            colors={["transparent", "rgba(202, 82, 233, 0.04)"]}
            locations={[0, 1]}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
            }}
            pointerEvents="none"
          />
          <Animated.View
            entering={FadeInUp.delay(200).duration(700)}
            className={`items-center px-6 pb-12 ${isLargeScreen ? "py-28" : "py-20"}`}
            style={{ maxWidth: 700, alignSelf: "center", width: "100%" }}
          >
            <Text
              className={`font-bold text-foreground text-center mb-3 ${isLargeScreen ? "text-4xl" : "text-2xl"}`}
            >
              {t("landing.ctaTitle")}
            </Text>
            <Text className="text-lg text-muted-foreground text-center mb-10">
              {t("landing.ctaSubtitle")}
            </Text>

            <OxySignInButton />

            {/* Terms */}
            <View className="mt-6 flex-row flex-wrap justify-center px-4 gap-1">
              <Text className="text-xs text-muted-foreground">
                {t("login.termsPrefix")}
              </Text>
              <Pressable
                onPress={() => Linking.openURL("https://alia.onl/terms")}
              >
                <Text className="text-xs text-primary">
                  {t("login.termsOfService")}
                </Text>
              </Pressable>
              <Text className="text-xs text-muted-foreground">
                {t("login.termsAnd")}
              </Text>
              <Pressable
                onPress={() => Linking.openURL("https://alia.onl/privacy")}
              >
                <Text className="text-xs text-primary">
                  {t("login.privacyPolicy")}
                </Text>
              </Pressable>
            </View>
          </Animated.View>
        </View>
      </ScrollView>

      {/* Fixed bottom demo input — always visible */}
      <Animated.View
        entering={FadeInUp.delay(600).duration(500)}
        pointerEvents="box-none"
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
        }}
      >
        <LinearGradient
          colors={["transparent", colors.background]}
          locations={[0, 0.4]}
          style={{
            paddingTop: 48,
            paddingBottom: 24,
            paddingHorizontal: 24,
          }}
          pointerEvents="box-none"
        >
          <View
            style={{ maxWidth: 620, alignSelf: "center", width: "100%" }}
            pointerEvents="box-none"
          >
            <DemoPromptInput typedText={typedText} />
          </View>
        </LinearGradient>
      </Animated.View>
    </View>
  );
}
