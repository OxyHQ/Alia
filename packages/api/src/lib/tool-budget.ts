/**
 * The per-turn tool budget, and the loader that keeps it without hiding a
 * single tool.
 *
 * ## Why
 *
 * One inference request carries at most {@link MAX_TOOLS_PER_INFERENCE_REQUEST}
 * tools (`lib/inference/tool-limit.ts` says where the number comes from), and
 * their definitions share the request's byte budget with the conversation
 * (`lib/inference/request-budget.ts`). A turn assembled 143 tools — 93 of them
 * Mention's — and the whole request was refused. Dropping tools to fit would be
 * the same failure in a quieter shape: the person asks for something a
 * connected app can do, and the model simply does not know it could.
 *
 * ## Deferred tools, loaded by the model one tool at a time
 *
 * When the assembled set fits, nothing changes: every tool is sent, every step.
 * When it does not, the set is split in two and BOTH halves stay registered
 * with the AI SDK:
 *
 *  - **Core tools are always active.** Everything that is not a connected app:
 *    the clock, built-ins and artifacts, the person's memory and messaging
 *    tools, runtime/session primitives, skills, agent search and
 *    `consultAgent` — and the caller's own editor tools, which a client executes
 *    itself and so must always see.
 *  - **App tools are deferred.** Each Oxy service (`oxy_<app>__*`), each MCP
 *    server (`mcp_<server>__*`) and each OAuth integration contributes tools
 *    that are NOT in the request until the model loads them. The turn gets one
 *    extra tool, `loadTools({ names?, query?, limit?, unload? })`, and a
 *    catalogue in the system prompt: every app, what it covers, and the NAMES
 *    of its tools — no definitions. The model loads exact names it read there,
 *    or describes what it needs and gets the best matches loaded. From the NEXT
 *    step those tools' real definitions are in the request, via the AI SDK's
 *    `prepareStep` → `activeTools`.
 *
 * The unit is the TOOL, never the app. An app whose tools do not all fit — a
 * 94-tool Mention against a byte budget its core already half fills — is not
 * "too big to open": the model loads the five tools the request needs. The
 * earlier design opened whole apps, and Mention could never be opened at all.
 *
 * Because the full `ToolSet` stays registered, execution is untouched: the
 * model calls `oxy_mention__createPost` itself, and the SDK runs the same
 * `execute` the assembler built — with its authorization, the runtime policy,
 * the truncation wrapper, Oxy step status and the tool-name mapping all exactly
 * as for a turn that fit. There is no proxy tool and no second way in.
 * `activeTools` narrows only what is SENT, which is the one thing the limits
 * are about.
 *
 * ## What is loaded before the model asks
 *
 * In this order, each counted against the budget before the next:
 *
 *  1. **The person's explicit picks** (`pins`): today the composer's connector
 *     pick (`mcpServerId`), which selects one whole MCP server. A pin may also
 *     be one exact tool name. A picked app's tools are loaded while they fit
 *     and stay loaded (the model cannot unload them); whatever does not fit is
 *     still in the catalogue and loadable by name, so a pick can never make a
 *     turn fail.
 *  2. **Sticky tools**: tools the model called earlier in the conversation,
 *     read from the history the client replays (`priorToolCalls`), most recent
 *     first, while they fit. One it no longer has room for is simply left
 *     unloaded — the catalogue still lists it.
 *
 * ## The budget is the model's
 *
 * The bytes the definitions may take are a share of the request input budget
 * for the model the turn runs on (`requestInputBudgetBytes`: the model's
 * context window and the server's limit), passed in as `inputBudgetBytes`. This
 * file holds no byte constant of its own.
 */

