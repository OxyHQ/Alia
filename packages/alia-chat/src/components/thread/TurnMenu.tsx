import type { AiChatTurnAction } from '@oxy.so/bloom/ai-chat';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@oxy.so/bloom/context-menu';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';

/**
 * The turn's actions as a long-press menu, on native.
 *
 * What a turn can do besides being read — copy, read aloud, regenerate, edit — is drawn by the
 * row with Bloom's turn actions: the feedback row under a reply, the action row under a question.
 * A phone has no hover, and those rows are small targets under a long reply; a long press anywhere
 * on the turn is where people look for them. Web keeps the rows alone: there a right-click on a
 * reply is the browser's own menu, with the text selection in it, and taking that away to show
 * the same buttons again would be a loss.
 */
const STRETCH = { alignSelf: 'stretch' } as const;

export function TurnMenu({
  actions,
  label,
  children,
}: {
  actions: ReadonlyArray<AiChatTurnAction>;
  label: string;
  children: ReactNode;
}) {
  if (Platform.OS === 'web' || actions.length === 0) return <>{children}</>;
  return (
    <ContextMenu>
      {/* Stretched: Bloom's trigger hugs its content by default, and a turn measures the column
          it is in (a question is half of it). */}
      <ContextMenuTrigger label={label} style={STRETCH}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {actions.map(({ key, label: rowLabel, icon: Icon, onPress, disabled }) => (
          <ContextMenuItem
            key={key}
            onPress={onPress}
            disabled={disabled}
            leading={<Icon size="sm" />}
          >
            {rowLabel}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
