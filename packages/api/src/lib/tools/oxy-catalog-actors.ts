/** Actor declarations are validated by the shared Oxy catalogue contract. */
import {
  type AppCapabilityCatalog,
  appCapabilityCatalogSchema,
  type CatalogTool,
} from '@oxy.so/contracts';

export type CatalogActorType = NonNullable<CatalogTool['actors']>[number];

/** What an absent `actors` means: the standing actors. A requester is opt-in. */
const DEFAULT_ACTORS: readonly CatalogActorType[] = ['alia', 'agent'];

/** Parse the exact registered catalogue, including its actor declarations. */
export function parseRegistryCatalog(raw: unknown): AppCapabilityCatalog {
  return appCapabilityCatalogSchema.parse(raw);
}

/** The actor types Oxy authorizes for `tool`. */
export function catalogToolActorsOf(tool: CatalogTool): readonly CatalogActorType[] {
  const declared = tool.actors;
  return declared ?? DEFAULT_ACTORS;
}

/** Whether Oxy will authorize `actorType` to execute `tool`. */
export function catalogToolAllowsActor(tool: CatalogTool, actorType: CatalogActorType): boolean {
  return catalogToolActorsOf(tool).includes(actorType);
}