import { asSchema, tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { declareReadOnly } from './agent/tool-effects.js';
import {
  requestInputBudgetBytes,
  toolDefinitionBytes,
  toolDefinitionsBudgetBytes,
} from './inference/request-budget.js';
import {
  MAX_TOOLS_PER_INFERENCE_REQUEST,
  ToolLimitExceededError,
  toolFamilyOf,
} from './inference/tool-limit.js';
import { log } from './logger.js';

export const LOAD_TOOLS_TOOL = 'loadTools';

/** How many search matches `loadTools({ query })` loads when `limit` is not given. */
const DEFAULT_QUERY_LOADS = 5;
/** The most it loads for one query. */
const MAX_QUERY_LOADS = 10;
/** The most unload candidates a result names. */
const MAX_UNLOAD_CANDIDATES = 10;
/** The longest tool description a `loadTools` result repeats. */
const RESULT_DESCRIPTION_CHARS = 160;

/** The instanced sources whose tools are apps. */
export type AppToolSource = 'oxy_service' | 'mcp' | 'integration';

/** One app: a single Oxy service, a single MCP server, or a single integration. */
export interface ToolApp {
  /** The app's id in the catalogue — `mention`, `mcp_github`, `google_calendar`. */
  readonly id: string;
  readonly label: string;
  readonly source: AppToolSource;
  readonly names: readonly string[];
  /**
   * What the app covers, as the words its own tools are named with — `email`,
   * `mailbox`, `thread` for Inbox; `calendar`, `event` for Google Calendar.
   * Derived from the tool names the app registered, never from a list kept
   * here, so a new app describes itself the moment it has tools.
   */
  readonly covers: readonly string[];
}

/** A tool call already in the conversation, as the client replayed it. */
export interface PriorToolCall {
  readonly toolName: string;
  readonly args?: unknown;
  readonly result?: unknown;
}

/**
 * The per-call options a budgeted set adds beside `tools`.
 *
 * Spread into `streamText`/`generateText` as they are. Empty when everything
 * fits, which is exactly today's behaviour.
 */
export interface ToolRouting {
  activeTools?: string[];
  prepareStep?: () => { activeTools: string[] };
}

export interface BudgetedToolSet {
  /** Every tool the turn may call — registered in full. */
  readonly tools: ToolSet;
  /** What bounds the request. Spread it beside `tools`. */
  readonly routing: ToolRouting;
  /** The tool catalogue section of the system prompt; empty when nothing is deferred. */
  readonly appCatalogPrompt: string;
  /** The tools the next step will send. */
  activeToolNames(): string[];
}

/* -------------------------------------------------------------------------- */
/*  Apps                                                                      */
/* -------------------------------------------------------------------------- */

/** `[Google Calendar] List upcoming…` → `Google Calendar`. Every source writes this prefix. */
function bracketLabel(description: string | undefined): string | null {
  const match = /^\[([^\]]+)\]/.exec(description ?? '');
  return match ? match[1].trim() : null;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'app'
  );
}

/**
 * Words a tool name uses to say what it DOES rather than what it is about.
 *
 * Grammar, not app knowledge: `searchEmails` and `list_issues` are about emails
 * and issues. What is left once these are gone is what the app covers.
 */
const ACTION_WORDS = new Set([
  'get',
  'list',
  'search',
  'find',
  'query',
  'read',
  'fetch',
  'load',
  'view',
  'show',
  'lookup',
  'look',
  'create',
  'add',
  'new',
  'insert',
  'make',
  'build',
  'generate',
  'upload',
  'import',
  'export',
  'download',
  'update',
  'edit',
  'modify',
  'patch',
  'set',
  'put',
  'upsert',
  'change',
  'rename',
  'replace',
  'toggle',
  'delete',
  'remove',
  'clear',
  'reset',
  'close',
  'open',
  'archive',
  'unarchive',
  'restore',
  'send',
  'move',
  'copy',
  'mark',
  'check',
  'use',
  'run',
  'call',
  'execute',
  'do',
  'start',
  'stop',
  'cancel',
  'is',
  'has',
  'can',
  'by',
  'for',
  'from',
  'to',
  'of',
  'in',
  'on',
  'at',
  'with',
  'and',
  'or',
  'the',
  'a',
  'an',
  'my',
  'me',
  'all',
  'one',
  'many',
  'id',
  'ids',
  'info',
  'details',
  'detail',
  'data',
  'item',
  'items',
]);

/** The most a catalog line says about one app. */
const MAX_COVERS = 8;

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:x|ch|sh|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word))
    return word.slice(0, -1);
  return word;
}

