/**
 * The suggestion cards on the Automations page and the dialog state each one
 * opens with.
 *
 * ## Why a suggestion carries its schedule
 *
 * A card that says "every hour" and opens a dialog set to daily at 06:00 PM is
 * a card whose promise the form does not keep (#533). Worse, the dialog's
 * fields used to be reset piecemeal — name and prompt on every open, schedule
 * never — so a suggestion inherited whatever the previous dialog was left
 * with. The schedule is therefore DATA on the suggestion, checked in beside
 * the wording it has to match, and `suggestionFormState` is the one place a
 * suggestion becomes dialog state, so every field is reset together.
 *
 * The wording is the contract: a schedule that disagrees with its description
 * is exactly the bug this file exists to prevent, so change both or neither.
 */

export type Weekday =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

export const ALL_DAYS: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export const WEEKDAYS: readonly Weekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

/** Times as the dialog's time field shows them — the 12-hour form `to24Hour` accepts. */
export const MORNING_TIME = '09:00 AM';
export const AFTERNOON_TIME = '03:00 PM';
export const EVENING_TIME = '06:00 PM';

/** What the dialog starts from when no suggestion is involved. */
export const DEFAULT_TIME = EVENING_TIME;
export const DEFAULT_INTERVAL_MINUTES = 60;

export type SuggestionSchedule =
  | { type: 'daily'; time: string; days: readonly Weekday[] }
  | { type: 'interval'; intervalMinutes: number };

export interface AutomationSuggestion {
  emoji: string;
  description: string;
  schedule: SuggestionSchedule;
}

/**
 * Everything the create dialog edits, as ONE value.
 *
 * One object rather than six `useState`s so that opening a suggestion, or the
 * plain "+", replaces the whole thing in a single assignment — there is no
 * field left to forget. `intervalMinutes` is kept as the typed string so the
 * field can be cleared while editing; `intervalMinutesValue` is the parse.
 */
export interface AutomationFormState {
  name: string;
  prompt: string;
  scheduleType: 'daily' | 'interval';
  time: string;
  selectedDays: Weekday[];
  intervalMinutes: string;
}

export function defaultAutomationFormState(): AutomationFormState {
  return {
    name: '',
    prompt: '',
    scheduleType: 'daily',
    time: DEFAULT_TIME,
    selectedDays: [...ALL_DAYS],
    intervalMinutes: String(DEFAULT_INTERVAL_MINUTES),
  };
}

/**
 * The dialog state a suggestion opens with: its description as the prompt,
 * its schedule in the schedule fields, and the base defaults for whatever the
 * schedule does not say — an interval suggestion still gets a sane daily time
 * in case the person switches the toggle.
 */
export function suggestionFormState(suggestion: AutomationSuggestion): AutomationFormState {
  const base = defaultAutomationFormState();
  const { schedule } = suggestion;
  if (schedule.type === 'interval') {
    return {
      ...base,
      prompt: suggestion.description,
      scheduleType: 'interval',
      intervalMinutes: String(schedule.intervalMinutes),
    };
  }
  return {
    ...base,
    prompt: suggestion.description,
    scheduleType: 'daily',
    time: schedule.time,
    selectedDays: [...schedule.days],
  };
}

/** The interval as a positive whole number of minutes, or null when the field is not one. */
export function intervalMinutesValue(form: Pick<AutomationFormState, 'intervalMinutes'>): number | null {
  if (!/^\d+$/.test(form.intervalMinutes.trim())) return null;
  const minutes = Number.parseInt(form.intervalMinutes, 10);
  return minutes >= 1 ? minutes : null;
}

const daily = (time: string, days: readonly Weekday[] = ALL_DAYS): SuggestionSchedule => (
  { type: 'daily', time, days }
);
const everyMinutes = (intervalMinutes: number): SuggestionSchedule => (
  { type: 'interval', intervalMinutes }
);

export const INITIAL_SUGGESTIONS: readonly AutomationSuggestion[] = [
  {
    emoji: '🔍',
    description: 'Find and fix a bug every morning with a short summary',
    schedule: daily(MORNING_TIME),
  },
  {
    emoji: '🌈',
    description: 'Every evening, look through my recent threads and create new skills',
    schedule: daily(EVENING_TIME),
  },
  {
    emoji: '🧪',
    description: "Add tests every evening for today's code changes",
    schedule: daily(EVENING_TIME),
  },
  {
    emoji: '💬',
    description: 'Review PR comments every hour and share next steps',
    schedule: everyMinutes(60),
  },
  {
    emoji: '✏️',
    description: 'Draft release notes every week from recent changes in this repo',
    schedule: daily(MORNING_TIME, ['friday']),
  },
  {
    emoji: '📋',
    description: "Summarize my team's PRs from last week every Monday morning",
    schedule: daily(MORNING_TIME, ['monday']),
  },
  {
    emoji: '📱',
    description: 'Update AGENTS.md every week with new project details',
    schedule: daily(MORNING_TIME, ['monday']),
  },
  {
    emoji: '🚀',
    description: 'Look through recent Linear tickets and start a few PRs for simple tasks',
    schedule: daily(MORNING_TIME, WEEKDAYS),
  },
  {
    emoji: '📊',
    description: 'Write release notes every week for the latest build',
    schedule: daily(AFTERNOON_TIME, ['friday']),
  },
];

export const MORE_SUGGESTIONS: readonly AutomationSuggestion[] = [
  {
    emoji: '🛡️',
    description: 'Run a security audit every week and summarize findings',
    schedule: daily(MORNING_TIME, ['monday']),
  },
  {
    emoji: '📈',
    description: 'Generate a weekly performance report from monitoring data',
    schedule: daily(MORNING_TIME, ['monday']),
  },
  {
    emoji: '🧹',
    description: 'Clean up stale branches every Friday afternoon',
    schedule: daily(AFTERNOON_TIME, ['friday']),
  },
  {
    emoji: '📝',
    description: 'Summarize daily standups and post to the team channel every morning',
    schedule: daily(MORNING_TIME, WEEKDAYS),
  },
  {
    emoji: '🔔',
    description: 'Check for dependency updates every Monday and open upgrade PRs',
    schedule: daily(MORNING_TIME, ['monday']),
  },
  {
    emoji: '💡',
    description: 'Review new issues every morning and suggest labels and priorities',
    schedule: daily(MORNING_TIME, WEEKDAYS),
  },
];
