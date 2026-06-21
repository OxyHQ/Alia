import { View, Platform, Pressable, ActivityIndicator } from "react-native";
import { KeyboardAwareScrollView } from "@/lib/keyboard";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { useOxy } from "@oxyhq/services";
import { useRouter } from "expo-router";
import { generateAPIUrl } from "@/lib/generate-api-url";
import { MessageSquare, Bug, Lightbulb, Sparkles, Star } from "lucide-react-native";
import { SettingsHeader } from "@/components/settings/settings-header";
import { toast } from "@/components/sonner";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";

type FeedbackType = 'bug' | 'feature' | 'improvement' | 'other';

interface FeedbackTypeOption {
  type: FeedbackType;
  labelKey: string;
  descriptionKey: string;
  icon: React.ElementType;
}

const feedbackTypes: FeedbackTypeOption[] = [
  { type: 'bug', labelKey: 'feedback.bugReport', descriptionKey: 'feedback.bugDescription', icon: Bug },
  { type: 'feature', labelKey: 'feedback.featureRequest', descriptionKey: 'feedback.featureDescription', icon: Lightbulb },
  { type: 'improvement', labelKey: 'feedback.improvement', descriptionKey: 'feedback.improvementDescription', icon: Sparkles },
  { type: 'other', labelKey: 'feedback.other', descriptionKey: 'feedback.otherDescription', icon: MessageSquare },
];

export default function FeedbackScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { oxyServices } = useOxy();
  const [selectedType, setSelectedType] = useState<FeedbackType | null>(null);
  const [message, setMessage] = useState("");
  const [rating, setRating] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!selectedType) {
      toast.error(t('feedback.selectType'));
      return;
    }

    if (!message.trim()) {
      toast.error(t('feedback.enterMessage'));
      return;
    }

    if (message.trim().length < 10) {
      toast.error(t('feedback.moreDetails'));
      return;
    }

    try {
      setSubmitting(true);

      const apiUrl = generateAPIUrl('/feedback');
      const token = oxyServices.getAccessToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: selectedType,
          message: message.trim(),
          rating: rating,
          metadata: {
            platform: Platform.OS,
            appVersion: '1.0.0',
          }
        }),
      });

      if (response.ok) {
        toast.success(t('feedback.thankYou'));
        setSelectedType(null);
        setMessage("");
        setRating(null);
        router.back();
      } else {
        const error = await response.json();
        toast.error(error.error || t('feedback.submitFailed'));
      }
    } catch (error) {
      console.error("Error submitting feedback:", error);
      toast.error(t('feedback.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const ratingLabels: Record<number, string> = {
    1: t('feedback.veryPoor'),
    2: t('feedback.poor'),
    3: t('feedback.average'),
    4: t('feedback.good'),
    5: t('feedback.excellent'),
  };

  const placeholderMap: Record<FeedbackType, string> = {
    bug: t('feedback.bugPlaceholder'),
    feature: t('feedback.featurePlaceholder'),
    improvement: t('feedback.improvementPlaceholder'),
    other: t('feedback.otherPlaceholder'),
  };

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t('feedback.title')} subtitle={t('feedback.subtitle')} showBack />

      <KeyboardAwareScrollView bottomOffset={20} className="flex-1 p-5">
        <View className="max-w-2xl mx-auto w-full gap-6">
          {/* Feedback Type Selection */}
          <View className="gap-3">
            <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
              {t('feedback.typeQuestion')}
            </Text>
            <View className="gap-2">
              {feedbackTypes.map((option) => {
                const Icon = option.icon;
                const isSelected = selectedType === option.type;
                return (
                  <Pressable
                    key={option.type}
                    onPress={() => setSelectedType(option.type)}
                    className={cn(
                      "flex-row items-center gap-3 p-4 rounded-xl border",
                      isSelected
                        ? "border-foreground bg-foreground/5"
                        : "border-border bg-muted/30"
                    )}
                  >
                    <View className={cn(
                      "p-2 rounded-full",
                      isSelected ? "bg-foreground/10" : "bg-muted"
                    )}>
                      <Icon size={20} className={isSelected ? "text-foreground" : "text-muted-foreground"} />
                    </View>
                    <View className="flex-1">
                      <Text className="font-medium text-foreground">
                        {t(option.labelKey)}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        {t(option.descriptionKey)}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Rating (Optional) */}
          <View className="gap-3">
            <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
              {t('feedback.rateExperience')}
            </Text>
            <View className="flex-row gap-2">
              {[1, 2, 3, 4, 5].map((star) => (
                <Pressable
                  key={star}
                  onPress={() => setRating(rating === star ? null : star)}
                  className="p-1.5 active:opacity-70"
                >
                  <Star
                    size={24}
                    className={rating && star <= rating ? "text-yellow-500" : "text-muted-foreground"}
                    fill={rating && star <= rating ? "#eab308" : "transparent"}
                  />
                </Pressable>
              ))}
            </View>
            {rating && (
              <Text className="text-xs text-muted-foreground">
                {ratingLabels[rating]}
              </Text>
            )}
          </View>

          {/* Message */}
          <View className="gap-3">
            <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
              {t('feedback.yourFeedback')}
            </Text>
            <Textarea
              placeholder={selectedType ? placeholderMap[selectedType] : t('feedback.otherPlaceholder')}
              value={message}
              onChangeText={setMessage}
              className="min-h-[150px]"
            />
            <Text className="text-xs text-muted-foreground">
              {t('feedback.characterCount', { count: message.length })}
            </Text>
          </View>

          {/* Submit Button */}
          <View className="gap-4 pt-2">
            <Button
              onPress={handleSubmit}
              disabled={submitting || !selectedType || !message.trim()}
            >
              {submitting ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Text className="text-sm font-medium text-primary-foreground">
                  {t('feedback.submitButton')}
                </Text>
              )}
            </Button>

            <Text className="text-xs text-center text-muted-foreground">
              {t('feedback.footerText')}
            </Text>
          </View>
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}