/** The action part of a tool name: `oxy_inbox__searchEmails` → `searchEmails`. */
function actionOf(name: string): string {
  const at = name.indexOf('__');
  if (at < 0) return name;
  const rest = name.slice(at + 2);
  // An Oxy tool bound to one resource carries a third `__<suffix>` segment.
  const end = rest.indexOf('__');
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * What an app covers, from its tools' names: their subject words, most used
 * first. `searchEmails`, `readEmail`, `listMailboxes`, `getEmailThread` →
 * `email, mailbox, thread`.
 */
export function coversOf(names: readonly string[], exclude: readonly string[] = []): string[] {
  const skip = new Set(exclude.flatMap((text) => text.toLowerCase().split(/[^a-z0-9]+/)));
  const counts = new Map<string, number>();
  for (const name of names) {
    const words = actionOf(name)
      .split(
        /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])|[^A-Za-z0-9]+/,
      )
      .map((word) => singular(word.toLowerCase()))
      .filter(
        (word) =>
          word.length > 2 && !/^\d+$/.test(word) && !ACTION_WORDS.has(word) && !skip.has(word),
      );
    for (const word of new Set(words)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  // Map order is first appearance, and the sort is stable: ties keep it.
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_COVERS)
    .map(([word]) => word);
}

/**
 * The apps in an assembled set, from the sources that built them.
 *
 * A name counts only when the assembled set still holds THAT source's tool under
 * it (`tools[name] === source[name]`): an editor tool with the same name
 * replaced it during assembly, and an editor tool is always core.
 */
export function appsOf(
  tools: ToolSet,
  sources: Readonly<Record<AppToolSource, ToolSet>>,
): ToolApp[] {
  const grouped = new Map<
    string,
    { id: string; label: string; source: AppToolSource; names: string[] }
  >();
  for (const source of ['oxy_service', 'mcp', 'integration'] as const) {
    for (const [name, built] of Object.entries(sources[source])) {
      if (tools[name] !== built) continue;
      const label = bracketLabel(built.description);
      let key: string;
      let id: string;
      if (source === 'integration') {
        id = slug(label ?? 'integrations');
        key = `integration:${id}`;
      } else {
        key = toolFamilyOf(name);
        id = source === 'oxy_service' ? key.replace(/^oxy_/, '') : key;
      }
      const entry = grouped.get(key) ?? { id, label: label ?? id, source, names: [] };
      entry.names.push(name);
      grouped.set(key, entry);
    }
  }

  // Ids are what the model types, so two apps may never share one.
  const taken = new Set<string>();
  const apps: ToolApp[] = [];
  for (const entry of [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    let id = entry.id;
    if (taken.has(id)) id = `${entry.source}_${id}`;
    for (let n = 2; taken.has(id); n += 1) id = `${entry.source}_${entry.id}_${n}`;
    taken.add(id);
    const names = entry.names.sort();
    apps.push({
      id,
      label: entry.label,
      source: entry.source,
      names,
      covers: coversOf(names, [id, entry.label]),
    });
  }
  return apps;
}

/** An app by what a model or a pick might call it: its id, its tool prefix or its label. */
function findApp(apps: readonly ToolApp[], requested: string): ToolApp | undefined {
  const wanted = requested.trim().toLowerCase();
  return (
    apps.find((app) => app.id.toLowerCase() === wanted) ??
    apps.find((app) => app.source === 'oxy_service' && `oxy_${app.id}`.toLowerCase() === wanted) ??
    apps.find((app) => app.label.toLowerCase() === wanted)
  );
}

/* -------------------------------------------------------------------------- */
/*  Tool names: resolving and searching                                       */
/* -------------------------------------------------------------------------- */

/** The part of a tool name the catalogue lists under its app's prefix. */
function prefixOf(app: ToolApp): string {
  if (app.source === 'integration') return '';
  const prefix = `${toolFamilyOf(app.names[0] ?? '')}__`;
  return app.names.every((name) => name.startsWith(prefix)) ? prefix : '';
}

/** Lowercase subject words of a text: camelCase and punctuation split, plurals folded. */
function wordsOf(text: string): string[] {
  return text
    .split(
      /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])|[^A-Za-z0-9]+/,
    )
    .map((word) => singular(word.toLowerCase()))
    .filter((word) => word.length > 2 && !/^\d+$/.test(word));
}

/** Words that say nothing about what a request is for. */
const QUERY_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'tool']);

/** What a tool is known by in a search, with how much each kind of match counts. */
interface Searchable {
  readonly name: string;
  readonly nameWords: ReadonlySet<string>;
  readonly appWords: ReadonlySet<string>;
  readonly descriptionWords: ReadonlySet<string>;
}

const NAME_MATCH = 5;
const APP_MATCH = 3;
const DESCRIPTION_MATCH = 1;

function searchScore(item: Searchable, terms: readonly string[]): number {
  let score = 0;
  for (const term of terms) {
    if (item.nameWords.has(term)) score += NAME_MATCH;
    if (item.appWords.has(term)) score += APP_MATCH;
    if (item.descriptionWords.has(term)) score += DESCRIPTION_MATCH;
  }
  return score;
}

