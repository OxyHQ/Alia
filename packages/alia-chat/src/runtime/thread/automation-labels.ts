import type { Translate } from '../../lib/copy';
import type { AutomationTrigger } from '../types';

/**
 * A scheduled task's trigger as words.
 *
 * Drawn by the thread's scheduled-task card, and by every host that lists the person's tasks, so
 * the words live beside the type rather than in either. Pure: the translator is a parameter.
 */

function cronDayList(field: string): number[] | null {
  const days: number[] = [];
  for (const part of field.split(',')) {
    const range = part.match(/^(\d)(?:-(\d))?$/);
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from > 6 || to > 6 || to < from) return null;
    for (let day = from; day <= to; day += 1) days.push(day);
  }
  // Cron accepts 7 for Sunday in some dialects; the scheduler here writes 0.
  const unique = [...new Set(days)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : null;
}

/**
 * A cron expression as a sentence, for the shapes the app itself writes.
 *
 * `scheduleToCron` on the API produces exactly three forms from the create
 * dialog — `*\/N * * * *` for an interval, `M H * * *` for every day and
 * `M H * * 1,3,5` for chosen days — and those are what a person expects to
 * read back as "Every hour" or "Mondays at 09:00", not as five fields (#537).
 * Anything else (a hand-written structured schedule) is returned verbatim
 * rather than guessed at: a wrong sentence is worse than a cron string.
 */
export function cronLabel(cron: string, t: Translate): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (dayOfMonth !== '*' || month !== '*') return cron;

  const interval = minute.match(/^\*\/(\d+)$/);
  if (interval && hour === '*' && dayOfWeek === '*') {
    const minutes = Number(interval[1]);
    if (minutes === 60) return t('automations.cron.everyHour');
    if (minutes > 60 && minutes % 60 === 0)
      return t('automations.cron.everyHours', { count: minutes / 60 });
    return t('automations.cron.everyMinutes', { count: minutes });
  }

  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return cron;
  if (Number(minute) > 59 || Number(hour) > 23) return cron;
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  if (dayOfWeek === '*') return t('automations.cron.dailyAt', { time });
  const days = cronDayList(dayOfWeek);
  if (!days) return cron;
  if (days.length === 7) return t('automations.cron.dailyAt', { time });
  if (days.length === 5 && days.every((day, index) => day === index + 1)) {
    return t('automations.cron.weekdaysAt', { time });
  }
  if (days.length === 2 && days[0] === 0 && days[1] === 6)
    return t('automations.cron.weekendsAt', { time });
  const names = days.map((day) => t(`automations.cron.dayPlural.${day}`));
  return t('automations.cron.daysAt', { days: names.join(', '), time });
}

export function triggerLabel(trigger: AutomationTrigger, t: Translate): string {
  if (trigger.type === 'manual') return t('automations.trigger.manual');
  if (trigger.type === 'event') {
    return `${trigger.appId ?? t('automations.trigger.anyApp')} · ${trigger.eventType ?? t('automations.trigger.anyEvent')}`;
  }
  return `${trigger.cron ? cronLabel(trigger.cron, t) : t('automations.trigger.unscheduled')} · ${trigger.timezone ?? 'UTC'}`;
}
