import type { AiChatTurnAction } from '@oxy.so/bloom/ai-chat';
import { ReactionPicker } from '@oxy.so/bloom/chat-composer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { useInteractionState } from '@oxy.so/bloom/hooks';
import { useTheme, withAlpha } from '@oxy.so/bloom/theme';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useLabels } from '../../lib/labels';
import { RiEmojiPicker } from '../icons/RiEmojiPicker';
import { RiMoreDots } from '../icons/RiMoreDots';
import { RiReplyLine } from '../icons/RiReplyLine';

type Glyph = (props: { width?: number; height?: number; fill?: string }) => ReactNode;

/**
 * One turn as a chat bubble, built after the bubbles of the agent chat this thread is modelled on.
 *
 * The row is a line with an 8px gap: the person's bubble hugs the end with its icons on the side
 * facing the thread, a reply hugs the start with its icons after it. A bubble is 24px round, up to
 * 80% of the column and 16px in from its sides; the person's is 12px tall at both ends and in the
 * theme's primary (the agent's colour: the app is themed by it), a reply's is 8px and neutral. The icons are the three of that chat, 24px round
 * buttons holding a 16px glyph: react (a reply's only: it is a vote), reply (quotes the turn into
 * the composer) and more (the rest of the turn's actions). They show while the row is hovered or a
 * menu of theirs is open, and always on a touch screen, which has no hover to reveal them.
 */