/** A description trimmed to a line the model can scan. */
function oneLine(text: string | undefined): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > RESULT_DESCRIPTION_CHARS
    ? `${flat.slice(0, RESULT_DESCRIPTION_CHARS - 1)}…`
    : flat;
}

/* -------------------------------------------------------------------------- */
/*  What was loaded earlier in the conversation                               */
/* -------------------------------------------------------------------------- */

/**
 * The deferred tools the model already used in this conversation, most recent
 * first.
 *
 * Read from the history the client sends — the same history the model reads —
 * rather than from a new column: a tool whose call sits in that history is one
 * the model will expect to call again, and the record of it is already on every
 * request. A tool that was loaded and never called is not sticky (a search
 * loads several and the request uses one), and one the model later unloaded
 * (`loadTools` results are replayed) is not either.
 */
export function stickyToolsFrom(
  deferred: ReadonlySet<string>,
  calls: readonly PriorToolCall[],
): string[] {
  const recency: string[] = [];
  const touch = (name: string): void => {
    const at = recency.indexOf(name);
    if (at >= 0) recency.splice(at, 1);
    recency.push(name);
  };
  const untouch = (name: string): void => {
    const at = recency.indexOf(name);
    if (at >= 0) recency.splice(at, 1);
  };
  for (const call of calls) {
    if (call.toolName === LOAD_TOOLS_TOOL) {
      const unloaded = (call.result as { unloaded?: unknown } | undefined)?.unloaded;
      if (Array.isArray(unloaded))
        for (const name of unloaded) if (typeof name === 'string') untouch(name);
      continue;
    }
    if (deferred.has(call.toolName)) touch(call.toolName);
  }
  return recency.reverse();
}

/* -------------------------------------------------------------------------- */
/*  The budget                                                                */
/* -------------------------------------------------------------------------- */

export interface BudgetToolsInput {
  /** The whole assembled set, runtime policy already applied. */
  readonly tools: ToolSet;
  /** The app sources, so apps are known by origin rather than guessed from names. */
  readonly sources: Readonly<Record<AppToolSource, ToolSet>>;
  /** Explicit picks: app ids or exact tool names. Loaded first, never unloaded. */
  readonly pins?: readonly string[];
  /** Tool calls already in this conversation, oldest first. */
  readonly priorToolCalls?: readonly PriorToolCall[];
  /** The most tools one request carries. */
  readonly budget?: number;
  /**
   * The request input budget of the model this turn runs on, in bytes
   * (`requestInputBudgetBytes` in `inference/request-budget.ts`). The tool
   * definitions may take a share of it ({@link toolDefinitionsBudgetBytes}).
   * Absent, it is the server's limit — a power level, whose model is Oxy's pick.
   */
  readonly inputBudgetBytes?: number;
}

/**
 * What one tool adds to a request, as the Kaana adapter sends it: the contract's
 * `{ type, name, description, parameters, strict }`, measured by
 * `request-budget.ts`. A schema that only resolves asynchronously is counted
 * without its parameters — the adapter's own measurement is still exact.
 */
export function sentToolBytes(name: string, built: Tool): number {
  let parameters: Record<string, unknown> = {};
  try {
    const schema: unknown = asSchema(built.inputSchema).jsonSchema;
    if (
      schema !== null &&
      typeof schema === 'object' &&
      typeof (schema as { then?: unknown }).then !== 'function'
    )
      parameters = schema as Record<string, unknown>;
  } catch {
    // Unmeasurable schema: counted as empty here, measured exactly at the seam.
  }
  return toolDefinitionBytes({
    type: 'function',
    name,
    ...(built.description === undefined ? {} : { description: built.description }),
    parameters,
    ...(built.strict === undefined ? {} : { strict: built.strict }),
  });
}

/**
 * Fit a turn's tools to the per-request limits: at most `budget` tools, whose
 * definitions add at most the model's share of the request input budget.
 *
 * The bytes matter because the request's whole input has a byte ceiling: a set
 * of fewer than 128 tools with large schemas can leave no room for the
 * conversation. Over either limit, app tools are deferred behind `loadTools`.
 *
 * Throws {@link ToolLimitExceededError} only when the turn cannot be served
 * without dropping something the caller explicitly asked for: core tools
 * (including the client's own) that alone exceed the tool count.
 */
