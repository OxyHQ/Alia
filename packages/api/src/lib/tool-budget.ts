/**
 * The per-turn tool budget, and the app router that keeps it without hiding a
 * single tool.
 *
 * ## Why
 *
 * One inference request carries at most {@link MAX_TOOLS_PER_INFERENCE_REQUEST}
 * tools (`lib/inference/tool-limit.ts` says where the number comes from). A
 * turn assembled 143 in production — 93 of them Mention's — and the whole
 * request was refused. Dropping tools to fit would be the same failure in a
 * quieter shape: the person asks for something a connected app can do, and the
 * model simply does not know it could.
 *
 * ## Progressive disclosure, driven by the model
 *
 * When the assembled set fits, nothing changes: every tool is sent, every step.
 * When it does not, the set is split in two and BOTH halves stay registered
 * with the AI SDK:
 *
 *  - **Core tools are always active.** Everything that is not a connected app:
 *    the clock, built-ins and artifacts, the person's memory and messaging
 *    tools, runtime/session primitives, skills, agent search/delegation,
 *    `askAgent` — and the caller's own editor tools, which a client executes
 *    itself and so must always see.
 *  - **Apps are opened on demand.** Each Oxy service (`oxy_<app>__*`), each MCP
 *    server (`mcp_<server>__*`) and each OAuth integration is one APP. The turn
 *    gets one extra tool, `useApps({ apps, close? })`, and a catalog of every app
 *    it could open (system prompt + the tool's own description). Calling it
 *    marks apps open; from the NEXT step their real tools are in the request,
 *    via the AI SDK's `prepareStep` → `activeTools`.
 *
 * Because the full `ToolSet` stays registered, execution is untouched: the
 * model calls `oxy_mention__createPost` itself, and the SDK runs the same
 * `execute` the assembler built — with its authorization, the runtime policy,
 * the truncation wrapper, Oxy step status and the tool-name mapping all exactly
 * as for a turn that fit. There is no proxy tool and no second way in.
 * `activeTools` narrows only what is SENT, which is the one thing the limit is
 * about.
 *
 * ## What is open before the model asks
 *
 * In this order, each counted against the budget before the next:
 *
 *  1. **The person's explicit picks** (`pins`): today the composer's connector
 *     pick (`mcpServerId`), which selects one whole MCP server. A pin may also
 *     be one exact tool name — no surface sends one yet — and then that tool
 *     alone is activated, not its whole app: a pick of one tool is the narrower
 *     request and is honoured as such. Picks are never dropped: if they do not
 *     fit, the turn is refused with a {@link ToolLimitExceededError} naming them.
 *  2. **Sticky apps**: apps opened (or used) earlier in the conversation, read
 *     from the history the client replays (`priorToolCalls`), most recent
 *     first, while they fit. A sticky app that no longer fits is simply closed —
 *     the catalog still lists it and `useApps` reopens it.
 *
 * `useApps` then opens in the order the model asked, closing `close` first; an
 * app that would push the active set past the budget is not opened and is
 * named in the result, so the model can close something and ask again.
 */

import { tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { declareReadOnly } from './agent/tool-effects.js';
import {
  MAX_TOOLS_PER_INFERENCE_REQUEST,
  ToolLimitExceededError,
  toolFamilyOf,
} from './inference/tool-limit.js';
import { log } from './logger.js';

export const USE_APPS_TOOL = 'useApps';

/** The instanced sources whose tools are apps. */
export type AppToolSource = 'oxy_service' | 'mcp' | 'integration';

/** One app: a single Oxy service, a single MCP server, or a single integration. */
export interface ToolApp {
  /** What the model names in `useApps` — `mention`, `mcp_github`, `google_calendar`. */
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
  /** The Apps section of the system prompt; empty when nothing is routed. */
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

/**
 * The apps the conversation already had open, most recent first.
 *
 * Read from the history the client sends — the same history the model reads —
 * rather than from a new column: an app whose tool calls sit in that history is
 * one the model will expect to call again, and the record of it is already on
 * every request. `useApps` results are replayed (opened, then closed), and a
 * direct call to an app's tool counts as that app having been open.
 */
export function stickyAppsFrom(
  apps: readonly ToolApp[],
  calls: readonly PriorToolCall[],
): string[] {
  const appOfTool = new Map<string, string>();
  for (const app of apps) for (const name of app.names) appOfTool.set(name, app.id);
  const recency: string[] = [];
  const touch = (id: string): void => {
    const at = recency.indexOf(id);
    if (at >= 0) recency.splice(at, 1);
    recency.push(id);
  };
  const untouch = (id: string): void => {
    const at = recency.indexOf(id);
    if (at >= 0) recency.splice(at, 1);
  };
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

  for (const call of calls) {
    if (call.toolName === USE_APPS_TOOL) {
      const result = call.result as
        | { opened?: unknown; alreadyOpen?: unknown; closed?: unknown }
        | undefined;
      const args = call.args as { apps?: unknown; close?: unknown } | undefined;
      const closed = result ? strings(result.closed) : strings(args?.close);
      const opened = result
        ? [...strings(result.opened), ...strings(result.alreadyOpen)]
        : strings(args?.apps);
      for (const id of closed) {
        const app = findApp(apps, id);
        if (app) untouch(app.id);
      }
      for (const id of opened) {
        const app = findApp(apps, id);
        if (app) touch(app.id);
      }
      continue;
    }
    const owner = appOfTool.get(call.toolName);
    if (owner !== undefined) touch(owner);
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
  /** Explicit picks: app ids or exact tool names. Always active, never dropped. */
  readonly pins?: readonly string[];
  /** Tool calls already in this conversation, oldest first. */
  readonly priorToolCalls?: readonly PriorToolCall[];
  readonly budget?: number;
}

/**
 * Fit a turn's tools to the per-request budget.
 *
 * Throws {@link ToolLimitExceededError} only when the turn cannot be served
 * without dropping something the caller or the person explicitly asked for:
 * core tools (including the client's own) or explicit picks that alone exceed
 * the budget.
 */
export function budgetTools(input: BudgetToolsInput): BudgetedToolSet {
  const {
    tools,
    sources,
    pins = [],
    priorToolCalls = [],
    budget = MAX_TOOLS_PER_INFERENCE_REQUEST,
  } = input;
  const allNames = Object.keys(tools);

  if (allNames.length <= budget) {
    return { tools, routing: {}, appCatalogPrompt: '', activeToolNames: () => allNames };
  }

  const apps = appsOf(tools, sources);
  const appNames = new Set(apps.flatMap((app) => app.names));
  const core = allNames.filter((name) => !appNames.has(name));

  if (Object.hasOwn(tools, USE_APPS_TOOL)) {
    throw new ToolLimitExceededError({
      toolCount: allNames.length,
      message: `"${USE_APPS_TOOL}" is a reserved tool name when a turn carries more than ${budget} tools.`,
    });
  }
  if (core.length + 1 > budget) {
    throw new ToolLimitExceededError({
      toolCount: core.length,
      limit: budget - 1,
      message:
        `This turn has ${core.length} tools that must always be sent (including any the client supplied); ` +
        `at most ${budget - 1} fit in one request beside the app router.`,
    });
  }

  const open: string[] = [];
  const pinnedApps = new Set<string>();
  const pinnedTools = new Set<string>();
  const byId = new Map(apps.map((app) => [app.id, app]));

  const activeToolNames = (): string[] => {
    const active = new Set<string>([...core, USE_APPS_TOOL]);
    for (const id of open) for (const name of byId.get(id)?.names ?? []) active.add(name);
    for (const name of pinnedTools) active.add(name);
    return [...active];
  };
  const fits = (extra: readonly string[]): boolean =>
    new Set([...activeToolNames(), ...extra]).size <= budget;

  // 1. The person's picks, in the order given. Never dropped.
  const unfit: string[] = [];
  for (const pin of pins) {
    const app = findApp(apps, pin);
    if (app) {
      if (open.includes(app.id)) continue;
      if (fits(app.names)) {
        open.push(app.id);
        pinnedApps.add(app.id);
      } else unfit.push(`${pin} (${app.names.length} tools)`);
      continue;
    }
    if (appNames.has(pin)) {
      if (fits([pin])) pinnedTools.add(pin);
      else unfit.push(pin);
    }
    // A pick naming a core tool is already active; one naming nothing this
    // turn can reach (a connector that is down) has nothing to activate.
  }
  if (unfit.length > 0) {
    throw new ToolLimitExceededError({
      toolCount: new Set([...activeToolNames()]).size,
      message:
        `The selected ${unfit.length === 1 ? 'app does' : 'apps do'} not fit in one request of at most ${budget} tools: ` +
        `${unfit.join(', ')}. Select fewer apps or tools for this message.`,
    });
  }

  // 2. What the conversation already had open, most recent first, while it fits.
  const sticky = stickyAppsFrom(apps, priorToolCalls);
  for (const id of sticky) {
    const app = byId.get(id);
    if (app && !open.includes(id) && fits(app.names)) open.push(id);
  }

  const useApps = createUseAppsTool({ apps, open, pinnedApps, fits, activeToolNames, budget });
  const registered: ToolSet = { ...tools, [USE_APPS_TOOL]: useApps };

  log.tools.info(
    {
      assembled: allNames.length,
      core: core.length,
      apps: apps.map((app) => `${app.id}:${app.names.length}`),
      open,
      pinnedTools: [...pinnedTools],
      active: activeToolNames().length,
      budget,
    },
    'Tool budget applied: connected apps are opened on demand with useApps',
  );

  return {
    tools: registered,
    routing: {
      activeTools: activeToolNames(),
      // Called before EVERY step, the first included, so an app opened by a
      // `useApps` call in step N is in the request from step N+1.
      prepareStep: () => ({ activeTools: activeToolNames() }),
    },
    appCatalogPrompt: appCatalogPrompt(apps, open, budget),
    activeToolNames,
  };
}

/* -------------------------------------------------------------------------- */
/*  useApps                                                                   */
/* -------------------------------------------------------------------------- */

function catalogLine(app: ToolApp, open: readonly string[]): string {
  const covers = app.covers.length ? `: ${app.covers.join(', ')}` : '';
  return `- ${app.id} — ${app.label} (${app.names.length} tools)${covers}${open.includes(app.id) ? ' [open]' : ''}`;
}

function createUseAppsTool(state: {
  apps: readonly ToolApp[];
  open: string[];
  pinnedApps: ReadonlySet<string>;
  fits: (extra: readonly string[]) => boolean;
  activeToolNames: () => string[];
  budget: number;
}): Tool {
  const { apps, open, pinnedApps, fits, activeToolNames, budget } = state;
  return declareReadOnly(
    tool({
      description:
        "Open the person's connected apps to reach their data and act in them — whatever each app covers. " +
        "An app's tools are available from your next step. Call this BEFORE saying you " +
        'cannot access something an app covers. Close apps you no longer need to make room. ' +
        `Apps: ${apps.map((app) => `${app.id} (${app.label}${app.covers.length ? `: ${app.covers.join(', ')}` : ''})`).join('; ')}.`,
      inputSchema: z.object({
        apps: z.array(z.string()).describe('App ids to open, most important first.'),
        close: z.array(z.string()).optional().describe('App ids to close first, to make room.'),
      }),
      execute: async ({ apps: requested, close }) => {
        const closed: string[] = [];
        const keptOpen: string[] = [];
        for (const name of close ?? []) {
          const app = findApp(apps, name);
          if (!app || !open.includes(app.id)) continue;
          if (pinnedApps.has(app.id)) {
            keptOpen.push(app.id);
            continue;
          }
          open.splice(open.indexOf(app.id), 1);
          closed.push(app.id);
        }

        const opened: string[] = [];
        const alreadyOpen: string[] = [];
        const didNotFit: { app: string; tools: number }[] = [];
        const unknown: string[] = [];
        for (const name of requested) {
          const app = findApp(apps, name);
          if (!app) unknown.push(name);
          else if (open.includes(app.id)) alreadyOpen.push(app.id);
          else if (fits(app.names)) {
            open.push(app.id);
            opened.push(app.id);
          } else didNotFit.push({ app: app.id, tools: app.names.length });
        }

        const active = activeToolNames().length;
        return {
          opened,
          alreadyOpen,
          ...(closed.length ? { closed } : {}),
          ...(keptOpen.length
            ? { keptOpen, keptOpenReason: 'selected by the person for this message' }
            : {}),
          ...(unknown.length ? { unknown, available: apps.map((app) => app.id) } : {}),
          ...(didNotFit.length
            ? {
                didNotFit,
                hint:
                  `At most ${budget} tools can be active (now ${active}). ` +
                  `Close apps you no longer need with useApps({ apps: [...], close: [...] }).`,
              }
            : {}),
          openApps: [...open],
          activeTools: active,
          note: opened.length
            ? "The opened apps' tools are available from your next step."
            : undefined,
        };
      },
    }),
  );
}

/**
 * The Apps section of the system prompt.
 *
 * Written for the weakest model that may read it. A model shown only its tool
 * list concludes that what is not in it does not exist, and answers "I don't
 * have access to your email" while the person's mailbox is one `useApps` call
 * away. So the section says, before anything else, that the access is REAL,
 * what each app covers, and that opening the app comes before any refusal.
 * The person may ask in any language and by any name — the model matches by
 * meaning, which is why the catalog carries subjects rather than keywords.
 */
function appCatalogPrompt(
  apps: readonly ToolApp[],
  open: readonly string[],
  budget: number,
): string {
  return (
    '\n\n## Apps\n' +
    'The person has connected the apps below, and through them you DO have access to their data and can act for ' +
    'them in everything each app covers. Only a few apps are open ' +
    `at a time, so an app's tools may not be in your tool list yet: open it with \`${USE_APPS_TOOL}\` and, from your ` +
    'next step, call its tools directly.\n' +
    '- When a request touches anything an app covers — in any language, by any name, synonym or brand ' +
    '(e.g. "mail", "correo", "courriel" and a mail brand all mean email) — call ' +
    `\`${USE_APPS_TOOL}\` with that app first, then answer from what its tools return.\n` +
    '- Never say you cannot access, see or do something an app below covers until you have opened that app and ' +
    'its tools failed. Do not ask the person for permission to open an app; they connected it to be used.\n' +
    `- Open only what the request needs: at most ${budget} tools can be active at once.\n` +
    'Apps (id — name (tools): what it covers):\n' +
    apps.map((app) => catalogLine(app, open)).join('\n')
  );
}
