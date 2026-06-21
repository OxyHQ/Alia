/**
 * Google Calendar integration tools — list events, create events
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { safeExecute, authedFetch } from './shared.js';

export function buildGoogleCalendarTools(userId: string): ToolSet {
  return {
    listCalendarEvents: tool({
      description: '[Google Calendar] List upcoming calendar events. Use when user asks about their schedule, meetings, or appointments.',
      inputSchema: z.object({
        timeMin: z.string().optional().describe('Start time in ISO 8601 format (defaults to now)'),
        timeMax: z.string().optional().describe('End time in ISO 8601 format (defaults to 7 days from now)'),
      }),
      execute: async ({ timeMin, timeMax }) => safeExecute('Google Calendar', async () => {
        const now = new Date();
        const min = timeMin || now.toISOString();
        const max = timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const params = new URLSearchParams({
          timeMin: min,
          timeMax: max,
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '20',
        });
        const data = await authedFetch(userId, 'google-calendar', `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
        return (data.items || []).map((e: any) => ({
          id: e.id,
          summary: e.summary,
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
          location: e.location,
          description: e.description?.slice(0, 200),
          attendees: e.attendees?.map((a: any) => a.email),
          htmlLink: e.htmlLink,
        }));
      }),
    }),

    createCalendarEvent: tool({
      description: '[Google Calendar] Create a new calendar event. Use when user wants to schedule something.',
      inputSchema: z.object({
        summary: z.string().describe('Event title'),
        start: z.string().describe('Start time in ISO 8601 format'),
        end: z.string().describe('End time in ISO 8601 format'),
        description: z.string().optional().describe('Event description'),
        location: z.string().optional().describe('Event location'),
      }),
      execute: async ({ summary, start, end, description, location }) => safeExecute('Google Calendar', async () => {
        const event: any = {
          summary,
          start: { dateTime: start },
          end: { dateTime: end },
        };
        if (description) event.description = description;
        if (location) event.location = location;

        const data = await authedFetch(userId, 'google-calendar', 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
        return {
          id: data.id,
          summary: data.summary,
          start: data.start?.dateTime || data.start?.date,
          end: data.end?.dateTime || data.end?.date,
          htmlLink: data.htmlLink,
        };
      }),
    }),
  };
}