export function budgetTools(input: BudgetToolsInput): BudgetedToolSet {
  const {
    tools,
    sources,
    pins = [],
    priorToolCalls = [],
    budget = MAX_TOOLS_PER_INFERENCE_REQUEST,
    inputBudgetBytes = requestInputBudgetBytes(),
  } = input;
  const definitionBytesBudget = toolDefinitionsBudgetBytes(inputBudgetBytes);
  const allNames = Object.keys(tools);
  const bytesOf = new Map(allNames.map((name) => [name, sentToolBytes(name, tools[name])]));
  const assembledBytes = [...bytesOf.values()].reduce((sum, bytes) => sum + bytes, 0);

  if (allNames.length <= budget && assembledBytes <= definitionBytesBudget) {
    return { tools, routing: {}, appCatalogPrompt: '', activeToolNames: () => allNames };
  }

  const apps = appsOf(tools, sources);
  const deferredNames = apps.flatMap((app) => app.names);
  const deferred = new Set(deferredNames);
  const core = allNames.filter((name) => !deferred.has(name));
  const coreSet = new Set(core);

  if (Object.hasOwn(tools, LOAD_TOOLS_TOOL)) {
    throw new ToolLimitExceededError({
      toolCount: allNames.length,
      message: `"${LOAD_TOOLS_TOOL}" is a reserved tool name when a turn carries more than ${budget} tools.`,
    });
  }
  if (core.length + 1 > budget) {
    throw new ToolLimitExceededError({
      toolCount: core.length,
      limit: budget - 1,
      message:
        `This turn has ${core.length} tools that must always be sent (including any the client supplied); ` +
        `at most ${budget - 1} fit in one request beside the tool loader.`,
    });
  }

  /** The deferred tools in the request, in the order they were loaded. */
  const loaded: string[] = [];
  /** The ones the person picked: the model cannot unload them. */
  const pinned = new Set<string>();
  let loaderBytes = 0;

  const activeToolNames = (): string[] => [...core, LOAD_TOOLS_TOOL, ...loaded];
  const bytesOfActive = (names: Iterable<string>): number => {
    let sum = 0;
    for (const name of names)
      sum += name === LOAD_TOOLS_TOOL ? loaderBytes : (bytesOf.get(name) ?? 0);
    return sum;
  };
  const activeBytes = (): number => bytesOfActive(activeToolNames());
  const fitsCount = (extra: number): boolean => activeToolNames().length + extra <= budget;
  const fitsBytes = (extraBytes: number): boolean =>
    activeBytes() + extraBytes <= definitionBytesBudget;
  const fits = (name: string): boolean => fitsCount(1) && fitsBytes(bytesOf.get(name) ?? 0);

  // What `loadTools` can search.
  const appOf = new Map<string, ToolApp>();
  for (const app of apps) for (const name of app.names) appOf.set(name, app);
  const searchable: Searchable[] = deferredNames.map((name) => {
    const app = appOf.get(name) as ToolApp;
    return {
      name,
      nameWords: new Set(wordsOf(actionOf(name))),
      appWords: new Set([...wordsOf(app.id), ...wordsOf(app.label), ...app.covers]),
      descriptionWords: new Set(wordsOf(tools[name].description ?? '')),
    };
  });

  /** A tool by what the model might call it, or why it is no tool of this turn. */
  const resolve = (
    requested: string,
  ): { name: string } | { unknown: string; didYouMean: string[] } => {
    const wanted = requested.trim().replace(/^`+|`+$/g, '');
    const lower = wanted.toLowerCase();
    if (Object.hasOwn(tools, wanted)) return { name: wanted };
    const same = allNames.filter((name) => name.toLowerCase() === lower);
    if (same.length === 1) return { name: same[0] };
    // The catalogue lists names under their app's prefix; the bare part is enough
    // when it names one tool.
    const bare = deferredNames.filter((name) => {
      const prefix = prefixOf(appOf.get(name) as ToolApp);
      return name.slice(prefix.length).toLowerCase() === lower;
    });
    if (bare.length === 1) return { name: bare[0] };
    const near = allNames
      .filter((name) => name !== LOAD_TOOLS_TOOL && name.toLowerCase().includes(lower))
      .slice(0, 5);
    return { unknown: requested, didYouMean: lower.length >= 3 ? near : [] };
  };

  const loadToolsTool = createLoadToolsTool({
    tools,
    deferredNames,
    coreSet,
    loaded,
    pinned,
    searchable,
    resolve,
    fits,
    fitsCount,
    bytesOf,
    activeToolNames,
    activeBytes,
    budget,
    definitionBytesBudget,
    baseline: () => bytesOfActive([...core, LOAD_TOOLS_TOOL, ...pinned]),
    baselineCount: () => core.length + 1 + pinned.size,
    coreBytes: () => bytesOfActive([...core, LOAD_TOOLS_TOOL]),
    coreCount: () => core.length + 1,
  });
  loaderBytes = sentToolBytes(LOAD_TOOLS_TOOL, loadToolsTool);

  // 1. The person's picks, in the order given. Loaded while they fit, never unloaded.
  const notPreloaded: string[] = [];
  for (const pin of pins) {
    const app = findApp(apps, pin);
    const names = app ? app.names : deferred.has(pin) ? [pin] : [];
    // A pick naming a core tool is already active; one naming nothing this
    // turn can reach (a connector that is down) has nothing to load.
    for (const name of names) {
      if (loaded.includes(name)) continue;
      if (fits(name)) {
        loaded.push(name);
        pinned.add(name);
      } else notPreloaded.push(name);
    }
  }
  if (notPreloaded.length > 0) {
    log.tools.warn(
      { picked: pins, notPreloaded: notPreloaded.length },
      "The person's picked tools do not all fit in one request; the rest stay loadable by name",
    );
  }

  // 2. Tools the conversation already used, most recent first, while they fit.
  for (const name of stickyToolsFrom(deferred, priorToolCalls)) {
    if (!loaded.includes(name) && fits(name)) loaded.push(name);
  }

  const registered: ToolSet = { ...tools, [LOAD_TOOLS_TOOL]: loadToolsTool };

  log.tools.info(
    {
      assembled: allNames.length,
      core: core.length,
      apps: apps.map((app) => `${app.id}:${app.names.length}`),
      loaded: loaded.length,
      active: activeToolNames().length,
      budget,
      assembledBytes,
      activeBytes: activeBytes(),
      inputBudgetBytes,
      definitionBytesBudget,
    },
    'Tool budget applied: app tools are loaded on demand with loadTools',
  );

  return {
    tools: registered,
    routing: {
      activeTools: activeToolNames(),
      // Called before EVERY step, the first included, so a tool loaded by a
      // `loadTools` call in step N is in the request from step N+1.
      prepareStep: () => ({ activeTools: activeToolNames() }),
    },
    appCatalogPrompt: appCatalogPrompt(apps, budget),
    activeToolNames,
  };
}

