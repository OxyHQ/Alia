/**
 * The three answers the composer derives on every keystroke, as arithmetic.
 *
 * All three used to be computed inline in `components/ui/prompt-input/
 * prompt-input.tsx`, in the middle of a 677-line component that also owns a
 * recorder, a portal, a CSS grid, a fullscreen choreography and a measuring
 * mirror. They are the part of that file that is easy to get subtly wrong and
 * almost impossible to watch going wrong — a bar that oscillates between two
 * shapes near a line wrap, a light still lit after the stream ended, a message
 * sent halfway through an IME candidate — and not one of them needs React, a
 * platform or a theme to decide.
 *
 * `lib/chat/turn-selection.ts` next door is the precedent and states the reason
 * plainly: "being a plain function it is also testable without mounting a
 * composer". Nothing here may import react-native, and nothing here may read a
 * store — an answer that depends on a renderer is an answer that can only be
 * checked by rendering.
 */

/** Height (px) of the collapsed bar's single-line track. */
export const SINGLE_LINE_TRACK = 44;

/**
 * Height above which the text no longer fits the collapsed single-line track.
 *
 * The value compared against this threshold is always measured at the COLLAPSED
 * width, even while the visible composer is expanded — which is why
 * `prompt-input.tsx` keeps an invisible `Text` mirror inset by the two control
 * clusters. Collapsed text is narrower because it shares its row with those
 * clusters, while the expanded textarea spans the whole bar, so measuring the
 * VISIBLE field produced a genuine feedback loop: a value wraps while collapsed,
 * the bar expands, the same value fits on one line at the wider measure, the bar
 * collapses, and it wraps again. The mirror is the stable frame of reference
 * that breaks it.
 */
export const EXPAND_ABOVE = 56;

/** The three visual states of the ONE bar. */
export type ComposerBarState = "collapsed" | "expanded" | "fullscreen";

export interface ComposerBarInput {
  /** False when the caller supplied its own children instead of the built-in bar. */
  isSimpleMode: boolean;
  /** A model AND a change handler were given: this is the chat composer. */
  isChatComposer: boolean;
  /** Entered through the maximize affordance — never derived from the content. */
  isFullscreen: boolean;
  isLargeScreen: boolean;
  /** The draft, as it stands. */
  value: string;
  attachmentCount: number;
  /**
   * The mirror's measured height at the COLLAPSED width — see
   * {@link EXPAND_ABOVE}. The live textarea height is an acceptable stand-in
   * only until the mirror has been laid out once.
   */
  collapsedHeight: number;
}

/**
 * Which of the three states the bar is in.
 *
 * Fullscreen wins outright, because it is entered by a deliberate press rather
 * than derived from the content; below it the value's fit decides. The chat
 * composer on a small screen is always expanded: its trailing cluster (model,
 * effort, mic, send) cannot share a 44px track with the text on a phone, and
 * letting it try produced a row where every control was clipped.
 */
export function composerBarState(input: ComposerBarInput): ComposerBarState {
  if (input.isFullscreen) return "fullscreen";
  const expanded =
    input.isSimpleMode &&
    ((input.isChatComposer && !input.isLargeScreen) ||
      input.value.includes("\n") ||
      input.attachmentCount > 0 ||
      input.collapsedHeight > EXPAND_ABOVE);
  return expanded ? "expanded" : "collapsed";
}

export interface ComposerWorkingLightInput {
  /** A turn is in flight — the same flag that swaps send for stop. */
  isLoading: boolean;
  /** The recorder is listening or transcribing, so the bar is not the composer. */
  isDictating: boolean;
  state: ComposerBarState;
  isChatComposer: boolean;
}

/**
 * Whether the composer draws Bloom's rim light at all, and whether it is lit.
 *
 * `null` means "draw nothing", which is a different answer from "draw it
 * unlit": a light that is never drawn is never mounted, while one drawn unlit
 * keeps `ComposerLoader`'s 450ms fade available for the instant it comes on.
 * Returning a boolean alone would have collapsed those two into one.
 *
 * ## It answers to the turn, and to nothing else
 *
 * `isLoading` is the stream the consumer is actually running — the same flag
 * `submit-button.tsx` reads to offer stop instead of send. So the light is
 * never a timer, never an estimate and never decoration: it is lit for exactly
 * as long as an answer is coming, and it goes out when the answer lands or the
 * person cancels it. Bloom's own `composer-panel/use-attachment-queue.ts` is
 * the counter-example this rule exists against — it fills an upload ring from
 * `Math.random()` on a 50ms tick and announces completion whether or not a byte
 * moved. A signal drawn from a number nobody measures is worse than no signal.
 *
 * ## And it belongs to the chat composer alone
 *
 * `null` for every other prompt input in the app. The generic input has no
 * stream to wait for — no `onStop`, and an `isLoading` nothing will ever set —
 * so a band orbiting it would be lit by a flag with no source. Dictation takes
 * the light away for a different reason: while the recorder is listening the
 * bar is not the composer at all, it is `dictation-bar.tsx`'s three controls,
 * and a light around those would be reporting on a stream that is not what the
 * person is looking at. Fullscreen takes it away for a third: that state is an
 * editor filling the viewport rather than a pill, and a 2.5px band tracing the
 * window's four edges reads as the whole app loading.
 */
export function composerWorkingLight(
  input: ComposerWorkingLightInput,
): { active: boolean } | null {
  if (!input.isChatComposer) return null;
  if (input.state === "fullscreen") return null;
  return { active: input.isLoading && !input.isDictating };
}

export interface EnterKeyInput {
  /** IME composition is a web concept; native reports nothing of the kind. */
  isWeb: boolean;
  /**
   * `KeyboardEvent.isComposing`, forwarded by react-native-web on the key-press
   * `nativeEvent` and absent everywhere else.
   */
  isComposing: boolean;
}

/**
 * Whether this Enter belongs to an input method rather than to the composer.
 *
 * ## What went wrong
 *
 * `components/ui/chat-text-input.tsx` decides Enter with one question — is the
 * Shift key down? — and sends on every Enter that is not shifted. In Japanese,
 * Chinese or Korean input the FIRST Enter after typing confirms the candidate
 * the IME is offering; the person has not finished the sentence, they have
 * finished one word of it. Under that rule the half-written message was sent,
 * and the confirmed word landed in an empty composer afterwards.
 *
 * ## Why this is Bloom's rule and not one of ours
 *
 * Both of Bloom's composers already ask the second question, and this function
 * is their condition read back out. `composer-panel/ComposerPanelBase.tsx`:
 *
 *     if (!IS_WEB || native.key !== 'Enter' || native.shiftKey || native.isComposing) return;
 *
 * and `ComposerPillBase.tsx` the same without the shift clause. Alia cannot
 * adopt either component — neither declares `onStop`, and the pill keys models
 * by display name — but the behaviour under them is a published contract, and
 * this is the part of it that fits through the seam Alia's own textarea has.
 *
 * Shift is deliberately NOT asked here: `ChatTextInput` already answers it, in
 * the same event, and asking twice in two places is how the two answers drift.
 */
export function imeOwnsEnter(input: EnterKeyInput): boolean {
  return input.isWeb && input.isComposing;
}
