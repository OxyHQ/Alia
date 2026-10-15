import type { ComposerPanelPermissionOption } from '@oxy.so/bloom/composer-panel';
import { RiComputerLine } from '@oxy.so/bloom/icons/RiComputerLine';
import { RiFireLine } from '@oxy.so/bloom/icons/RiFireLine';
import { RiFlashlightLine } from '@oxy.so/bloom/icons/RiFlashlightLine';
import { RiLightbulbLine } from '@oxy.so/bloom/icons/RiLightbulbLine';
import { RiRocket2Line } from '@oxy.so/bloom/icons/RiRocket2Line';
import { RiSparkling2Line } from '@oxy.so/bloom/icons/RiSparkling2Line';
import { RiSpeedUpLine } from '@oxy.so/bloom/icons/RiSpeedUpLine';
import { RiVipCrownLine } from '@oxy.so/bloom/icons/RiVipCrownLine';
import { POWER_LEVELS, type PowerLevel } from '../runtime/power-levels';
import type { Translate } from './copy';

/**
 * The power-level selector, in the shape Bloom's composer mode selector takes.
 *
 * Alia's users choose how much power a turn gets, never which hosted model answers it: Oxy picks
 * the model of the chosen level for every request. The selector is `ComposerPill`'s mode picker —
 * Bloom's own radio menu of a label, a short description and an icon per mode — so the seven
 * levels read the same way every Bloom mode selector does. Models running on the person's OWN
 * devices follow the levels: that is their machine, not a model Alia offers, and which devices
 * are connected is the host's to say.
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

/** A model running on one of the person's own devices, offered after the levels. */
export interface DeviceModel {
  /** What a request carries as `model` (`local/<runtime>/<model>`). */
  id: string;
  /** The tag the person knows it by, e.g. `llama3.1:8b`. */
  name: string;
  /** Which of their devices is running it. */
  deviceLabel: string;
}

/** The selector's options: the seven levels, then the person's device models. */
export function buildPowerLevelOptions(
  t: Translate,
  deviceModels: readonly DeviceModel[],
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