export function ChatBubble({
  side,
  reactions = [],
  onReact,
  menu = [],
  onReply,
  children,
}: {
  side: 'user' | 'reply';
  /** The emoji left on this turn: drawn as pills under the bubble. */
  reactions?: readonly string[];
  /** Leave an emoji on this turn, or take it back (a pill pressed, or a pick of the picker). Absent: no react button. */
  onReact?: (emoji: string) => void;
  /** What "more" offers: every other action of the turn. */
  menu?: ReadonlyArray<AiChatTurnAction>;
  /** Quote this turn into the composer. */
  onReply?: () => void;
  /** The words. A function is handed the colour text takes on the person's bubble (the theme's). */
  children: ReactNode | ((foreground: string | undefined) => ReactNode);
}) {
  const { t } = useLabels();
  const theme = useTheme();
  const { state: hovered, onIn, onOut } = useInteractionState();
  const [pinned, setPinned] = useState(false);
  const mine = side === 'user';
  // The person's bubble is the theme's primary: Bloom's theme is seeded from the agent's colour, and
  // Bloom picks the text that reads on it.
  const mineColors = mine
    ? { background: theme.colors.primary, foreground: theme.colors.primaryForeground }
    : null;
  const shown = Platform.OS !== 'web' || hovered || pinned;
  const hasIcons = onReact !== undefined || onReply !== undefined || menu.length > 0;
  const icons = !hasIcons ? null : (
    <View
      className="shrink-0 flex-row items-center gap-0.5"
      style={{ opacity: shown ? 1 : 0 }}
      pointerEvents={shown ? 'auto' : 'none'}
    >
      {onReact === undefined ? null : (
        <ReactMenu
          label={t('chat.reactToMessage')}
          held={reactions}
          onReact={onReact}
          onOpenChange={setPinned}
        />
      )}
      {onReply === undefined ? null : (
        <IconButton label={t('chat.replyToMessage')} icon={RiReplyLine} onPress={onReply} />
      )}
      {menu.length === 0 ? null : (
        <ActionMenu
          label={t('chat.moreActions')}
          icon={RiMoreDots}
          actions={menu}
          onOpenChange={setPinned}
        />
      )}
    </View>
  );
  return (
    <View
      className="w-full py-2"
      {...(Platform.OS === 'web' ? { onPointerEnter: onIn, onPointerLeave: onOut } : {})}
    >
      <View
        className={`w-full flex-row items-center gap-2 ${mine ? 'justify-end' : 'justify-start'}`}
      >
        {mine ? icons : null}
        <View
          className={`min-w-0 max-w-[80%] rounded-3xl px-4 ${
            mine ? 'py-3' : 'bg-background-tertiary-default py-2'
          }`}
          style={mineColors ? { backgroundColor: mineColors.background } : undefined}
        >
          {typeof children === 'function' ? children(mineColors?.foreground) : children}
        </View>
        {mine ? null : icons}
      </View>
      {reactions.length === 0 ? null : (
        // The reactions sit on the bubble's lower edge, as the chat this is modelled on draws them.
        <View
          className={`-mt-2.5 flex-row flex-wrap items-center gap-1 ${
            mine ? 'justify-end me-2.5' : 'justify-start ms-2.5'
          }`}
        >
          {reactions.map((emoji) => (
            <ReactionPill
              key={emoji}
              emoji={emoji}
              onPress={onReact === undefined ? undefined : () => onReact(emoji)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** One reaction under a bubble: the emoji on a wash of the theme's primary, ringed in the surface. */
function ReactionPill({ emoji, onPress }: { emoji: string; onPress?: () => void }) {
  const theme = useTheme();
  const { t } = useLabels();
  const { state: hovered, onIn, onOut } = useInteractionState();
  return (
    <Pressable
      onHoverIn={onIn}
      onHoverOut={onOut}
      accessibilityRole="button"
      accessibilityLabel={t('chat.reaction', { emoji })}
      accessibilityState={{ selected: true }}
      disabled={onPress === undefined}
      onPress={onPress}
      className="h-[22px] flex-row items-center rounded-full px-2"
      style={{
        backgroundColor: withAlpha(theme.colors.primary, hovered ? 0.16 : 0.12),
        borderWidth: 2,
        borderColor: theme.colors.background,
      }}
    >
      <Text className="text-sm leading-none">{emoji}</Text>
    </Pressable>
  );
}

/** The react button: it opens Bloom's emoji bar, and a pick leaves the emoji (or takes it back). */
function ReactMenu({
  label,
  held,
  onReact,
  onOpenChange,
}: {
  label: string;
  held: readonly string[];
  onReact: (emoji: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange(next);
  };
  return (
    <DropdownMenu open={open} onOpenChange={change}>
      <DropdownMenuTrigger asChild label={label}>
        <IconButton label={label} icon={RiEmojiPicker} />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <ReactionPicker
          surface={false}
          size="sm"
          selected={held.length === 1 ? held[0] : undefined}
          onSelectEmoji={(emoji) => {
            onReact(emoji);
            change(false);
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A button of the icon group that opens a menu of the turn's actions. */
function ActionMenu({
  label,
  icon,
  actions,
  onOpenChange,
}: {
  label: string;
  icon: Glyph;
  actions: ReadonlyArray<AiChatTurnAction>;
  onOpenChange: (open: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild label={label}>
        <IconButton label={label} icon={icon} />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {actions.map((action) => {
          const Item = action.icon;
          return (
            <DropdownMenuItem
              key={action.key}
              disabled={action.disabled}
              onPress={action.onPress}
              leading={<Item width={16} height={16} fill={theme.colors.textSecondary} />}
            >
              {action.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A 24px round button holding a 16px glyph, washed on hover. It forwards what a trigger hands it. */
function IconButton({
  label,
  icon: Icon,
  onPress,
  ...rest
}: { label: string; icon: Glyph } & Omit<ComponentProps<typeof Pressable>, 'children'>) {
  const theme = useTheme();
  const { state: hovered, onIn, onOut } = useInteractionState();
  return (
    <Pressable
      {...rest}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={onIn}
      onHoverOut={onOut}
      className="size-6 items-center justify-center rounded-full"
      style={{ backgroundColor: hovered ? theme.colors.backgroundSecondary : undefined }}
    >
      <Icon
        width={16}
        height={16}
        fill={hovered ? theme.colors.text : theme.colors.textSecondary}
      />
    </Pressable>
  );
}
