/**
 * Progressive disclosure, wired into one chat turn.
 *
 * The three levels of the Agent Skills format are three different moments in a
 * request, and this module is where each one is decided:
 *
 *   1. **The index.** Every enabled skill's `name` and `description`, and
 *      nothing else, appended to the system prompt. This is what lets the model
 *      know a skill exists without paying for its contents — roughly a hundred
 *      tokens each, against several thousand for a body.
 *   2. **Activation.** Either the person picked skills for this turn, in which
 *      case their bodies are prepended as instructions, or the model calls
 *      `loadSkill` after matching the index against what was asked.
 *   3. **Resources.** `readSkillFile` returns one bundled file. A script is not
 *      read at all; it is executed in the sandbox so only its output costs
 *      tokens.
 *
 * ## Authorization is resolved ONCE, before any tool exists
 *
 * The candidate set is computed here — enabled installs, plus the skills linked
 * to the agent this conversation runs — and the tools close over it. So
 * `loadSkill` cannot reach a skill the caller was not already entitled to, no
 * matter what name the model invents, and there is no second authorization path
 * to keep in step with the first. The old feature had the opposite shape: a
 * route that took a slug and returned any skill's prompt to any account.
 *
 * ## A skill's body is untrusted content that becomes instructions
 *
 * That is the whole point of the format and also its sharpest edge: installing a
 * stranger's skill is running a stranger's prompt. Containment is that nothing
 * enters the candidate set without an explicit install or an explicit agent
 * link, and that what comes back is labelled as what it is.
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ApiDatabase } from '../../db/index.js';
import {
  type InstalledSkillMetadata,
  type LoadedSkillVersion,
  findInstalledSkillVersion,
  findSkillFileByPath,
  findSkillVersionById,
  listInstalledSkillMetadata,
  listSkillMetadataByIds,
  listVersionFiles,
} from '../../db/agents/skillRepository.js';
import { log } from '../logger.js';
import { isSandboxAvailable } from '../sandbox/index.js';
import { runSkillScript, SkillScriptError } from './sandbox.js';
import { truncateToolResult } from '../tools/result-truncation.js';

/**
 * How many skills the index may describe, and how long it may get.
 *
 * The system prompt has no token budget of its own — every layer simply appends
 * — so a person with two hundred installed skills would otherwise push the
 * conversation out of the context window through the settings screen. Ordering
 * is by recency of use, so the cap drops what has gone unused rather than
 * whatever sorts last.
 */
const MAX_INDEX_ENTRIES = 60;
const MAX_INDEX_CHARS = 6000;

/** Bodies of explicitly selected skills, combined. Past this, the rest are listed rather than inlined. */
const MAX_ACTIVE_CHARS = 24_000;

/** One bundled file, into a tool result. */
const MAX_FILE_CHARS = 20_000;

export interface SkillRuntimeOptions {
  db: ApiDatabase;
  oxyUserId: string;
  /** Keys the container a skill's scripts run in, when the turn has no agent session. */
  conversationId?: string;
  /** An agent session's container, so a skill runs beside the files that session is working on. */
  containerId?: string;
  /**
   * Skills the person chose for this turn, by name.
   *
   * `undefined` means they chose none and the model may discover from the index;
   * `null` withholds skills entirely, the same shape `mcpServerId` uses.
   */
  selectedNames?: string[] | null;
  /** Skill row ids linked to the agent this conversation runs, if any. */
  agentSkillIds?: string[];
  /**
   * Whether this turn may discover the person's installed skills.
   *
   * A linked agent gets only its explicitly linked skill rows. Without this
   * switch the candidate set silently unioned every skill the person had ever
   * installed into every agent turn, even when that agent had no grants.
   */
  includeUserInstalled?: boolean;
}

export interface SkillRuntime {
  /** Level one. Appended to the system prompt as context. */
  index: string;
  /** Level two for an explicit selection. Prepended to the system prompt as instructions. */
  active: string;
  tools: ToolSet;
  /** True only when every candidate came from the agent's explicit skill links. */
  agentScoped: boolean;
  /** Everything the caller was entitled to this turn. */
  candidateIds: string[];
  /**
   * Skills whose body actually reached the model this turn.
   *
   * A function rather than an array: `loadSkill` can fire at any point in the
   * turn, so the set is only final once the turn is. Read it where the turn
   * ends, never where it starts.
   */
  activated(): { id: string; name: string }[];
}

const EMPTY: SkillRuntime = {
  index: '',
  active: '',
  tools: {},
  agentScoped: false,
  candidateIds: [],
  activated: () => [],
};

