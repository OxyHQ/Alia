/**
 * What an agent may reach, in ONE vocabulary, partitioned by tool family.
 *
 * ## The three it replaces, and why none of them worked
 *
 * `agents` carried three parallel answers to "what can this agent touch", and
 * they contradicted each other before they failed:
 *
 *  - **`capabilities`** — eight free-text ids the agent editor wrote and the
 *    catalogue searched. The ASSEMBLER never read them once. Decorative for as
 *    long as the column existed.
 *  - **`permissions`** — six booleans, the only one with a real consumer, and
 *    that consumer honoured TWO of the six (`mcp_servers` and `communications`)
 *    while the other four reached a stub in the autonomous runner and nothing
 *    anywhere else. It never persisted either: `PATCH /agents/:id` is `strict()`
 *    and does not name it, so every autosave the editor sent was a 400.
 *  - **`archetypeConfig.knowledgeSources`** (and its twin `dataSources`) — three
 *    string lists naming integrations, MCP servers and Oxy services, spliced
 *    into the Q&A and status prompts as PROSE. They told the model a source
 *    existed; they did not decide whether its tools were in the set.
 *
 * Between the first two the same concept was spelled twice and differently:
 * `web-browsing`/`network` shared a label, `code-execution`/`shell` shared an
 * icon, `file-management`/`file System` shared a description, and
 * `google-search` and `web-scraping` were both subsets of `network`. Fourteen
 * rows for nine ideas, and an owner had to set both lists to mean one thing.
 *
 * ## The families are derived from the assembler, not invented beside it
 *
 * Each family below names tools `lib/tool-pipeline.ts` actually constructs, and
 * `lib/__tests__/capability-grants.test.ts` proves it: it grants one family at a
 * time, runs the real assembler, and asserts the difference is exactly that
 * family's tools. A tool belonging to no family shows up there as a name in the
 * all-granted run that no single-family run produced.
 *
 * ## Denying is the default, and that is a deliberate behaviour change
 *
 * `permissions` was the other way round: a NULL meant allowed and only a stored
 * `false` denied, so an agent nobody had configured could reach everything its
 * owner could. An agent now acts in the world under its own name, from its own
 * Oxy account, so the absence of a decision cannot keep meaning permission. An
 * agent with no grants gets {@link UNGRANTED_TOOLS} and nothing else.
 *
 * Ordinary Alia — a turn with no agent — is unaffected. It has no grants to read
 * and reaches whatever its surface structurally allows, exactly as before.
 */

/**
 * A family whose tool names are written in code, granted whole.
 *
 * The name is the same in the grant string, in the wire schema and in the UI.
 */
export const FIXED_CAPABILITY_FAMILIES = [
  'web',
  'browser',
  'shell',
  'files',
  'artifacts',
  'memory',
  'messaging',
  'automation',
  'delegation',
] as const;

/**
 * A family whose tools are GENERATED from rows, granted one row at a time.
 *
 * The rule is not a judgement call: a family is instanced exactly when its tool
 * names come from data rather than from source. `mcp_<connector>__<tool>` and
 * `oxy_<service>__<tool>` are built from `mcp_servers` and `oxy_services` rows,
 * and an integration is a row in the owner's connected services. Nobody can
 * enumerate those at the time this file is written, so a whole-family grant
 * would be a blank cheque over rows that do not exist yet — which is precisely
 * what an agent inheriting *all* of its owner's connectors was.
 */
export const INSTANCED_CAPABILITY_FAMILIES = ['mcp', 'oxy_service', 'integration'] as const;

export const CAPABILITY_FAMILIES = [
  ...FIXED_CAPABILITY_FAMILIES,
  ...INSTANCED_CAPABILITY_FAMILIES,
] as const;

export type FixedCapabilityFamily = (typeof FIXED_CAPABILITY_FAMILIES)[number];
export type InstancedCapabilityFamily = (typeof INSTANCED_CAPABILITY_FAMILIES)[number];
export type CapabilityFamily = (typeof CAPABILITY_FAMILIES)[number];

/**
 * The tools each fixed family contributes, as `ToolPipeline.forUser` builds them.
 *
 * Stated here as well as in the assembler so the agent editor can say what a
 * toggle actually does, and so the gate has something to compare the assembler
 * against. The two cannot drift: the gate derives the real answer by running
 * the assembler and fails on any difference in either direction.
 *
 * A tool is in exactly one family. `deepResearch` sits under `web` rather than
 * beside `delegation` because what it does is read the open web; `generateFile`
 * sits under `artifacts` rather than `files` because it writes nothing and
 * hands the content back for rendering, which is what `canvas` does too.
 */
export const FIXED_FAMILY_TOOLS: Readonly<Record<FixedCapabilityFamily, readonly string[]>> = {
  web: ['webSearch', 'webScraper', 'browse', 'deepResearch'],
  browser: ['browser'],
  shell: ['shell'],
  files: ['file_edit'],
  artifacts: ['canvas', 'generateFile'],
  /**
   * `searchThread` is here rather than in a family of its own because the
   * family is "reach what this person has already told you". Three of the four
   * write that down deliberately; this one reads back what was said in passing.
   * An owner who denies an agent memory is denying it exactly that, and a
   * separate family would let it recall the whole thread anyway.
   */
  memory: [
    'saveUserMemory',
    'updateUserMemory',
    'updateUserPreferences',
    'updateUserContext',
    'searchThread',
  ],
  messaging: [
    'sendTelegramMessage',
    'getWhatsAppChats',
    'getWhatsAppMessages',
    'sendWhatsAppMessage',
  ],
  automation: ['createTrigger', 'listTriggers', 'updateTrigger', 'deleteTrigger'],
  delegation: ['createAgent', 'searchAgents', 'delegateToAgent', 'delegate'],
};

