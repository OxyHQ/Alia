import { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  ScrollView,
  Pressable,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from "react-native";
import { useRouter } from "expo-router";
import * as Linking from "expo-linking";
import Animated, {
  FadeIn,
  FadeInUp,
  FadeOutDown,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from "react-native-reanimated";
import {
  MessageCircle,
  Eye,
  Bot,
  Code,
  ChevronDown,
  ArrowUp,
} from "lucide-react-native";
import { OxySignInButton, useAuth } from "@oxyhq/services";
import { Text } from "@/components/ui/text";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { AliaFace, type AliaExpression } from "@/components/alia-face";
import { useTranslation } from "@/hooks/useTranslation";

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
// Demo prompt input — decorative, matches real PromptInput styling
// ---------------------------------------------------------------------------
function DemoPromptInput({ typedText }: { typedText: string }) {
  return (
    <View className="w-full">
      <View className="rounded-[24px] border border-border bg-card flex-row items-center px-4 py-3">
        <View className="flex-1 flex-row items-center">
          <Text
            className="text-base text-muted-foreground"
            numberOfLines={1}
          >
            {typedText}
          </Text>
          <BlinkingCursor />
        </View>
        <View className="h-8 w-8 rounded-full bg-primary items-center justify-center ml-2">
          <ArrowUp size={16} color="white" />
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
      className={`rounded-2xl border border-border bg-card p-6 ${isLargeScreen ? "" : "w-full"}`}
    >
      <View className="w-12 h-12 rounded-xl bg-primary/10 items-center justify-center mb-4">
        <Icon size={24} className="text-primary" />
      </View>
      <Text className="text-lg font-bold text-foreground mb-1">{title}</Text>
      <Text className="text-sm text-muted-foreground leading-5">
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
// Hero expression cycling
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
  const typewriterRef = useRef({ promptIdx: 0, charIdx: 0, phase: "typing" as "typing" | "pausing" | "clearing" });

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
          timer = setTimeout(tick, 50);
        } else {
          typewriterRef.current.phase = "pausing";
          timer = setTimeout(tick, 2000);
        }
      } else if (phase === "pausing") {
        typewriterRef.current.phase = "clearing";
        setTypedText("");
        typewriterRef.current.charIdx = 0;
        typewriterRef.current.promptIdx = (promptIdx + 1) % prompts.length;
        timer = setTimeout(tick, 400);
      } else {
        typewriterRef.current.phase = "typing";
        timer = setTimeout(tick, 50);
      }
    };

    timer = setTimeout(tick, 800);
    return () => clearTimeout(timer);
  }, [t]);

  // Scroll-based fixed input
  const [showFixedInput, setShowFixedInput] = useState(false);
  const inputYRef = useRef(0);
  const showFixedRef = useRef(false);

  const handleInputLayout = useCallback((e: LayoutChangeEvent) => {
    inputYRef.current = e.nativeEvent.layout.y + e.nativeEvent.layout.height;
  }, []);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const scrollY = e.nativeEvent.contentOffset.y;
      const shouldShow = scrollY > inputYRef.current - 100;
      if (shouldShow !== showFixedRef.current) {
        showFixedRef.current = shouldShow;
        setShowFixedInput(shouldShow);
      }
    },
    []
  );

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
        onScroll={handleScroll}
        scrollEventThrottle={16}
      >
        <View className="w-full max-w-[1200px] mx-auto">
          {/* ==================== HERO ==================== */}
          <View
            style={{ minHeight: height, overflow: "hidden" }}
            className="items-center justify-center px-6 relative"
          >
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
              className="items-center w-full max-w-lg"
            >
              <AliaFace expression={expression} size={faceSize} />
              <View className="mt-6 mb-2">
                <TextShimmer
                  duration={6}
                  spread={30}
                  className={`font-bold text-center ${isLargeScreen ? "text-6xl" : "text-5xl"}`}
                >
                  Alia
                </TextShimmer>
              </View>
              <Text
                className={`text-muted-foreground text-center mb-8 ${isLargeScreen ? "text-xl" : "text-lg"}`}
              >
                {t("landing.tagline")}
              </Text>

              {/* Demo prompt input */}
              <View
                className="w-full max-w-[500px] mb-6"
                onLayout={handleInputLayout}
              >
                <DemoPromptInput typedText={typedText} />
              </View>

              <OxySignInButton />

              <ScrollIndicator />
            </Animated.View>
          </View>

          {/* ==================== CAPABILITIES ==================== */}
          <View
            className={`px-6 ${isLargeScreen ? "py-24" : "py-16"}`}
            style={{ maxWidth: 900, alignSelf: "center", width: "100%" }}
          >
            <Animated.View
              entering={FadeInUp.delay(200).duration(700).springify()}
            >
              <Text
                className={`font-bold text-foreground text-center mb-10 ${isLargeScreen ? "text-3xl" : "text-2xl"}`}
              >
                {t("landing.capabilitiesTitle")}
              </Text>
            </Animated.View>

            <View
              className={`gap-4 ${isLargeScreen ? "flex-row flex-wrap justify-between" : ""}`}
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

          {/* ==================== BOTTOM CTA ==================== */}
          <Animated.View
            entering={FadeInUp.delay(200).duration(700)}
            className={`items-center px-6 pb-8 ${isLargeScreen ? "py-24" : "py-16"}`}
          >
            <Text
              className={`font-bold text-foreground text-center mb-2 ${isLargeScreen ? "text-3xl" : "text-2xl"}`}
            >
              {t("landing.ctaTitle")}
            </Text>
            <Text className="text-base text-muted-foreground text-center mb-8">
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

      {/* Fixed bottom demo input — appears when scrolled past the inline one */}
      {showFixedInput && (
        <Animated.View
          entering={FadeInUp.duration(300)}
          exiting={FadeOutDown.duration(200)}
          pointerEvents="box-none"
          style={{
            position: "absolute",
            bottom: 24,
            left: 0,
            right: 0,
            paddingHorizontal: 24,
          }}
        >
          <View
            style={{ maxWidth: 600, alignSelf: "center", width: "100%" }}
          >
            <DemoPromptInput typedText={typedText} />
          </View>
        </Animated.View>
      )}
    </View>
  );
}
