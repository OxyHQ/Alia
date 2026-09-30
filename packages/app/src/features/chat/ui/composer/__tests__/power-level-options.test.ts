import { describe, expect, it, vi } from 'vitest';

/**
 * Bloom's icons resolve to raw `.tsx` under the `react-native` condition and
 * die at import in this runner (see `add-menu.test.tsx`); the artwork is
 * Bloom's business, the list is this file's.
 */
const icon = vi.hoisted(() => (name: string) => async () => ({ [name]: () => name }));
vi.mock('@oxy.so/bloom/icons/RiComputerLine', icon('RiComputerLine'));
vi.mock('@oxy.so/bloom/icons/RiFireLine', icon('RiFireLine'));
vi.mock('@oxy.so/bloom/icons/RiFlashlightLine', icon('RiFlashlightLine'));
vi.mock('@oxy.so/bloom/icons/RiLightbulbLine', icon('RiLightbulbLine'));
vi.mock('@oxy.so/bloom/icons/RiRocket2Line', icon('RiRocket2Line'));
vi.mock('@oxy.so/bloom/icons/RiSparkling2Line', icon('RiSparkling2Line'));
vi.mock('@oxy.so/bloom/icons/RiSpeedUpLine', icon('RiSpeedUpLine'));
vi.mock('@oxy.so/bloom/icons/RiVipCrownLine', icon('RiVipCrownLine'));

vi.mock('@/shared/i18n/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/local-models/runtime/use-local-runtimes', () => ({
  useLocalModelOptions: () => ({ options: [], ids: [], loading: false }),
}));

import { buildPowerLevelOptions, POWER_LEVEL_ICONS } from '../power-level-options';

const t = (key: string, options?: Record<string, unknown>) =>
  options === undefined ? key : `${key}(${JSON.stringify(options)})`;

describe('the power-level selector', () => {
  it('offers the seven levels, Auto first, each with a label, a short description and an icon', () => {
    const options = buildPowerLevelOptions(t, []);
    expect(options.map((option) => option.id)).toEqual(['auto', 'instant', 'medium', 'high', 'xhigh', 'pro', 'ultra']);
    for (const option of options) {
      expect(option.label).toBe(`powerLevels.${option.id}.label`);
      expect(option.description).toBe(`powerLevels.${option.id}.description`);
      expect(option.icon).toBe(POWER_LEVEL_ICONS[option.id as keyof typeof POWER_LEVEL_ICONS]);
    }
  });

  it('names no hosted model; a model on the person\'s own device follows the levels', () => {
    const options = buildPowerLevelOptions(t, [{ id: 'local/ollama/llama3.1:8b', name: 'llama3.1:8b', deviceLabel: 'Laptop' }]);
    expect(options).toHaveLength(8);
    expect(options[7]).toMatchObject({
      id: 'local/ollama/llama3.1:8b',
      label: 'llama3.1:8b',
      description: 'powerLevels.onDevice({"device":"Laptop"})',
    });
  });
});
