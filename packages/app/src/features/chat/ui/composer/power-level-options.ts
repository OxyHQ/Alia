import { useCallback, useMemo } from 'react';
import type { ComposerPanelPermissionOption } from '@oxy.so/bloom/composer-panel';
import { buildPowerLevelOptions, type DeviceModel } from '@alia.onl/sdk';
import { resolveModeSelection, type ModeSelection } from '@alia.onl/sdk/model';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useLocalModelOptions } from '@/features/local-models/runtime/use-local-runtimes';

/**
 * The power-level selector's app side. The levels, their words and their glyphs are the SDK's
 * (`buildPowerLevelOptions`), the same on every surface; which of the person's own devices are
 * connected is the app's to say.
 */

/**
 * The stored choice resolved against the person's connected devices — the one answer the selector
 * draws and the request sends, so the two cannot disagree.
 */
export function useModeSelection(stored: string | null | undefined): ModeSelection {
  const { ids, loading } = useLocalModelOptions();
  return resolveModeSelection(stored, loading ? undefined : ids);
}

export interface PowerLevelSelector {
  readonly modes: readonly ComposerPanelPermissionOption[];
  readonly mode: string;
  readonly onModeChange: (mode: string) => void;
}

/** No device models, as one array for the life of the module. */
const NO_DEVICE_MODELS: readonly DeviceModel[] = [];

/**
 * The selector for a composer the app mounts on its own (creating an agent, describing a task).
 * The conversation's composer gets the same from the SDK chat (`model`, `onModelChange`).
 *
 * @param options.devices - Offer the person's own device models after the levels. Off where the
 *   choice is stored for something that runs in Alia's datacentre rather than on this person's
 *   machine (a new agent).
 */
export function usePowerLevelSelector(
  stored: string | null | undefined,
  onChange: (level: string) => void,
  options: { readonly devices?: boolean } = {},
): PowerLevelSelector {
  const { t } = useTranslation();
  const { options: deviceModels } = useLocalModelOptions();
  const selection = useModeSelection(stored);
  const offered = options.devices === false ? NO_DEVICE_MODELS : deviceModels;
  const modes = useMemo(() => buildPowerLevelOptions(t, offered), [t, offered]);
  const onModeChange = useCallback((next: string) => onChange(next), [onChange]);
  return { modes, mode: selection.shown, onModeChange };
}
