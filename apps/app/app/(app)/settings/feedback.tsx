import { View, ScrollView, Pressable, ActivityIndicator } from "react-native";
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
import { Platform } from "react-native";

type FeedbackType = 'bug' | 'feature' | 'improvement' | 'other';

interface FeedbackTypeOption {
  type: FeedbackType;
  label: string;
  description: string;
  icon: React.ElementType;
}

const feedbackTypes: FeedbackTypeOption[] = [
  { type: 'bug', label: 'Bug Report', description: 'Something is broken or not working', icon: Bug },
  { type: 'feature', label: 'Feature Request', description: 'Suggest a new feature', icon: Lightbulb },
  { type: 'improvement', label: 'Improvement', description: 'Enhance existing functionality', icon: Sparkles },
  { type: 'other', label: 'Other', description: 'General feedback or comments', icon: MessageSquare },
];

export default function FeedbackScreen() {
  const router = useRouter();
  const { oxyServices } = useOxy();
  const [selectedType, setSelectedType] = useState<FeedbackType | null>(null);
  const [message, setMessage] = useState("");
  const [rating, setRating] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!selectedType) {
      toast.error("Please select a feedback type");
      return;
    }

    if (!message.trim()) {
      toast.error("Please enter your feedback message");
      return;
    }

    if (message.trim().length < 10) {
      toast.error("Please provide more details (at least 10 characters)");
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
        toast.success("Thank you for your feedback!");
        setSelectedType(null);
        setMessage("");
        setRating(null);
        router.back();
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to submit feedback");
      }
    } catch (error) {
      console.error("Error submitting feedback:", error);
      toast.error("Failed to submit feedback");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title="Send Feedback" subtitle="Help us improve Alia" showBack />

      <ScrollView className="flex-1 p-4">
        <View className="max-w-2xl mx-auto w-full gap-6">
          {/* Feedback Type Selection */}
          <View className="gap-3">
            <Text className="text-lg font-semibold">What type of feedback?</Text>
            <View className="gap-2">
              {feedbackTypes.map((option) => {
                const Icon = option.icon;
                const isSelected = selectedType === option.type;
                return (
                  <Pressable
                    key={option.type}
                    onPress={() => setSelectedType(option.type)}
                    className={`flex-row items-center gap-3 p-4 rounded-lg border ${
                      isSelected
                        ? 'border-primary bg-primary/10'
                        : 'border-border bg-muted/30'
                    }`}
                  >
                    <View className={`p-2 rounded-full ${isSelected ? 'bg-primary/20' : 'bg-muted'}`}>
                      <Icon size={20} className={isSelected ? 'text-primary' : 'text-muted-foreground'} />
                    </View>
                    <View className="flex-1">
                      <Text className={`font-medium ${isSelected ? 'text-primary' : 'text-foreground'}`}>
                        {option.label}
                      </Text>
                      <Text className="text-sm text-muted-foreground">
                        {option.description}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Rating (Optional) */}
          <View className="gap-3">
            <Text className="text-lg font-semibold">How would you rate your experience? (Optional)</Text>
            <View className="flex-row gap-2">
              {[1, 2, 3, 4, 5].map((star) => (
                <Pressable
                  key={star}
                  onPress={() => setRating(rating === star ? null : star)}
                  className="p-2"
                >
                  <Star
                    size={32}
                    className={rating && star <= rating ? 'text-yellow-500' : 'text-muted-foreground'}
                    fill={rating && star <= rating ? '#eab308' : 'transparent'}
                  />
                </Pressable>
              ))}
            </View>
            {rating && (
              <Text className="text-sm text-muted-foreground">
                {rating === 1 && "Very poor"}
                {rating === 2 && "Poor"}
                {rating === 3 && "Average"}
                {rating === 4 && "Good"}
                {rating === 5 && "Excellent"}
              </Text>
            )}
          </View>

          {/* Message */}
          <View className="gap-3">
            <Text className="text-lg font-semibold">Your feedback</Text>
            <Textarea
              placeholder={
                selectedType === 'bug'
                  ? "Describe the bug you encountered. What happened? What did you expect to happen?"
                  : selectedType === 'feature'
                  ? "Describe the feature you'd like to see. How would it help you?"
                  : selectedType === 'improvement'
                  ? "What would you like us to improve? How could we make it better?"
                  : "Share your thoughts with us..."
              }
              value={message}
              onChangeText={setMessage}
              className="min-h-[150px]"
            />
            <Text className="text-xs text-muted-foreground">
              {message.length}/1000 characters
            </Text>
          </View>

          {/* Submit Button */}
          <View className="gap-4 pt-4">
            <Button
              onPress={handleSubmit}
              disabled={submitting || !selectedType || !message.trim()}
              className="flex-row items-center justify-center gap-2"
            >
              {submitting ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <MessageSquare size={20} className="text-primary-foreground" />
              )}
              <Text className="text-primary-foreground font-semibold">
                {submitting ? "Submitting..." : "Submit Feedback"}
              </Text>
            </Button>

            <Text className="text-xs text-center text-muted-foreground">
              Your feedback helps us improve Alia. Thank you for taking the time to share your thoughts.
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
