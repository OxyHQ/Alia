/**
 * Daily Briefing System
 *
 * Creates and manages personalized daily briefing triggers for users.
 * The briefing pulls from the user's connected integrations, interests,
 * and preferred topics to deliver a morning summary.
 */

import mongoose from 'mongoose';
import { Trigger } from '../models/trigger.js';
import { UserMemory } from '../models/user-memory.js';
import { reloadTrigger } from './trigger-engine.js';
import { log } from './logger.js';

const DEFAULT_BRIEFING_TIME = '08:00';
const DEFAULT_TIMEZONE = 'America/New_York';

/**
 * Build the AI prompt for a daily briefing based on user context.
 */
function buildBriefingPrompt(memory: any): string {
  const sections: string[] = [];

  sections.push('Generate a personalized morning briefing for the user. Keep it concise and actionable.');

  // Personalize based on user interests
  if (memory?.preferences?.interests?.length) {
    sections.push(`\nUser interests: ${memory.preferences.interests.join(', ')}`);
  }

  // Occupation-specific content
  if (memory?.context?.occupation) {
    sections.push(`User occupation: ${memory.context.occupation}. Include relevant industry news.`);
  }

  // Location-specific content
  if (memory?.context?.location) {
    sections.push(`User location: ${memory.context.location}. Include local weather if relevant.`);
  }

  sections.push(`
## Briefing Structure
1. **Top News** — 2-3 trending stories relevant to the user's interests
2. **Today's Focus** — Key tasks or events to be aware of
3. **Quick Insight** — One interesting fact, tip, or inspiration

Use web search to get current information. Be concise — this should be readable in under 1 minute.`);

  return sections.join('\n');
}

/**
 * Create a daily briefing trigger for a user.
 * Returns the trigger if created, or null if one already exists.
 */
export async function createDailyBriefing(
  userId: string,
  options?: {
    time?: string;
    timezone?: string;
    channelId?: string;
  },
): Promise<typeof Trigger.prototype | null> {
  // Check if user already has a daily briefing
  const existing = await Trigger.findOne({
    oxyUserId: new mongoose.Types.ObjectId(userId),
    name: { $regex: /daily briefing|morning briefing/i },
    type: 'schedule',
  });

  if (existing) {
    log.general.info({ userId }, 'User already has a daily briefing trigger');
    return null;
  }

  // Load user context for personalized prompt
  const memory = await UserMemory.findOne({ oxyUserId: userId }).lean();
  const prompt = buildBriefingPrompt(memory);

  const trigger = await Trigger.create({
    oxyUserId: new mongoose.Types.ObjectId(userId),
    name: 'Morning Briefing',
    description: 'Personalized daily briefing with news, tasks, and insights',
    type: 'schedule',
    enabled: true,
    action: {
      prompt,
      useTools: true,
      notify: true,
      channelId: options?.channelId,
    },
    schedule: {
      type: 'daily',
      time: options?.time || DEFAULT_BRIEFING_TIME,
      days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      timezone: options?.timezone || DEFAULT_TIMEZONE,
    },
  });

  await reloadTrigger(trigger._id.toString());

  log.general.info(
    { userId, triggerId: trigger._id.toString(), time: trigger.schedule?.time },
    'Created daily briefing trigger',
  );

  return trigger;
}

/**
 * Update an existing daily briefing's prompt based on current user context.
 * Called periodically to keep the briefing personalized as the user's
 * memories and preferences evolve.
 */
export async function refreshBriefingPrompt(userId: string): Promise<boolean> {
  const trigger = await Trigger.findOne({
    oxyUserId: new mongoose.Types.ObjectId(userId),
    name: { $regex: /daily briefing|morning briefing/i },
    type: 'schedule',
  });

  if (!trigger) return false;

  const memory = await UserMemory.findOne({ oxyUserId: userId }).lean();
  trigger.action.prompt = buildBriefingPrompt(memory);
  await trigger.save();

  return true;
}
