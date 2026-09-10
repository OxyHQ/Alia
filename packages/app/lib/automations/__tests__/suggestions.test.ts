import { describe, expect, it } from 'vitest';
import {
  ALL_DAYS,
  DEFAULT_INTERVAL_MINUTES,
  EVENING_TIME,
  INITIAL_SUGGESTIONS,
  MORE_SUGGESTIONS,
  MORNING_TIME,
  defaultAutomationFormState,
  intervalMinutesValue,
  suggestionFormState,
} from '../suggestions';

/**
 * A suggestion opens the dialog with the schedule its wording advertises
 * (#533). Before, every card opened daily at 06:00 PM on all seven days —
 * or whatever the previous dialog had been left with.
 */

const ALL = [...INITIAL_SUGGESTIONS, ...MORE_SUGGESTIONS];
const byWording = (fragment: string) => {
  const found = ALL.find((suggestion) => suggestion.description.includes(fragment));
  if (!found) throw new Error(`no suggestion mentions "${fragment}"`);
  return found;
};

describe('suggestion schedules', () => {
  it('opens an "every hour" suggestion as a 60 minute interval', () => {
    const form = suggestionFormState(byWording('every hour'));
    expect(form.scheduleType).toBe('interval');
    expect(intervalMinutesValue(form)).toBe(60);
    expect(form.prompt).toBe('Review PR comments every hour and share next steps');
    expect(form.name).toBe('');
  });

  it('opens a "Monday morning" suggestion on Monday only, in the morning', () => {
    const form = suggestionFormState(byWording('every Monday morning'));
    expect(form.scheduleType).toBe('daily');
    expect(form.selectedDays).toEqual(['monday']);
    expect(form.time).toBe(MORNING_TIME);
  });

  it('keeps every card honest about its own wording', () => {
    for (const suggestion of ALL) {
      const text = suggestion.description.toLowerCase();
      const form = suggestionFormState(suggestion);
      if (text.includes('every hour')) {
        expect(form.scheduleType, text).toBe('interval');
        continue;
      }
      expect(form.scheduleType, text).toBe('daily');
      if (text.includes('monday')) expect(form.selectedDays, text).toEqual(['monday']);
      if (text.includes('friday')) expect(form.selectedDays, text).toEqual(['friday']);
      if (text.includes('morning')) expect(form.time, text).toBe(MORNING_TIME);
      if (text.includes('evening')) expect(form.time, text).toBe(EVENING_TIME);
      if (text.includes('every week') || text.includes('weekly')) {
        expect(form.selectedDays, text).toHaveLength(1);
      }
      expect(form.selectedDays.length, text).toBeGreaterThan(0);
    }
  });

  it('returns a fresh copy each time, so editing one dialog cannot leak into the next', () => {
    const suggestion = byWording('every Monday morning');
    const first = suggestionFormState(suggestion);
    first.selectedDays.push('friday');
    first.time = '11:00 AM';
    const second = suggestionFormState(suggestion);
    expect(second.selectedDays).toEqual(['monday']);
    expect(second.time).toBe(MORNING_TIME);
    expect(suggestion.schedule).toEqual({ type: 'daily', time: MORNING_TIME, days: ['monday'] });
  });

  it('starts the plain create flow from the base defaults', () => {
    const form = defaultAutomationFormState();
    expect(form).toEqual({
      name: '',
      prompt: '',
      scheduleType: 'daily',
      time: EVENING_TIME,
      selectedDays: [...ALL_DAYS],
      intervalMinutes: String(DEFAULT_INTERVAL_MINUTES),
    });
    expect(defaultAutomationFormState().selectedDays).not.toBe(form.selectedDays);
  });

  it('accepts only a positive whole number of interval minutes', () => {
    expect(intervalMinutesValue({ intervalMinutes: '15' })).toBe(15);
    expect(intervalMinutesValue({ intervalMinutes: ' 90 ' })).toBe(90);
    expect(intervalMinutesValue({ intervalMinutes: '0' })).toBeNull();
    expect(intervalMinutesValue({ intervalMinutes: '' })).toBeNull();
    expect(intervalMinutesValue({ intervalMinutes: '1.5' })).toBeNull();
    expect(intervalMinutesValue({ intervalMinutes: 'hour' })).toBeNull();
  });
});