/* -------------------------------------------------------------------------- */
/*  loadTools                                                                 */
/* -------------------------------------------------------------------------- */

interface LoaderState {
  readonly tools: ToolSet;
  readonly deferredNames: readonly string[];
  readonly coreSet: ReadonlySet<string>;
  readonly loaded: string[];
  readonly pinned: ReadonlySet<string>;
  readonly searchable: readonly Searchable[];
  readonly resolve: (
    requested: string,
  ) => { name: string } | { unknown: string; didYouMean: string[] };
  readonly fits: (name: string) => boolean;
  readonly fitsCount: (extra: number) => boolean;
  readonly bytesOf: ReadonlyMap<string, number>;
  readonly activeToolNames: () => string[];
  readonly activeBytes: () => number;
  readonly budget: number;
  readonly definitionBytesBudget: number;
  /** Bytes and count of what can never be unloaded: core, the loader, the picks. */
  readonly baseline: () => number;
  readonly baselineCount: () => number;
  /** Bytes and count of the always-sent tools alone: core and the loader. */
  readonly coreBytes: () => number;
  readonly coreCount: () => number;
}

/**
 *  - `tool_limit` / `size_limit`: no room NOW (count / bytes); unloading others makes it.
 *  - `picks_fill_request`: no room, and what holds it is the person's own picks,
 *    which cannot be unloaded.
 *  - `too_large`: the tool does not fit beside the always-sent tools even with
 *    nothing else loaded; no amount of unloading helps on this model.
 */
type NotLoadedReason = 'tool_limit' | 'size_limit' | 'picks_fill_request' | 'too_large';

