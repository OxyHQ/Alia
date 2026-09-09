import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWeatherTool } from '../weather.js';

/**
 * What the weather tool puts into a message.
 *
 * The card is stored inside `tool_invocations` and has to draw itself from that
 * alone a month later, so the assertions are about SELF-CONTAINMENT: every hour
 * the chart plots and every day the strip shows must be in the result, in a
 * fixed unit. A tool that returned only "it is 28 degrees" would satisfy a
 * screenshot and leave a reopened thread with an empty card.
 *
 * It also has to survive `wrapToolsWithTruncation`, which rewrites top-level
 * string fields named content/text/output/result. The card sits under `card`,
 * and the truncation test next to this one is what keeps that true.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const geocodeOk = () => ({
  ok: true,
  json: async () => ({ results: [{ name: 'Barcelona', admin1: 'Cataluña', country: 'España', latitude: 41.39, longitude: 2.16, timezone: 'Europe/Madrid' }] }),
});

const forecastOk = () => ({
  ok: true,
  json: async () => ({
    current: { temperature_2m: 28.4, relative_humidity_2m: 61, weather_code: 2, wind_speed_10m: 12 },
    hourly: {
      time: ['2026-09-09T00:00', '2026-09-09T01:00', '2026-09-09T02:00'],
      temperature_2m: [24, 23.5, 23],
      precipitation_probability: [10, 5, 0],
    },
    daily: {
      time: ['2026-09-09', '2026-09-10'],
      weather_code: [2, 95],
      temperature_2m_max: [29, 27],
      temperature_2m_min: [22, 21],
    },
    timezone: 'Europe/Madrid',
  }),
});

const run = (location = 'Barcelona') =>
  // The AI SDK calls `execute` with (input, options); neither is read here.
  (getWeatherTool.execute as (i: { location: string }, o: unknown) => Promise<any>)({ location }, {});

describe('getWeather', () => {
  it('carries every hour and every day the card can show', async () => {
    fetchMock.mockResolvedValueOnce(geocodeOk()).mockResolvedValueOnce(forecastOk());

    const out = await run();

    expect(out.card.type).toBe('weather');
    expect(out.card.version).toBe(1);
    expect(out.card.data.place).toBe('Barcelona, Cataluña, España');
    expect(out.card.data.hourly).toHaveLength(3);
    expect(out.card.data.hourly[0]).toEqual({ time: '2026-09-09T00:00', temperature: 24, precipitationChance: 10 });
    expect(out.card.data.daily).toHaveLength(2);
    expect(out.card.data.daily[1]).toEqual({ date: '2026-09-10', condition: 'thunderstorm', high: 27, low: 21 });
  });

  it('names the condition rather than leaving a WMO number for the client to decode', async () => {
    fetchMock.mockResolvedValueOnce(geocodeOk()).mockResolvedValueOnce(forecastOk());
    const out = await run();
    expect(out.card.data.current.condition).toBe('partly-cloudy');
  });

  it('asks for the days the strip needs, not just today', async () => {
    fetchMock.mockResolvedValueOnce(geocodeOk()).mockResolvedValueOnce(forecastOk());
    await run();
    const forecastUrl = String(fetchMock.mock.calls[1][0]);
    expect(forecastUrl).toContain('forecast_days=7');
    expect(forecastUrl).toContain('hourly=temperature_2m');
  });

  it('says which place it could not find instead of a bare failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const out = await run('Kwyjibo');
    expect(out.error).toContain('Kwyjibo');
    expect(out.card).toBeUndefined();
  });

  it('does not invent a card when the forecast service is down', async () => {
    fetchMock.mockResolvedValueOnce(geocodeOk()).mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const out = await run();
    expect(out.card).toBeUndefined();
    expect(out.error).toBeTruthy();
  });
});
