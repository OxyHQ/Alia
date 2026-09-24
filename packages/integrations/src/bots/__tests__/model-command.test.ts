import { describe, expect, it } from 'vitest';
import { parseCatalogue } from '../../shared/catalogue';
import { CATALOGUE } from '../../shared/__tests__/catalogue.fixture';
import { planModelCommand } from '../discord-bot/commands';
import { MODEL_RESET_CALLBACK, planTelegramModelCommand } from '../telegram-bot/commands';

const catalogue = parseCatalogue(CATALOGUE);

/** A catalogue far too long for one message. */
const huge = parseCatalogue({
  ...CATALOGUE,
  data: Array.from({ length: 400 }, (_, i) => ({
    ...CATALOGUE.data[0],
    id: `acme/model-with-a-rather-long-identifier-${i}`,
    name: `Model With A Rather Long Display Name Number ${i}`,
  })),
  featuredIds: [],
});

describe('Discord /model', () => {
  it('lists featured models first with the current model and a search hint', () => {
    const plan = planModelCommand(catalogue, undefined, '');
    expect(plan.kind).toBe('reply');
    expect(plan.message).toContain('**Current model:** Default (Rocket 1)');
    expect(plan.message).toContain('Featured models');
    expect(plan.message.indexOf('Sage')).toBeLessThan(plan.message.indexOf('TPS'));
    expect(plan.message).toContain('/model <text>');
  });

  it('stays within 2000 characters and counts what it left out', () => {
    const plan = planModelCommand(huge, undefined, '');
    expect(plan.message.length).toBeLessThanOrEqual(2000);
    expect(plan.message).toMatch(/…and \d+ more\./);
    const matches = planModelCommand(huge, undefined, 'model');
    expect(matches.message.length).toBeLessThanOrEqual(2000);
    expect(matches.message).toContain('400 models match');
  });

  it('selects, lists matches, resets, and stores nothing without a catalogue', () => {
    expect(planModelCommand(catalogue, undefined, 'globex/sage')).toMatchObject({ kind: 'store', model: 'globex/sage' });
    expect(planModelCommand(catalogue, undefined, 'acme').kind).toBe('reply');
    expect(planModelCommand(catalogue, 'globex/sage', 'default')).toMatchObject({ kind: 'store', model: null });
    expect(planModelCommand(null, undefined, 'globex/sage').kind).toBe('reply');
  });
});

describe('Telegram /model', () => {
  it('lists with HTML, featured buttons and a reset button when a model is chosen', () => {
    const plan = planTelegramModelCommand(catalogue, 'initech/tps', '');
    if (plan.kind !== 'reply') throw new Error('expected a listing');
    expect(plan.html).toContain('<b>Current model:</b> TPS');
    expect(plan.buttons.map((button) => button.data)).toEqual([
      'model_acme/rocket-1', 'model_globex/sage', MODEL_RESET_CALLBACK,
    ]);
  });

  it('stays within 4096 characters and keeps callback data within 64 bytes', () => {
    const plan = planTelegramModelCommand(huge, undefined, '');
    if (plan.kind !== 'reply') throw new Error('expected a listing');
    expect(plan.html.length).toBeLessThanOrEqual(4096);
    expect(plan.html).toMatch(/…and \d+ more\./);
    for (const button of plan.buttons) expect(Buffer.byteLength(button.data)).toBeLessThanOrEqual(64);
  });

  it('selects by search, resets, and escapes what the person typed', () => {
    expect(planTelegramModelCommand(catalogue, undefined, 'Sage')).toMatchObject({ kind: 'store', model: 'globex/sage' });
    expect(planTelegramModelCommand(catalogue, undefined, 'reset')).toMatchObject({ kind: 'store', model: null });
    const none = planTelegramModelCommand(catalogue, undefined, '<b>');
    expect(none.html).toContain('&lt;b&gt;');
  });
});
