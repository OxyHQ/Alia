import { describe, expect, it } from 'vitest';
import { isPowerLevel, POWER_LEVELS, resolveModeSelection } from '../power-levels';

describe('power levels in the app', () => {
  it("are Oxy's seven slugs, Auto first, none a model id", () => {
    expect(POWER_LEVELS).toEqual(['auto', 'instant', 'medium', 'high', 'xhigh', 'pro', 'ultra']);
    for (const level of POWER_LEVELS) expect(level).not.toContain('/');
    expect(isPowerLevel('openai/gpt-5.5')).toBe(false);
  });

  it('sends a stored level as itself', () => {
    expect(resolveModeSelection('pro', [])).toEqual({
      shown: 'pro',
      send: 'pro',
      source: 'requested',
    });
  });

  it('starts everyone on auto', () => {
    expect(resolveModeSelection(null, [])).toEqual({
      shown: 'auto',
      send: 'auto',
      source: 'requested',
    });
  });

  it('never sends a hosted model name: anything else is answered by auto', () => {
    expect(resolveModeSelection('acme/model', [])).toEqual({
      shown: 'auto',
      send: 'auto',
      source: 'replaced',
    });
  });

  it('sends a device model while its device is connected, and auto once it is gone', () => {
    const device = 'local/ollama/llama3.1:8b';
    expect(resolveModeSelection(device, [device]).send).toBe(device);
    expect(resolveModeSelection(device, [])).toEqual({
      shown: 'auto',
      send: 'auto',
      source: 'replaced',
    });
  });

  it('keeps a device model while the devices are still being listed', () => {
    const device = 'local/ollama/llama3.1:8b';
    expect(resolveModeSelection(device, undefined).send).toBe(device);
  });
});
