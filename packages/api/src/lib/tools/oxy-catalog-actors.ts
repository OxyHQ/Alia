/**
 * Which actors may execute a catalogue tool (Oxy ADR 0018, addendum
 * 2026-10-11), read the same way whichever `@oxy.so/contracts` is installed.
 *
 * `@oxy.so/contracts` 4.11.0-oxy-one.1 adds an optional `actors` to each tool.
 * Its catalogue schema is strict, so an older installed contracts REFUSES a
 * registry catalogue that carries the field — and Oxy may register one before
 * Alia moves to the new contracts. `parseRegistryCatalog` therefore reads
 * `actors` itself, hands the strict schema only what it knows, and puts the
 * field back so the catalogue stays byte-for-byte the registered one (its
 * digest is checked for the internal MCP pilot).
 */

import {
  type AppCapabilityCatalog,
  appCapabilityCatalogSchema,
  type CatalogTool,
  catalogToolSchema,
} from '@oxy.so/contracts';
import { z } from 'zod';

export type CatalogActorType = 'alia' | 'agent' | 'requester';

/** What an absent `actors` means: the standing actors. A requester is opt-in. */
const DEFAULT_ACTORS: readonly CatalogActorType[] = ['alia', 'agent'];

const toolActorsSchema = z
  .array(z.enum(['alia', 'agent', 'requester']))
  .min(1)
  .refine((actors) => new Set(actors).size === actors.length, 'actors must not repeat');

/** True once the installed contracts validate `actors` themselves. */
const CONTRACTS_KNOW_TOOL_ACTORS = 'actors' in catalogToolSchema.shape;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse one registry catalogue; throws when it is not a valid catalogue. */
export function parseRegistryCatalog(raw: unknown): AppCapabilityCatalog {
  if (CONTRACTS_KNOW_TOOL_ACTORS || !isRecord(raw) || !Array.isArray(raw.tools)) {
    return appCapabilityCatalogSchema.parse(raw);
  }
  const actorsByIndex = new Map<number, CatalogActorType[]>();
  const tools = raw.tools.map((tool: unknown, index) => {
    if (!isRecord(tool) || !Object.hasOwn(tool, 'actors')) return tool;
    const { actors, ...known } = tool;
    actorsByIndex.set(index, toolActorsSchema.parse(actors));
    return known;
  });
  const catalog = appCapabilityCatalogSchema.parse({ ...raw, tools });
  if (actorsByIndex.size === 0) return catalog;
  return {
    ...catalog,
    tools: catalog.tools.map((tool, index) => {
      const actors = actorsByIndex.get(index);
      return actors ? ({ ...tool, actors } as CatalogTool) : tool;
    }),
  };
}

/** The actor types Oxy authorizes for `tool`. */
export function catalogToolActorsOf(tool: CatalogTool): readonly CatalogActorType[] {
  const declared = (tool as CatalogTool & { actors?: readonly CatalogActorType[] }).actors;
  return declared ?? DEFAULT_ACTORS;
}

/** Whether Oxy will authorize `actorType` to execute `tool`. */
export function catalogToolAllowsActor(tool: CatalogTool, actorType: CatalogActorType): boolean {
  return catalogToolActorsOf(tool).includes(actorType);
}
