import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { useTranslation } from "@/lib/hooks/use-translation";

interface NewConversationOfferProps {
  /**
   * The model's own sentence for why it is offering, in the model's own words,
   * or empty when it sent none.
   *
   * Never translated and never rewritten. A substitute we invented would read
   * as the agent's reasoning while being ours, and a plausible one is worse
   * than none — so an empty reason simply drops the line.
   */
  reason: string;
  onAccept: () => void;
  onDismiss: () => void;
}

/**
 * The agent offering to start the next stretch of the thread fresh.
 *
 * ## It is an offer, and the shape has to say so
 *
 * Nothing has been written when this appears: the tool behind it creates
 * nothing, so ignoring it leaves the thread exactly as it was. That is why this
 * is a card at the end of the list rather than a dialog — it does not cover
 * what somebody is reading, does not take focus from the composer, and carries
 * on being ignorable for as long as they ignore it.
 *
 * Accepting is the person's act: it starts a conversation with the same agent.
 * The agent cannot do that itself, by construction rather than by policy.
 */
export const NewConversationOffer = React.memo(function NewConversationOffer({
  reason,
  onAccept,
  onDismiss,
}: NewConversationOfferProps) {
  const { t } = useTranslation();

  return (
    <View className="my-4 gap-2 rounded-2xl border border-border bg-muted/40 p-4">
      <Text className="text-sm font-medium text-foreground">
        {t("chat.newConversationOffer")}
      </Text>
      {reason === "" ? null : (
        <Text className="text-sm text-muted-foreground">{reason}</Text>
      )}
      <View className="flex-row items-center gap-2 pt-1">
        <Pressable
          accessibilityRole="button"
          onPress={onAccept}
          className="rounded-full bg-primary px-4 py-2 active:opacity-80"
        >
          <Text className="text-sm font-medium text-primary-foreground">
            {t("chat.newConversationAccept")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onDismiss}
          className="rounded-full px-4 py-2 active:opacity-70"
        >
          <Text className="text-sm text-muted-foreground">
            {t("chat.newConversationDismiss")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
});
