import { useCallback, useMemo } from 'react';
import type { ComposerPanelPermissionOption } from '@oxy.so/bloom/composer-panel';
import { RiComputerLine } from '@oxy.so/bloom/icons/RiComputerLine';
import { RiFireLine } from '@oxy.so/bloom/icons/RiFireLine';
import { RiFlashlightLine } from '@oxy.so/bloom/icons/RiFlashlightLine';
import { RiLightbulbLine } from '@oxy.so/bloom/icons/RiLightbulbLine';
import { RiRocket2Line } from '@oxy.so/bloom/icons/RiRocket2Line';
import { RiSparkling2Line } from '@oxy.so/bloom/icons/RiSparkling2Line';
import { RiSpeedUpLine } from '@oxy.so/bloom/icons/RiSpeedUpLine';
import { RiVipCrownLine } from '@oxy.so/bloom/icons/RiVipCrownLine';
import { useTranslation } from '@/shared/i18n/use-translation';
import {
  POWER_LEVELS,
  resolveModeSelection,
  type ModeSelection,
  type PowerLevel,
} from '@/features/chat/model/power-levels';
import {
  useLocalModelOptions,
  type LocalModelOption,
} from '@/features/local-models/runtime/use-local-runtimes';

/**
 * The power-level selector, in the shape Bloom's composer mode selector takes.
 *
 * Alia's users choose how much power a turn gets, never which hosted model
 * answers it: Oxy picks the model of the chosen level for every request. The
 * selector is `ComposerPanel`'s mode pill — Bloom's own radio menu of a label,
 * a short description and an icon per mode — so the seven levels read the same
 * way every Bloom mode selector does. Models running on the person's OWN
 * devices follow the levels: that is their machine, not a model Alia offers.
 */

type IconComponent = ComposerPanelPermissionOption['icon'];

/** One glyph per level, rising with the power it stands for. */
export const POWER_LEVEL_ICONS: Record<PowerLevel, IconComponent> = {
  auto: RiSparkling2Line,
  instant: RiFlashlightLine,
  medium: RiSpeedUpLine,
  high: RiLightbulbLine,
  xhigh: RiFireLine,
  pro: RiRocket2Line,
  ultra: RiVipCrownLine,
};

/** The pure list, testable without rendering. */
export function buildPowerLevelOptions(
  t: (key: string, options?: Record<string, unknown>) => string,
  deviceModels: readonly LocalModelOption[],
): ComposerPanelPermissionOption[] {
  return [
    ...POWER_LEVELS.map((level) => ({
      id: level,
      label: t(`powerLevels.${level}.label`),
      description: t(`powerLevels.${level}.description`),
      icon: POWER_LEVEL_ICONS[level],
    })),
    ...deviceModels.map((model) => ({
      id: model.id,
      label: model.name,
      description: t('powerLevels.onDevice', { device: model.deviceLabel }),
      icon: RiComputerLine,
    })),
  ];
}

/**
 * The stored choice resolved against the person's connected devices — the one
 * answer the selector draws and the request sends, so the two cannot disagree.
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
const NO_DEVICE_MODELS: readonly LocalModelOption[] = [];

/**
 * @param options.devices - Offer the person's own device models after the
 *   levels. Off where the choice is stored for something that runs in Alia's
 *   datacentre rather than on this person's machine (a new agent).
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
