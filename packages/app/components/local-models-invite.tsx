import { useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { Popover, PopoverContent, PopoverTrigger } from "@oxyhq/bloom/popover";
import { useAuth } from "@oxyhq/services";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useIsLargeScreen } from "@/lib/hooks/use-is-large-screen";
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
  const inviteSeen = useLocalRuntimeStore((state) => state.inviteSeen);
  const markInviteSeen = useLocalRuntimeStore((state) => state.markInviteSeen);

  /**
   * Only for somebody who has signed in.
   *
   * A signed-out visitor is looking at the intro — "Meet Alia" owns the panel
   * until there is an account — and this card renders through a portal, so it
   * came out ON TOP of it: the product's first sentence buried under a question
   * about localhost. Waiting for an account is not a z-index workaround, it is
   * the honest order. There is nothing to offer a person who has not arrived.
   */
  const { isAuthenticated } = useAuth();

  /**
   * Dismissed for this run only.
   *
   * Tapping outside is not an answer. Recording it as `declined` would turn a
   * stray tap into a permanent no, and recording nothing would put the card
   * back the moment anything re-rendered — so it is held here, and the question
   * returns on the next launch until it is actually answered.
   */
  const [hidden, setHidden] = useState(false);

  /**
   * Not offered on a small screen, and the reason is not screen real estate.
   *
   * Granting consent probes THIS device's own `localhost`. A phone has no model
   * server on it, so the answer is always nothing — the phone reaches a laptop's
   * models through the LAPTOP's tab, which announced them, never through its
   * own. Asking here would be asking a question whose only possible answer is
   * no, and then remembering the no.
   *
   * `useIsLargeScreen` rather than an `md:` class because this decides whether a
   * tree MOUNTS, which is the split `AGENTS.md` draws — `md:` is for styling.
   */
  const isLargeScreen = useIsLargeScreen();

  /**
   * Latched, because recording the ask is what would otherwise end it.
   *
   * `inviteSeen` is written the moment the card appears — so a person who
   * navigates away instead of answering is not asked again on the next launch
   * either. But the same flag is in the condition that put it on screen, so
   * without a latch that write would close the card on the very next render and
   * nobody would read a word of it.
   */
  const [latched, setLatched] = useState(false);
  const eligible = isAuthenticated && consent === "unasked" && !hidden && isLargeScreen;
  const showing = eligible && (latched || !inviteSeen);

  useEffect(() => {
    if (!showing || latched) return;
    setLatched(true);
    // The record is of the ASKING. `consent` is untouched: the question stays
    // unanswered, so the setting still offers what a dismissal never decided.
    markInviteSeen();
  }, [showing, latched, markInviteSeen]);

  if (!showing) return <>{children}</>;

  return (
    <Popover open onOpenChange={(next) => { if (!next) setHidden(true); }}>
      <PopoverTrigger asChild disabled>
        <View>{children}</View>
      </PopoverTrigger>
      <PopoverContent
        label={t("models.localInvite.title")}
        /**
         * The card is 320px and bleeds to its own edge, so Bloom's popover
         * chrome has to step aside — `POPOVER_CLASS` is `w-72 p-space-16`, a
         * 288px card with a 16px inset, which is right for prose and wrong for
         * a picture that reaches the corners.
         *
         * Not overridden with `className="w-80 p-0"`, which is what Bloom's own
         * comment suggests: `floating/shared.tsx` `cx` is a plain join, so two
         * utilities for one property are resolved by Tailwind's EMISSION order
         * rather than by their order in the attribute — the same hazard Bloom
         * documents for `cursor-pointer` and solves there by making the pair
         * mutually exclusive. `p-0` sorts before `p-4`, so it would lose.
         *
         * The width goes through the props the surface publishes for it, and
         * the padding through `style`, which is an inline style and therefore
         * beats the class outright. Everything with a choice stays in NativeWind.
         */
        minWidth={320}
        maxWidth={320}
        style={{ padding: 0 }}
      >
        <View className="w-full overflow-hidden">
          <Image
            source={ARTWORK}
            // Decorative: the sentence below carries the meaning, so announcing
            // the picture would only add noise to a screen reader.
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            contentFit="cover"
            className="h-40 w-full"
          />
          <View className="gap-1 px-4 pt-3">
            <Text className="text-base font-semibold text-foreground">
              {t("models.localInvite.title")}
            </Text>
            <Text className="text-sm text-muted-foreground">
              {t("models.localInvite.body")}
            </Text>
          </View>
          {/* `flex-row-reverse` + `justify-between`: the affirmative sits on the
              right and the dismissal on the far left, which is the arrangement
              the reference uses. */}
          <View className="flex-row-reverse items-center justify-between p-3 pt-4">
            <Button size="sm" className="h-8 rounded-full px-2.5" onPress={() => setConsent("granted")}>
              <Text className="text-sm font-semibold">{t("models.localInvite.accept")}</Text>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 h-8 rounded-full px-2.5"
              onPress={() => setConsent("declined")}
            >
              <Text className="text-sm text-muted-foreground">
                {t("models.localInvite.decline")}
              </Text>
            </Button>
          </View>
        </View>
      </PopoverContent>
    </Popover>
  );
}
