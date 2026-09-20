import { Platform } from "react-native";
import { AiChatContainer } from "@oxy.so/bloom/ai-chat";

import { KeyboardAvoidingView } from "@/lib/keyboard";
import { AmbientField, type AmbientFieldProps } from "@/components/ambient-field";

/**
 * The chat's centre column: Bloom's, with Alia's sky behind it.
 *
 * ## The gradient is the reason this file exists
 *
 * `AmbientField` is the one piece of #608 that is named non-negotiable twice —
 * the brand gradient, its palette, and the way it swells with capture and
 * playback. It used to be a SIBLING rendered before the message list, which
 * worked only because Alia owned the whole column and could decide what sat
 * under what. Bloom's container paints its own `background-secondary` on its
 * root, so a sibling would have been painted over.
 *
 * `background` is the contract that resolves it, added to Bloom in 3.3.0 for
 * exactly this: a node drawn ABOVE the container's own surface and BELOW every
 * turn, header and composer, clipped to the container's radius and never
 * hit-testable. The field is therefore where it always was — behind the
 * conversation — without anybody reaching into Bloom's internals to put it
 * there, and without a fork.
 *
 * `surface` stays at its default. The field is opaque and fills the container,
 * so the surface under it is never seen; turning it off would only expose what
 * the container is sitting on during the field's own entrance.
 *
 * ## And the keyboard, which Bloom's AI Chat family does not handle
 *
 * Measured against `@oxy.so/bloom@3.3.0`: nothing in `src/ai-chat` or
 * `src/composer-panel` imports `react-native-keyboard-controller` or any
 * keyboard hook — only `bottom-sheet` does. `AiChatThread` is a plain
 * `ScrollView`, so on a device the thread would scroll under the keyboard and
 * the composer would sit behind it.
 *
 * On web that costs nothing: `lib/keyboard.tsx` is a no-op shim there and
 * Alia's "keyboard aware" scroll view has always been an ordinary
 * `ScrollView`. On native it is a real loss, on the two platforms this session
 * cannot test — so it is composed back rather than dropped.
 *
 * A `KeyboardAvoidingView` around the WHOLE container rather than inside it:
 * Bloom owns the scroll view and the composer's placement, and the host cannot
 * reach between them. Shrinking the container is the one lever available from
 * outside, it needs no knowledge of Bloom's internals, and it keeps both the
 * thread and the composer above the keyboard together.
 *
 * It is a wrapper on native and literally `View` on web, so no second layout
 * system appears on the platform that does not need one.
 */
export interface ChatWorkspaceProps {
  /** The chat's crumb. */
  title: string;
  /** The project it belongs to, or absent — Bloom draws the title alone. */
  project?: string;
  /** The shell's `AiChatMobileHeader`, above the breadcrumb. */
  header?: React.ReactNode;
  /** The composer and anything under it. */
  composer?: React.ReactNode;
  /** The turns — an `AiChatThread`. */
  children: React.ReactNode;
  /** Draws Bloom's working indicator above the composer. */
  working?: boolean;
  workingLabel?: string;
  onShare?: () => void;
  onMore?: () => void;
  onProjectPress?: () => void;
  /**
   * What the ambient field is reacting to. Passed through whole rather than
   * spread, because these change ~20x a second while an answer streams and the
   * field is the only thing that should re-render for them.
   */
  ambient: AmbientFieldProps;
}

export function ChatWorkspace({
  title,
  project,
  header,
  composer,
  children,
  working,
  workingLabel,
  onShare,
  onMore,
  onProjectPress,
  ambient,
}: ChatWorkspaceProps) {
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <AiChatContainer
        title={title}
        project={project}
        header={header}
        composer={composer}
        working={working}
        workingLabel={workingLabel}
        onShare={onShare}
        onMore={onMore}
        onProjectPress={onProjectPress}
        background={<AmbientField {...ambient} />}
        style={{ flex: 1 }}
      >
        {children}
      </AiChatContainer>
    </KeyboardAvoidingView>
  );
}
