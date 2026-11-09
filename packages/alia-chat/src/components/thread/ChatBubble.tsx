import type { AiChatTurnAction } from '@oxy.so/bloom/ai-chat';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { useInteractionState } from '@oxy.so/bloom/hooks';
import { RiEmotionLine } from '@oxy.so/bloom/icons/RiEmotionLine';
import { RiMoreFill } from '@oxy.so/bloom/icons/RiMoreFill';
import { useTheme } from '@oxy.so/bloom/theme';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import type { BubbleColors } from '../../lib/bubble-colors';
import { useLabels } from '../../lib/labels';
import { RiReplyLine } from '../icons/RiReplyLine';

type Glyph = (props: { width?: number; height?: number; fill?: string }) => ReactNode;

/**
 * One turn as a chat bubble, built after the bubbles of the agent chat this thread is modelled on.
 *
 * The row is a line with an 8px gap: the person's bubble hugs the end with its icons on the side
 * facing the thread, a reply hugs the start with its icons after it. A bubble is 24px round, up to
 * 80% of the column and 16px in from its sides; the person's is 12px tall at both ends and in the
 * agent's colour, a reply's is 8px and neutral. The icons are the three of that chat, 24px round
 * buttons holding a 16px glyph: react (a reply's only: it is a vote), reply (quotes the turn into
 * the composer) and more (the rest of the turn's actions). They show while the row is hovered or a
 * menu of theirs is open, and always on a touch screen, which has no hover to reveal them.
 */
export function ChatBubble({
  side,
  colors,
  react = [],
  menu = [],
  onReply,
  children,
}: {
  side: 'user' | 'reply';
  /** The person's bubble colours; a reply's are always the neutral ones. */
  colors?: BubbleColors | null;
  /** What "react" offers: a vote up and a vote down. */
  react?: ReadonlyArray<AiChatTurnAction>;
  /** What "more" offers: every other action of the turn. */
  menu?: ReadonlyArray<AiChatTurnAction>;
  /** Quote this turn into the composer. */
  onReply?: () => void;
  /** The words. A function is handed the colour text takes on the person's bubble. */
  children: ReactNode | ((foreground: string | undefined) => ReactNode);
}) {
  const { t } = useLabels();
  const theme = useTheme();
  const { state: hovered, onIn, onOut } = useInteractionState();
  const [pinned, setPinned] = useState(false);
  const mine = side === 'user';
  // The person's bubble is the agent's colour, or the theme's own until the agent's is known.
  const mineColors = !mine
    ? null
    : (colors ?? { background: theme.colors.primary, foreground: theme.colors.primaryForeground });
  const shown = Platform.OS !== 'web' || hovered || pinned;
  const hasIcons = react.length > 0 || onReply !== undefined || menu.length > 0;
  const icons = !hasIcons ? null : (
    <View
      className="shrink-0 flex-row items-center gap-0.5"
      style={{ opacity: shown ? 1 : 0 }}
      pointerEvents={shown ? 'auto' : 'none'}
    >
      {react.length === 0 ? null : (
        <ActionMenu
          label={t('chat.reactToMessage')}
          icon={RiEmotionLine}
          actions={react}
          onOpenChange={setPinned}
        />
      )}
      {onReply === undefined ? null : (
        <IconButton label={t('chat.replyToMessage')} icon={RiReplyLine} onPress={onReply} />
      )}
      {menu.length === 0 ? null : (
        <ActionMenu
          label={t('chat.moreActions')}
          icon={RiMoreFill}
          actions={menu}
          onOpenChange={setPinned}
        />
      )}
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
        style={mineColors ? { backgroundColor: mineColors.background } : undefined}
      >
        {typeof children === 'function' ? children(mineColors?.foreground) : children}
      </View>
      {mine ? null : icons}
    </View>
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
