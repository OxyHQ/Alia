import { tool } from "ai";
import { z } from "zod";

/**
 * Weather, as a card the client draws rather than a paragraph the model writes.
 *
 * The whole forecast travels in the result — every hour it charts and every day
 * its strip shows — because the card is stored inside the message's
 * `tool_invocations` and must still draw itself a month later. Selecting a day
 * or switching the unit is a decision the card makes locally; nothing it can be
 * asked to show costs a second request, and reopening an old thread shows the
 * weather that was answered, not today's.
 *
 * Open-Meteo needs no key and answers geocoding, hourly and daily in two calls,
 * so nothing here belongs in `~/.config/oxy/tokens/`.
 *
 * The card shape has a counterpart the client draws with — `WeatherCard` in
 * `packages/app/components/cards/weather-card.tsx`. The wire is the contract,
 * as it already is for `ToolInvocation`.
 */

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

/** Days of forecast the strip shows. Open-Meteo serves up to 16. */
const FORECAST_DAYS = 7;

/**
 * WMO weather codes, collapsed to the conditions a card can draw an icon for.
 * Open-Meteo reports the raw code; every consumer would otherwise re-derive
 * this table, and they would disagree.
 */
function conditionFromCode(code: number): string {
  if (code === 0) return "clear";
  if (code <= 2) return "partly-cloudy";
  if (code === 3) return "cloudy";
  if (code <= 48) return "fog";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "showers";
  if (code <= 86) return "snow-showers";
  return "thunderstorm";
}

interface GeocodeHit {
  name: string;
  admin1?: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
}

async function geocode(place: string): Promise<GeocodeHit | null> {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(place)}&count=1&language=es&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = (await res.json()) as { results?: GeocodeHit[] };
  return body.results?.[0] ?? null;
}

export const getWeatherTool = tool({
  description:
    "Consultar el tiempo actual y la previsión de una ubicación. Devuelve una tarjeta que la app dibuja; no repitas todos los datos en el texto.",
  inputSchema: z.object({
    location: z
      .string()
      .describe("Ciudad o lugar, por ejemplo 'Barcelona' o 'Ciudad de México'."),
  }),
  execute: async ({ location }) => {
    const place = await geocode(location);
    if (!place) return { error: `No encuentro la ubicación "${location}".` };

    const params = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current: "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
      hourly: "temperature_2m,precipitation_probability",
      daily: "weather_code,temperature_2m_max,temperature_2m_min",
      timezone: place.timezone ?? "auto",
      forecast_days: String(FORECAST_DAYS),
    });
    const res = await fetch(`${FORECAST_URL}?${params}`);
    if (!res.ok) return { error: "El servicio de meteorología no responde ahora mismo." };

    const data = (await res.json()) as {
      current: { temperature_2m: number; relative_humidity_2m: number; weather_code: number; wind_speed_10m: number };
      hourly: { time: string[]; temperature_2m: number[]; precipitation_probability: number[] };
      daily: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[] };
      timezone: string;
    };

    const label = [place.name, place.admin1, place.country].filter(Boolean).join(", ");

    return {
      card: {
        type: "weather" as const,
        version: 1 as const,
        data: {
          place: label,
          timezone: data.timezone,
          // Celsius on the wire; the card converts, so the stored answer does
          // not depend on what the reader preferred the day it was asked.
          current: {
            temperature: data.current.temperature_2m,
            humidity: data.current.relative_humidity_2m,
            windSpeed: data.current.wind_speed_10m,
            condition: conditionFromCode(data.current.weather_code),
          },
          hourly: data.hourly.time.map((time, i) => ({
            time,
            temperature: data.hourly.temperature_2m[i],
            precipitationChance: data.hourly.precipitation_probability[i],
          })),
          daily: data.daily.time.map((date, i) => ({
            date,
            condition: conditionFromCode(data.daily.weather_code[i]),
            high: data.daily.temperature_2m_max[i],
            low: data.daily.temperature_2m_min[i],
          })),
        },
      },
      // A short line for the model to read; the numbers live in the card.
      summary: `${label}: ${Math.round(data.current.temperature_2m)}°C, ${conditionFromCode(data.current.weather_code)}.`,
    };
  },
});
