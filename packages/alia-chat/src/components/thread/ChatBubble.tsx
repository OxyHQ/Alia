import type { AiChatTurnAction } from '@oxy.so/bloom/ai-chat';
import { useInteractionState } from '@oxy.so/bloom/hooks';
import { useTheme } from '@oxy.so/bloom/theme';
import type { ReactNode } from 'react';
import { Platform, Pressable, View } from 'react-native';
import type { BubbleColors } from '../../lib/bubble-colors';

/**
 * One turn as a chat bubble, built after the bubbles of the agent chat this thread is modelled on.
 *
 * The row is a line with a 8px gap: the person's bubble hugs the end with its icons on the side
 * facing the thread, a reply hugs the start with its icons after it. A bubble is 24px round, up to
 * 80% of the column, 16px in from its sides; the person's is 12px tall at both ends and in the
 * agent's colour, a reply's is 8px and neutral. The icons are 24px round buttons holding a 16px
 * glyph, drawn only while the row is hovered (they are always there on a touch screen, which has
 * no hover to reveal them).
 */
export function ChatBubble({
  side,
  colors,
  actions = [],
  children,
}: {
  side: 'user' | 'reply';
  /** The person's bubble colours; a reply's are always the neutral ones. */
  colors?: BubbleColors | null;
  actions?: ReadonlyArray<AiChatTurnAction>;
  children: ReactNode;
}) {
  const { state: hovered, onIn, onOut } = useInteractionState();
  const mine = side === 'user';
  const shown = Platform.OS !== 'web' || hovered;
  const icons =
    actions.length === 0 ? null : (
      <View
        className="shrink-0 flex-row items-center gap-0.5"
        style={{ opacity: shown ? 1 : 0 }}
        pointerEvents={shown ? 'auto' : 'none'}
      >
        {actions.map((action) => (
          <BubbleIconButton key={action.key} action={action} />
        ))}
      </View>
    );
  return (
    <View
      className={`w-full flex-row items-center gap-2 py-2 ${mine ? 'justify-end' : 'justify-start'}`}
      {...(Platform.OS === 'web' ? { onPointerEnter: onIn, onPointerLeave: onOut } : {})}
    >
      {mine ? icons : null}
      <View
        className={`min-w-0 max-w-[80%] rounded-3xl px-4 ${
          mine ? 'py-3' : 'bg-background-tertiary-default py-2'
        }`}
        style={mine && colors ? { backgroundColor: colors.background } : undefined}
      >
        {children}
      </View>
      {mine ? null : icons}
    </View>
  );
}

/** A 24px round icon button holding a 16px glyph, washed on hover or while it is on. */
function BubbleIconButton({ action }: { action: AiChatTurnAction }) {
  const theme = useTheme();
  const { state: hovered, onIn, onOut } = useInteractionState();
  const Icon = action.icon;
  const on = action.active === true || hovered;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ disabled: action.disabled === true, selected: action.active === true }}
      disabled={action.disabled}
      onPress={action.onPress}
      onHoverIn={onIn}
      onHoverOut={onOut}
      testID={`bubble-action-${action.key}`}
      className="size-6 items-center justify-center rounded-full"
      style={{
        backgroundColor: on ? theme.colors.backgroundSecondary : undefined,
        opacity: action.disabled === true ? 0.5 : 1,
      }}
    >
      <Icon width={16} height={16} fill={on ? theme.colors.text : theme.colors.textSecondary} />
    </Pressable>
  );
}
