import React from "react";
import { View, Pressable } from "react-native";
import { AlertTriangle } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useTranslation } from "@/lib/hooks/use-translation";

interface FailedTurnCardProps {
  /** Real output arrived before the failure — the wording says "interrupted", not "couldn't answer". */
  partial: boolean;
  /** Whether a retry is offered at all. */
  retryable: boolean;
  /** The server's own words, if any, under the line. */
  detail?: string;
  onRetry?: () => void;
}

/**
 * The error a failed turn is drawn with, in the thread, under the turn.
 *
 * A card in the list rather than a toast, because the whole point is that it
 * STAYS: the person's message is still there above it, the reason it has no
 * answer is stated beside it, and the way to try again is a button on it —
 * for as long as they leave it, not for the four seconds a toast lasts.
 *
 * The server's stand-in text ("all models are busy…") is never shown here as
 * Alia's words; the copy is the app's own, in the reader's language.
 */
export const FailedTurnCard = React.memo(function FailedTurnCard({
  partial,
  retryable,
  detail,
  onRetry,
}: FailedTurnCardProps) {
  const { t } = useTranslation();
  const line = partial ? t("chat.turnInterrupted") : t("chat.turnFailed");
  const canRetry = retryable && onRetry !== undefined;

  return (
    <View
      accessibilityRole="alert"
      className="my-2 flex-row items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3"
    >
      <View className="pt-1">
        <AlertTriangle size={16} className="text-destructive" />
      </View>
      <View className="flex-1 gap-1">
        <Text className="text-sm text-foreground leading-5">
          {canRetry ? `${line} ${t("chat.turnFailedRetryHint")}` : line}
        </Text>
        {detail === undefined || detail === "" ? null : (
          <Text className="text-xs text-muted-foreground leading-4">{detail}</Text>
        )}
      </View>
      {!canRetry ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("chat.retry")}
          onPress={onRetry}
          className="rounded-full bg-primary px-3.5 py-1.5 active:opacity-80"
        >
          <Text className="text-sm font-medium text-primary-foreground">{t("chat.retry")}</Text>
        </Pressable>
      )}
    </View>
  );
});