/**
 * The tools no grant governs, and the reason each one is not a capability.
 *
 * A deny-by-default vocabulary needs this list to be short, named and argued,
 * because "harmless" is otherwise a judgement anyone can extend. Every entry
 * here either describes the turn it is already inside or drives Alia's own
 * composer; none of them reads data, reaches the network or touches another
 * service.
 *
 *  - `getCurrentDate` — the clock. Already unconditional even for a trigger
 *    whose author switched tools off entirely.
 *  - `getDeviceInfo` — describes the device the surface already told us about.
 *    It cannot describe one it was not given.
 *  - `switchModel` — which model answers is `agents.allowed_models`, a policy
 *    this agent already carries. A second switch over the same decision is the
 *    duplication this vocabulary exists to end.
 *  - `planPreview` — an SSE frame Alia's composer draws. Gated already on the
 *    caller being that composer.
 *  - `plan` — the autonomous runner's own checklist AND its completion signal.
 *    An agent denied it could never finish a session, so it is protocol rather
 *    than capability.
 */
export const UNGRANTED_TOOLS: readonly string[] = [
  'getCurrentDate',
  'getDeviceInfo',
  'switchModel',
  'planPreview',
  'plan',
];

/** `family` or `family:instanceId`, which is how a grant is stored and sent. */
const GRANT = /^([a-z_]+)(?::(.+))?$/;

function isFamily(value: string): value is CapabilityFamily {
  return (CAPABILITY_FAMILIES as readonly string[]).includes(value);
}

export function isInstancedFamily(family: CapabilityFamily): family is InstancedCapabilityFamily {
  return (INSTANCED_CAPABILITY_FAMILIES as readonly string[]).includes(family);
}

/**
 * Whether a stored grant string is one this vocabulary recognises.
 *
 * A fixed family carries no instance and an instanced one requires a non-empty
 * instance id: `mcp` alone is refused rather than read as "every connector",
 * which is the blank cheque the instanced families exist to prevent.
 */
export function isCapabilityGrant(value: string): boolean {
  const match = GRANT.exec(value);
  if (match === null) return false;
  const [, family, instanceId] = match;
  if (!isFamily(family)) return false;
  return isInstancedFamily(family) ? instanceId !== undefined : instanceId === undefined;
}

/** The canonical string for a grant, and the only place the separator is written. */
export function formatCapabilityGrant(family: CapabilityFamily, instanceId?: string): string {
  return instanceId === undefined ? family : `${family}:${instanceId}`;
}

/**
 * What a turn may reach, asked family by family.
 *
 * An INSTANCE question is separate from the family question on purpose:
 * `allows('mcp')` says whether any connector at all was granted, and
 * {@link instances} says which. A caller that fetched every connector because
 * `allows` was true would be back to the blank cheque.
 */
export interface CapabilityGrantSet {
  allows(family: CapabilityFamily): boolean;
  /**
   * The granted rows of an instanced family.
   *
   * `null` means EVERY row, which only {@link GRANTS_EVERYTHING} answers — an
   * agent's set answers an array, empty when nothing was granted.
   */
  instances(family: InstancedCapabilityFamily): readonly string[] | null;
}

/**
 * The answer for a turn with no agent: ordinary Alia, unpartitioned.
 *
 * Not "an agent with every grant" — an agent's set can never return `null` from
 * {@link CapabilityGrantSet.instances}, and that difference is what keeps a
 * missing agent from silently reading as a fully-granted one.
 */
export const GRANTS_EVERYTHING: CapabilityGrantSet = {
  allows: () => true,
  instances: () => null,
};

/**
 * Read a stored `capability_grants` array.
 *
 * Unrecognised entries are DROPPED rather than throwing: the column has no
 * CHECK — the same reasoning `allowed_models` one column over is given — so a
 * value written before a family was renamed must not take the turn down with
 * it. The wire schema is where a bad grant is refused, at the moment somebody
 * can still be told about it.
 */
export function readCapabilityGrants(stored: readonly string[]): CapabilityGrantSet {
  const families = new Set<CapabilityFamily>();
  const instances = new Map<InstancedCapabilityFamily, string[]>();
  for (const family of INSTANCED_CAPABILITY_FAMILIES) instances.set(family, []);

  for (const entry of stored) {
    if (!isCapabilityGrant(entry)) continue;
    const match = GRANT.exec(entry);
    if (match === null) continue;
    const family = match[1] as CapabilityFamily;
    families.add(family);
    if (isInstancedFamily(family) && match[2] !== undefined) {
      instances.get(family)?.push(match[2]);
    }
  }

  return {
    allows: (family) => families.has(family),
    instances: (family) => instances.get(family) ?? [],
  };
}