function createLoadToolsTool(state: LoaderState): Tool {
  const {
    tools,
    coreSet,
    loaded,
    pinned,
    searchable,
    resolve,
    fits,
    fitsCount,
    bytesOf,
    activeToolNames,
    activeBytes,
    budget,
    definitionBytesBudget,
    baseline,
    baselineCount,
    coreBytes,
    coreCount,
  } = state;

  /** Why one tool cannot be loaded now, and whether closing others would help. */
  const whyNot = (name: string): NotLoadedReason => {
    const bytes = bytesOf.get(name) ?? 0;
    // Even with everything unloadable unloaded it would not fit: loading it is
    // impossible on this model, not a matter of making room.
    if (coreCount() + 1 > budget || coreBytes() + bytes > definitionBytesBudget) return 'too_large';
    if (baselineCount() + 1 > budget || baseline() + bytes > definitionBytesBudget)
      return 'picks_fill_request';
    return fitsCount(1) ? 'size_limit' : 'tool_limit';
  };

  return declareReadOnly(
    tool({
      description:
        "Load tools from the person's connected apps (listed in the system prompt) so you can call them from your next step. " +
        'Pass `names` (exact tool names from the list) and/or `query` (what you need, in a few words — the best matches are loaded). ' +
        'Pass `unload` to free room first. Call this BEFORE saying you cannot do something an app covers.',
      inputSchema: z.object({
        names: z
          .array(z.string())
          .optional()
          .describe('Exact tool names from the app list to load, most important first.'),
        query: z
          .string()
          .optional()
          .describe('What you need, e.g. "search notes" or "send email"; loads the best matches.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_QUERY_LOADS)
          .optional()
          .describe(`How many matches a query loads (default ${DEFAULT_QUERY_LOADS}).`),
        unload: z
          .array(z.string())
          .optional()
          .describe('Loaded tools you no longer need, to make room.'),
      }),
      execute: async ({ names, query, limit, unload }) => {
        const unloaded: string[] = [];
        const keptLoaded: string[] = [];
        const unknown: Array<{ name: string; didYouMean?: string[] }> = [];
        for (const requested of unload ?? []) {
          const found = resolve(requested);
          if (!('name' in found)) continue;
          if (pinned.has(found.name)) keptLoaded.push(found.name);
          else if (loaded.includes(found.name)) {
            loaded.splice(loaded.indexOf(found.name), 1);
            unloaded.push(found.name);
          }
        }

        const wanted: string[] = [];
        for (const requested of names ?? []) {
          const found = resolve(requested);
          if ('name' in found) wanted.push(found.name);
          else
            unknown.push({
              name: found.unknown,
              ...(found.didYouMean.length ? { didYouMean: found.didYouMean } : {}),
            });
        }

        let searched: { query: string; matches: string[] } | undefined;
        const text = query?.trim();
        if (text) {
          const terms = [...new Set(wordsOf(text))].filter((word) => !QUERY_STOP_WORDS.has(word));
          const ranked = searchable
            .map((item) => ({ name: item.name, score: searchScore(item, terms) }))
            .filter((hit) => hit.score > 0)
            .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
            .slice(0, limit ?? DEFAULT_QUERY_LOADS)
            .map((hit) => hit.name);
          searched = { query: text, matches: ranked };
          wanted.push(...ranked);
        }

        const newlyLoaded: Array<{ name: string; description: string }> = [];
        const alreadyLoaded: string[] = [];
        const notLoaded: Array<{ name: string; reason: NotLoadedReason; bytes: number }> = [];
        for (const name of [...new Set(wanted)]) {
          if (coreSet.has(name) || loaded.includes(name)) alreadyLoaded.push(name);
          else if (fits(name)) {
            loaded.push(name);
            newlyLoaded.push({ name, description: oneLine(tools[name].description) });
          } else notLoaded.push({ name, reason: whyNot(name), bytes: bytesOf.get(name) ?? 0 });
        }

        const unloadCandidates = loaded
          .filter((name) => !pinned.has(name))
          .slice(0, MAX_UNLOAD_CANDIDATES);
        const nothingAsked = !names?.length && !text && !unload?.length;
        const hints: string[] = [];
        if (nothingAsked)
          hints.push(
            'Nothing was asked. Pass `names` (exact tool names from the list), a `query`, or `unload`.',
          );
        if (searched && searched.matches.length === 0)
          hints.push(
            'No tool matches that query. Try other words for the action and the subject (e.g. "list notes"), or load by exact name from the app list.',
          );
        const impossible = notLoaded.filter((entry) => entry.reason === 'too_large');
        if (impossible.length > 0)
          hints.push(
            `${impossible.map((entry) => entry.name).join(', ')} cannot be loaded on this model: its definition does not fit the request even with nothing else loaded.`,
          );
        const filled = notLoaded.filter((entry) => entry.reason === 'picks_fill_request');
        if (filled.length > 0)
          hints.push(
            `${filled.map((entry) => entry.name).join(', ')}: the tools the person picked fill the request and cannot be unloaded.`,
          );
        const needsRoom = notLoaded.filter(
          (entry) => entry.reason === 'tool_limit' || entry.reason === 'size_limit',
        );
        if (needsRoom.length > 0) {
          hints.push(
            unloadCandidates.length > 0
              ? `No room for ${needsRoom.map((entry) => entry.name).join(', ')}. Unload tools you are done with (e.g. ${unloadCandidates.slice(0, 3).join(', ')}) with loadTools({ unload: [...] }) and ask again.`
              : `No room for ${needsRoom.map((entry) => entry.name).join(', ')}, and no loaded tool can be unloaded; ask for fewer tools.`,
          );
        }

        return {
          loaded: newlyLoaded,
          ...(alreadyLoaded.length ? { alreadyLoaded } : {}),
          ...(unloaded.length ? { unloaded } : {}),
          ...(keptLoaded.length
            ? { keptLoaded, keptLoadedReason: 'selected by the person for this message' }
            : {}),
          ...(notLoaded.length ? { notLoaded } : {}),
          ...(unknown.length ? { unknown } : {}),
          ...(searched ? { searched } : {}),
          ...(needsRoom.length > 0 && unloadCandidates.length > 0 ? { unloadCandidates } : {}),
          capacity: {
            tools: activeToolNames().length,
            maxTools: budget,
            definitionBytes: activeBytes(),
            maxDefinitionBytes: definitionBytesBudget,
          },
          ...(hints.length ? { hint: hints.join(' ') } : {}),
          ...(newlyLoaded.length
            ? { note: 'The loaded tools are available from your next step.' }
            : {}),
        };
      },
    }),
  );
}

/**
 * The tool catalogue section of the system prompt.
 *
 * Written for the weakest model that may read it. A model shown only its tool
 * list concludes that what is not in it does not exist, and answers "I don't
 * have access to your email" while the person's mailbox is one `loadTools` call
 * away. So the section says, before anything else, that the access is REAL,
 * what each app covers, and that loading comes before any refusal. The person
 * may ask in any language and by any name — the model matches by meaning, which
 * is why the catalogue carries subjects and every tool's name rather than
 * keywords. Definitions are NOT here: a name costs a few bytes, a definition
 * hundreds, and the catalogue is the same on every step.
 */
function appCatalogPrompt(apps: readonly ToolApp[], budget: number): string {
  const lines = apps.map((app) => {
    const covers = app.covers.length ? `: ${app.covers.join(', ')}` : '';
    const prefix = prefixOf(app);
    const names = app.names.map((name) => name.slice(prefix.length)).join(', ');
    return (
      `- ${app.id} — ${app.label} (${app.names.length} tools)${covers}\n` +
      `  tools${prefix ? ` (prefix \`${prefix}\`)` : ''}: ${names}`
    );
  });
  return (
    "\n\n## Tools from the person's apps\n" +
    'The person has connected the apps below, and through them you DO have access to their data and can act for ' +
    'them in everything each app covers. Their tools do not all fit in one request, so only the ones you load are in ' +
    "your tool list; every tool's name is listed here.\n" +
    `- When a request touches anything an app covers — in any language, by any name, synonym or brand ` +
    '(e.g. "mail", "correo", "courriel" and a mail brand all mean email) — call ' +
    `\`${LOAD_TOOLS_TOOL}\` FIRST: \`${LOAD_TOOLS_TOOL}({ names: [...] })\` with the exact names below, or ` +
    `\`${LOAD_TOOLS_TOOL}({ query: "what you need" })\` to search by intent. Call the loaded tools from your next step, ` +
    'then answer from what they return.\n' +
    '- Never say you cannot access, see or do something an app below covers until you have loaded its tools and ' +
    'they failed. Do not ask the person for permission to load a tool; they connected the app to be used.\n' +
    `- Load only what the request needs: at most ${budget} tools can be in a request. When the result says there is ` +
    `no room, unload tools you are done with (\`${LOAD_TOOLS_TOOL}({ unload: [...] })\`) and ask again.\n` +
    'Apps (id — name (tools): what it covers):\n' +
    lines.join('\n')
  );
}