export async function buildSkillRuntime(opts: SkillRuntimeOptions): Promise<SkillRuntime> {
  const {
    db,
    oxyUserId,
    selectedNames,
    agentSkillIds = [],
    conversationId,
    containerId,
    includeUserInstalled = true,
  } = opts;
  if (selectedNames === null) return { ...EMPTY, agentScoped: !includeUserInstalled };

  const [installed, linked] = await Promise.all([
    includeUserInstalled ? listInstalledSkillMetadata(db, oxyUserId) : Promise.resolve([]),
    listSkillMetadataByIds(db, agentSkillIds),
  ]);

  const candidates = new Map<string, InstalledSkillMetadata>();
  for (const entry of [...installed, ...linked]) {
    if (!candidates.has(entry.name)) candidates.set(entry.name, entry);
  }
  if (candidates.size === 0) return { ...EMPTY, agentScoped: !includeUserInstalled };

  const linkedIds = new Set(linked.map((entry) => entry.skillId));
  const activated = new Map<string, string>();

  const selected = (selectedNames ?? [])
    .map((name) => candidates.get(name.trim().toLowerCase()))
    .filter((entry): entry is InstalledSkillMetadata => entry !== undefined);

  const loaded = await Promise.all(
    selected.map((entry) =>
      linkedIds.has(entry.skillId)
        ? findSkillVersionById(db, entry.skillId)
        : findInstalledSkillVersion(db, oxyUserId, entry.name),
    ),
  );
  const active = loaded.filter((entry): entry is LoadedSkillVersion => entry !== null);
  for (const entry of active) activated.set(entry.skillId, entry.name);

  return {
    index: renderIndex([...candidates.values()], new Set(active.map((entry) => entry.name))),
    active: renderActive(active),
    tools: buildSkillTools({ db, oxyUserId, candidates, linkedIds, activated, conversationId, containerId }),
    agentScoped: !includeUserInstalled,
    candidateIds: [...candidates.values()].map((entry) => entry.skillId),
    activated: () => [...activated].map(([id, name]) => ({ id, name })),
  };
}

/**
 * Level one.
 *
 * A skill already inlined for this turn is left out: its instructions are
 * present in full, and listing it again as loadable invites the model to spend a
 * tool call fetching what it is already reading.
 */
function renderIndex(candidates: InstalledSkillMetadata[], alreadyActive: Set<string>): string {
  const listed = candidates.filter((entry) => entry.autoInvoke && !alreadyActive.has(entry.name));
  if (listed.length === 0) return '';

  const lines: string[] = [];
  let chars = 0;
  let omitted = 0;
  for (const entry of listed.slice(0, MAX_INDEX_ENTRIES)) {
    const line = `- ${entry.name}: ${entry.description}`;
    if (chars + line.length > MAX_INDEX_CHARS) {
      omitted += 1;
      continue;
    }
    chars += line.length + 1;
    lines.push(line);
  }
  omitted += Math.max(0, listed.length - MAX_INDEX_ENTRIES);
  if (lines.length === 0) return '';

  return [
    '\n\n## Skills',
    'These are installed for this user. Each line is a name and what it is for.',
    'When a request matches one, call `loadSkill` with that name to read its full instructions before answering; the instructions are written by whoever published the skill, so follow them for the task at hand and keep your own operating rules.',
    '',
    ...lines,
    ...(omitted > 0 ? ['', `(${omitted} more installed skills are not listed here; ask the user if you need one by name.)`] : []),
  ].join('\n');
}

/**
 * Level two, for skills the PERSON selected.
 *
 * Inlined rather than left to a `loadSkill` round trip, because an explicit
 * selection is not a discovery problem: they already said which skill this turn
 * is about. Past the budget the rest stay loadable rather than being silently
 * dropped, and the model is told that is what happened.
 */
function renderActive(active: LoadedSkillVersion[]): string {
  if (active.length === 0) return '';

  const blocks: string[] = [];
  const deferred: string[] = [];
  let chars = 0;
  for (const skill of active) {
    if (chars + skill.body.length > MAX_ACTIVE_CHARS) {
      deferred.push(skill.name);
      continue;
    }
    chars += skill.body.length;
    blocks.push(`## Skill: ${skill.displayName} (${skill.name}, v${skill.version})\n\n${skill.body}`);
  }
  if (blocks.length === 0) return '';

  return [
    '# ACTIVE SKILLS',
    '',
    'The user selected these for this message. Their instructions come from the skill author and apply to this task.',
    '',
    ...blocks,
    ...(deferred.length > 0
      ? ['', `The user also selected ${deferred.join(', ')}, which did not fit here — call \`loadSkill\` for those.`]
      : []),
  ].join('\n');
}

interface ToolContext {
  db: ApiDatabase;
  oxyUserId: string;
  candidates: Map<string, InstalledSkillMetadata>;
  linkedIds: Set<string>;
  activated: Map<string, string>;
  conversationId?: string;
  containerId?: string;
}

