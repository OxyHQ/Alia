import React from "react";
import { StyleSheet, View } from "react-native";
import { ComposerLoader } from "@oxy.so/bloom/composer-loader";

/**
 * The composer while an answer is on its way: Bloom's `ComposerLoader`, and
 * nothing of ours.
 *
 * This is the one export of Bloom's two composer families that Alia can take
 * whole. `ComposerLoaderProps.active` is a plain boolean with a 450ms fade and
 * no opinion about what it is waiting for, so it is driven straight from the
 * turn state the page already computes. Everything else in `composer-panel`
 * either keys models by display name, has no stop control, or invents the
 * number it is drawing — see the report in `docs/bloom-adoption.mdx` §3.
 *
 * ## Why it is an overlay and not a wrapper
 *
 * Bloom means the loader to WRAP the pill: it paints the pill's surface itself,
 * lays the band over it and puts the (transparent) composer on top, which is
 * why `surface` defaults to `true`. Alia's bar paints its own surface, and that
 * paint is not incidental — it is `bg-card` under a three-part web shadow whose
 * hairline, lift and ambient spread are tuned in `prompt-input.tsx`, it changes
 * corner across collapsed, expanded and fullscreen, and `attachments.test.tsx`
 * reads that corner back out so the attachment tiles stay concentric with it.
 * Handing the surface to Bloom would have swapped all of it for
 * `theme.colors.card` and Bloom's `BUTTON_SHADOW`, silently, for the length of
 * every stream.
 *
 * So the light mounts INSIDE the bar as an absolutely filled layer with
 * `surface={false}`: Bloom draws only the band, the bar's own `overflow-hidden`
 * clips the outer half of the stroke to the bar's own corner, and the bar keeps
 * its paint. It is the bar's FIRST child rather than its last, which is what
 * keeps the text crisp — a child renders above its parent's background and
 * below its later siblings, so the band lies on the surface while the textarea,
 * the add menu and the send button sit over the top of it. Mounted last, the
 * 16px inward bloom would be a veil across the draft.
 *
 * ## It is not the ambient background, and must never become it
 *
 * `components/ambient-field.tsx` is a full-screen, audio-reactive brand layer
 * behind the whole chat. This is a 2.5px line orbiting one control. They answer
 * to different things — one to the brand and the voice session, one to whether
 * THIS turn is still coming — and the light is bounded by the bar precisely so
 * it can never grow into the other.
 *
 * ## Hidden from assistive technology, on purpose
 *
 * A screen reader is already told a turn is in flight twice over: the send
 * button has become "Stop generating" and the textbox reports itself
 * uneditable. The band is that same fact drawn for eyes, so announcing it a
 * third time is noise. `pointerEvents="none"` keeps it from swallowing a tap
 * meant for the textarea underneath it.
 */
export type PromptInputWorkingLightProps = {
  /** Lit while the turn is in flight. Bloom fades it in and out over 450ms. */
  active: boolean;
  /**
   * The bar's corner, so the band traces the shape the bar is actually wearing
   * rather than the full pill Bloom assumes when `radius` is omitted. It comes
   * from `COMPOSER_RADIUS`, the same number the attachment tiles derive theirs
   * from.
   */
  radius: number;
};

export function PromptInputWorkingLight({
  active,
  radius,
}: PromptInputWorkingLightProps) {
  return (
    <View
      // Stays mounted through `active === false` rather than being rendered
      // conditionally: the fade is a CSS opacity transition on web and a
      // `withTiming` on native, and both animate a CHANGE — unmounting the
      // light when the stream ends would cut its 450ms fade-out to one frame.
      // Idling is cheap on both: the native fork calls `clock.setActive(false)`
      // 450ms after the flag drops, so no frame callback survives the fade, and
      // web leaves a hidden `<svg>` at zero opacity whose keyframes
      // `prefers-reduced-motion` stops outright.
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      <ComposerLoader
        active={active}
        // The bar's paint is the bar's. See the note above.
        surface={false}
        radius={radius}
        style={StyleSheet.absoluteFill}
      >
        {null}
      </ComposerLoader>
    </View>
  );
}
