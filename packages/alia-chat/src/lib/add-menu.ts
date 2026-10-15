import type { ComposerPanelAddMenuGroup } from '@oxy.so/bloom/composer-panel';

/** The rows of the composer's add menu, and what pressing one does. */
export interface AliaAddMenu {
  groups: readonly ComposerPanelAddMenuGroup[];
  onSelect: (rowId: string) => void;
}