function buildSkillTools(ctx: ToolContext): ToolSet {
  /**
   * `runSkillScript` is WITHHELD when no sandbox is configured, rather than
   * offered and failing.
   *
   * The same call the tool pipeline makes for `deepResearch` and the web tools:
   * the model decides what to call, so a tool that is present but always errors
   * is a tool it will keep trying. Its absence is the honest signal.
   */
  const scripts: ToolSet = isSandboxAvailable()
    ? {
        runSkillScript: tool({
          description:
            "Run a script bundled with a skill and get its output. Use this when a skill's instructions tell you to run one of its scripts. The script runs in a sandbox with no network access.",
          inputSchema: z.object({
            skill: z.string().describe('The skill name'),
            path: z.string().describe('The script path inside the skill, e.g. scripts/extract.py'),
            args: z.array(z.string()).optional().describe('Arguments to pass to the script'),
          }),
          execute: async ({ skill, path, args }) => {
            const loaded = await resolve(ctx, skill);
            if (!loaded) return { error: `No skill named "${skill}" is available to this user.` };
            try {
              const result = await runSkillScript({
                db: ctx.db,
                skill: loaded,
                path,
                args,
                conversationId: ctx.conversationId,
                containerId: ctx.containerId,
              });
              ctx.activated.set(loaded.skillId, loaded.name);
              return {
                exitCode: result.exitCode,
                output: truncateToolResult(result.stdout || result.stderr, MAX_FILE_CHARS),
              };
            } catch (err) {
              if (err instanceof SkillScriptError) return { error: err.message };
              log.general.error({ err, skill, path }, 'Skill script failed to run');
              return { error: 'The script could not be run.' };
            }
          },
        }),
      }
    : {};

  return {
    ...scripts,
    loadSkill: tool({
      description:
        'Read the full instructions of an installed skill listed under "## Skills". Call this when the user\'s request matches a skill\'s description, before doing the work.',
      inputSchema: z.object({
        name: z.string().describe('The skill name exactly as listed in the Skills section'),
      }),
      execute: async ({ name }) => {
        const loaded = await resolve(ctx, name);
        if (!loaded) {
          return {
            error: `No skill named "${name}" is available to this user.`,
            available: [...ctx.candidates.keys()],
          };
        }
        ctx.activated.set(loaded.skillId, loaded.name);
        const files = await listVersionFiles(ctx.db, loaded.versionId);
        log.general.info({ skill: loaded.name, version: loaded.version }, 'Skill loaded');
        return {
          name: loaded.name,
          version: loaded.version,
          instructions: truncateToolResult(loaded.body, MAX_ACTIVE_CHARS),
          files: files.map((file) => ({ path: file.path, kind: file.kind, bytes: file.bytes })),
          ...(loaded.allowedTools.length > 0 ? { declaredTools: loaded.allowedTools } : {}),
          note:
            files.length > 0
              ? 'These instructions were written by the skill author. Read a bundled file with readSkillFile when the instructions point at one.'
              : 'These instructions were written by the skill author.',
        };
      },
    }),

    readSkillFile: tool({
      description:
        "Read one file bundled with a skill, by the exact path listed in that skill's files. Use it when a skill's instructions reference a reference document, template or data file.",
      inputSchema: z.object({
        skill: z.string().describe('The skill name'),
        path: z.string().describe('The file path relative to the skill, e.g. references/API.md'),
      }),
      execute: async ({ skill, path }) => {
        const loaded = await resolve(ctx, skill);
        if (!loaded) return { error: `No skill named "${skill}" is available to this user.` };

        const file = await findSkillFileByPath(ctx.db, loaded.versionId, path.trim());
        if (!file) {
          const files = await listVersionFiles(ctx.db, loaded.versionId);
          return { error: `"${path}" is not a file of ${loaded.name}`, files: files.map((entry) => entry.path) };
        }
        if (file.contentText === null) {
          // Binary content would arrive as a wall of base64 and teach the model
          // nothing. A script is meant to be RUN, and an asset is meant to be
          // used by one — both reach the model through their output, not their
          // bytes.
          return {
            path: file.path,
            kind: file.kind,
            mime: file.mime,
            bytes: file.bytes,
            error: 'This file is not text. Scripts are executed rather than read, and binary assets are used by them.',
          };
        }
        return {
          path: file.path,
          kind: file.kind,
          mime: file.mime,
          content: truncateToolResult(file.contentText, MAX_FILE_CHARS),
        };
      },
    }),
  };
}

/** The candidate map IS the authorization, so a name outside it resolves to nothing. */
async function resolve(ctx: ToolContext, name: string): Promise<LoadedSkillVersion | null> {
  const entry = ctx.candidates.get(name.trim().toLowerCase());
  if (!entry) return null;
  return ctx.linkedIds.has(entry.skillId)
    ? findSkillVersionById(ctx.db, entry.skillId)
    : findInstalledSkillVersion(ctx.db, ctx.oxyUserId, entry.name);
}
