import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { Popover, PopoverContent, PopoverTrigger } from "@oxyhq/bloom/popover";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useLocalRuntimeStore } from "@/lib/stores/local-runtime-store";

const ARTWORK = require("@/assets/images/local-models.webp");

/**
 * The one time Alia asks whether it may look for a model on this machine.
 *
 * ## Why it asks before it looks
 *
 * Detecting first and asking afterwards would be a single request from the
 * person's own browser to their own machine — cheap, and it tells nobody
 * anything. It was the first design for exactly that reason. It is not what
 * ships, because Chrome is moving toward prompting for local network access
 * itself, and a browser permission dialog arriving with no context is a worse
 * first encounter than a question inside the product. So the product asks, and
 * `use-local-runtime.ts` touches nothing until the answer is `granted`.
 *
 * The cost is that it asks people for whom the answer is irrelevant: most
 * accounts run no local model server and never will. It is mitigated by
 * placement rather than by frequency — it hangs off the model picker, so it is
 * seen while choosing a model and nowhere else.
 *
 * ## Why the trigger is `disabled`
 *
 * This popover is not opened by pressing anything: it is controlled, and the
 * selector underneath must keep working while it is up. Bloom's `TriggerSlot`
 * is what makes that safe — with `disabled` set, `cloneTrigger` keeps the
 * child's own `onPress` and does not compose its own:
 *
 *     onPress: isDisabled ? childProps.onPress : (e) => { child(e); handle(e) }
 *
 * The anchor lives on the wrapper `StyledView` that `TriggerSlot` always
 * renders, so the box is measured without anything being attached to the
 * selector at all.
 */
export function LocalModelsInvite({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const consent = useLocalRuntimeStore((state) => state.consent);
  const setConsent = useLocalRuntimeStore((state) => state.setConsent);

  /**
   * Dismissed for this run only.
   *
   * Tapping outside is not an answer. Recording it as `declined` would turn a
   * stray tap into a permanent no, and recording nothing would put the card
   * back the moment anything re-rendered — so it is held here, and the question
   * returns on the next launch until it is actually answered.
   */
  const [hidden, setHidden] = useState(false);

  if (consent !== "unasked" || hidden) return <>{children}</>;

  return (
    <Popover open onOpenChange={(next) => { if (!next) setHidden(true); }}>
      <PopoverTrigger asChild disabled>
        <View>{children}</View>
      </PopoverTrigger>
      <PopoverContent label={t("models.localInvite.title")}>
        <View className="w-64 overflow-hidden rounded-2xl">
          <Image
            source={ARTWORK}
            // Decorative: the sentence below carries the meaning, so announcing
            // the picture would only add noise to a screen reader.
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            contentFit="cover"
            className="h-[84px] w-full"
          />
          <View className="gap-1 px-3 pt-2.5">
            <Text className="text-sm font-semibold text-foreground">
              {t("models.localInvite.title")}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {t("models.localInvite.body")}
            </Text>
          </View>
          <View className="flex-row items-center gap-2 px-3 pb-3 pt-2.5">
            <Button size="sm" className="h-7 px-3" onPress={() => setConsent("granted")}>
              <Text className="text-xs">{t("models.localInvite.accept")}</Text>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2.5"
              onPress={() => setConsent("declined")}
            >
              <Text className="text-xs text-muted-foreground">
                {t("models.localInvite.decline")}
              </Text>
            </Button>
          </View>
        </View>
      </PopoverContent>
    </Popover>
  );
}
