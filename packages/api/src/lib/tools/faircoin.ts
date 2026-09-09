import { tool } from "ai";
import { z } from "zod";

/**
 * FairCoin's price and network state, as a card the client draws.
 *
 * FairCoin does not trade on a centralised exchange, so there is no ticker to
 * read. Its explorer already solved this: the price comes from GeckoTerminal's
 * INDEXED price for the WFAIR/USDC pool on Base (WFAIR is the 1:1 wrapped
 * bridge token). The explorer deliberately does not read the pool's on-chain
 * slot0 spot, because an instantaneous tick on a low-liquidity pool can be
 * moved within a single block and is not a safe oracle. This tool consumes that
 * decision rather than re-deriving it.
 *
 * The ranges offered are the ones the explorer actually retains — 24h, 7d, 30d,
 * 1y, all — and no more. The crypto card's eight ranges would be inventing
 * history that was never sampled.
 *
 * Counterpart that draws this: `packages/app/components/cards/faircoin-card.tsx`.
 */

const EXPLORER = "https://explorer.fairco.in/api";

/** Exactly what `GET /api/price/history` accepts; the explorer retains no more. */
const PERIODS = ["24h", "7d", "30d", "1y", "all"] as const;

interface PricePayload {
  price: number | null;
  change24h: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  source: string;
  updatedAt: string;
}

interface HistoryPoint { price_usd: number; timestamp: string }

export const getFairCoinTool = tool({
  description:
    "Consultar el precio y el estado de la red de FairCoin (FAIR). Devuelve una tarjeta que la app dibuja; no repitas las series en el texto.",
  inputSchema: z.object({}),
  execute: async () => {
    const [priceRes, ...historyRes] = await Promise.all([
      fetch(`${EXPLORER}/price`),
      ...PERIODS.map((period) => fetch(`${EXPLORER}/price/history?period=${period}`)),
    ]);

    if (!priceRes.ok) return { error: "El explorador de FairCoin no responde ahora mismo." };
    const quote = (await priceRes.json()) as PricePayload;

    // Every range travels with the card, so switching one costs no request and a
    // reopened thread shows the price that was quoted rather than today's.
    const series: Record<string, [number, number][]> = {};
    for (const [i, period] of PERIODS.entries()) {
      const res = historyRes[i];
      if (!res?.ok) continue;
      const body = (await res.json()) as { history?: HistoryPoint[] };
      series[period] = (body.history ?? []).map((p) => [Date.parse(p.timestamp), p.price_usd]);
    }

    return {
      card: {
        type: "faircoin" as const,
        version: 1 as const,
        data: {
          price: quote.price,
          changePct: quote.change24h,
          volume24h: quote.volume24h,
          liquidityUsd: quote.liquidityUsd,
          marketCapUsd: quote.marketCapUsd,
          // Named so the card can say WHERE the number came from. A price with
          // no provenance is the one thing a low-liquidity pool must not ship.
          source: quote.source,
          updatedAt: quote.updatedAt,
          series,
        },
      },
      summary: quote.price === null
        ? "FairCoin: sin cotización disponible ahora mismo."
        : `FairCoin (FAIR): ${quote.price} USD.`,
    };
  },
});
