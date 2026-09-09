import { tool } from "ai";
import { z } from "zod";

/**
 * A crypto quote, as a card the client draws.
 *
 * Two requests, not eight. The card offers 1D…MAX, and asking CoinGecko once
 * per range would spend eight calls of a free-tier minute on one question — so
 * it fetches the intraday series and the full daily history, and every other
 * range is a slice of the daily one. That also happens to be the property the
 * card needs: everything it can show is in the result, so changing range costs
 * nothing and a thread reopened next month shows the price that was quoted
 * rather than today's.
 *
 * CoinGecko's public API needs no key, so nothing here belongs in
 * `~/.config/oxy/tokens/`. Stocks are a different provider and are deliberately
 * not here; this tool says so rather than guessing a ticker.
 *
 * The counterpart that draws this is
 * `packages/app/components/cards/market-card.tsx`.
 */

const BASE = "https://api.coingecko.com/api/v3";

/** Daily points to keep per range. `max` keeps everything the coin has. */
const RANGE_DAYS: Record<string, number | "max"> = {
  "5D": 5,
  "1M": 30,
  "6M": 180,
  "1Y": 365,
  "5Y": 1825,
  MAX: "max",
};

interface SearchHit { id: string; name: string; symbol: string; thumb?: string }

async function resolveCoin(query: string): Promise<SearchHit | null> {
  const res = await fetch(`${BASE}/search?query=${encodeURIComponent(query)}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { coins?: SearchHit[] };
  return body.coins?.[0] ?? null;
}

/** CoinGecko returns `[[msSinceEpoch, price], …]`. */
type ChartPoint = [number, number];

export const getMarketQuoteTool = tool({
  description:
    "Consultar el precio de una criptomoneda y su histórico. Devuelve una tarjeta que la app dibuja; no repitas la serie en el texto. No sirve para acciones ni índices bursátiles.",
  inputSchema: z.object({
    coin: z.string().describe("Nombre o símbolo, por ejemplo 'bitcoin', 'BTC' o 'ethereum'."),
    currency: z.string().default("usd").describe("Moneda de cotización en ISO, por ejemplo 'usd' o 'eur'."),
  }),
  execute: async ({ coin, currency }) => {
    const hit = await resolveCoin(coin);
    if (!hit) return { error: `No encuentro la criptomoneda "${coin}".` };

    const vs = currency.toLowerCase();
    const [intradayRes, dailyRes, quoteRes] = await Promise.all([
      fetch(`${BASE}/coins/${hit.id}/market_chart?vs_currency=${vs}&days=1`),
      fetch(`${BASE}/coins/${hit.id}/market_chart?vs_currency=${vs}&days=max&interval=daily`),
      fetch(`${BASE}/simple/price?ids=${hit.id}&vs_currencies=${vs}&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`),
    ]);
    if (!intradayRes.ok || !dailyRes.ok || !quoteRes.ok) {
      return { error: "El servicio de cotizaciones no responde ahora mismo." };
    }

    const intraday = ((await intradayRes.json()) as { prices: ChartPoint[] }).prices;
    const daily = ((await dailyRes.json()) as { prices: ChartPoint[] }).prices;
    const quote = ((await quoteRes.json()) as Record<string, Record<string, number>>)[hit.id] ?? {};

    const series: Record<string, ChartPoint[]> = { "1D": intraday };
    for (const [label, days] of Object.entries(RANGE_DAYS)) {
      series[label] = days === "max" ? daily : daily.slice(-days);
    }
    // Year to date is a date, not a count of days, so it is cut rather than sliced.
    const startOfYear = Date.UTC(new Date().getUTCFullYear(), 0, 1);
    series.YTD = daily.filter(([at]) => at >= startOfYear);

    const price = quote[vs];
    const changePct = quote[`${vs}_24h_change`];

    return {
      card: {
        type: "market" as const,
        version: 1 as const,
        data: {
          id: hit.id,
          name: hit.name,
          symbol: hit.symbol.toUpperCase(),
          currency: vs,
          price,
          changePct,
          // Absolute change is derivable, but every client would derive it the
          // same way and one of them would round it differently.
          changeAbs: price !== undefined && changePct !== undefined
            ? price - price / (1 + changePct / 100)
            : undefined,
          marketCap: quote[`${vs}_market_cap`],
          volume24h: quote[`${vs}_24h_vol`],
          series,
        },
      },
      summary: price === undefined
        ? `${hit.name}: sin cotización disponible.`
        : `${hit.name} (${hit.symbol.toUpperCase()}): ${price} ${vs.toUpperCase()}.`,
    };
  },
});
