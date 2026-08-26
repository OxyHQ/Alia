/**
 * Running a skill's bundled script.
 *
 * Level three of the format, and the only part of it that executes: a skill can
 * ship `scripts/fill_form.py` and have the model RUN it rather than write the
 * equivalent code, which is more reliable and costs the tokens of the output
 * instead of the tokens of the source.
 *
 * ## The container has no network
 *
 * A skill is somebody else's code, installed from a public repository. It runs
 * with `network: 'none'` — Docker gives the container no interface at all — so
 * a script cannot fetch, cannot exfiltrate what it reads, and cannot install
 * packages at runtime. That is the same environment Anthropic's own Skills API
 * gives a skill, for the same reason, and it is enforced by the container
 * runtime rather than by a rule this code is asked to remember.
 *
 * There are no credentials inside either. Nothing about the account, the
 * conversation or the request is written into the container beyond the skill's
 * own files and the arguments the model passed.
 *
 * ## The bundle is materialised once per container
 *
 * Writing a dozen files before every call would dominate the cost of running a
 * one-line script, so a marker file records which version is already on disk and
 * a second call skips the copy. The marker is read from the container rather
 * than remembered in this process: the same conversation can be served by a
 * different task, which would remember nothing.
 *
 * ## A container per conversation, reaped by the host
 *
 * Created on first use and cached for the conversation, because a skill's
 * workflow is usually several scripts in a row over the same files. The cache
 * is process-local — a turn is served by one process — and the host reaps a
 * non-persistent container on its own timeout, so nothing leaks when the cache
 * loses one.
 */

import type { ApiDatabase } from '../../db/index.js';
import { type LoadedSkillVersion, listVersionFiles } from '../../db/agents/skillRepository.js';
import { log } from '../logger.js';
import { readS3Object } from '../s3.js';
import { getSandboxProvider, isSandboxAvailable } from '../sandbox/index.js';

const ROOT = '/workspace/.alia/skills';
const MARKER = '.alia-version';
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 300;
/** How long an idle conversation keeps its container before this process forgets it. */
const CACHE_TTL_MS = 10 * 60 * 1000;

const INTERPRETERS: Record<string, string> = {
  py: 'python3',
  sh: 'bash',
  bash: 'bash',
  js: 'node',
  mjs: 'node',
};

interface CachedSandbox {
  id: string;
  expiresAt: number;
}

const sandboxes = new Map<string, CachedSandbox>();

export class SkillScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillScriptError';
  }
}

export interface RunSkillScriptOptions {
  db: ApiDatabase;
  skill: LoadedSkillVersion;
  /** The script's path inside the skill, exactly as `skill_files` stores it. */
  path: string;
  args?: string[];
  timeoutSeconds?: number;
  /**
   * An existing container to run in — an agent session's workspace.
   *
   * When present the script runs beside the agent's own files, which is the
   * point: a skill used by an agent operates on what that agent is working on.
   * Its network is the session's, not this module's, because the session
   * already made that choice.
   */
  containerId?: string;
  /** Keys a per-conversation container when there is no session to borrow. */
  conversationId?: string;
}

export interface SkillScriptResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export async function runSkillScript(opts: RunSkillScriptOptions): Promise<SkillScriptResult> {
  if (!isSandboxAvailable()) {
    throw new SkillScriptError('No sandbox is configured, so skill scripts cannot run here.');
  }

  const files = await listVersionFiles(opts.db, opts.skill.versionId);
  const script = files.find((file) => file.path === opts.path.trim());
  if (!script) {
    throw new SkillScriptError(`"${opts.path}" is not a file of ${opts.skill.name}`);
  }
  if (script.kind !== 'script') {
    throw new SkillScriptError(`"${opts.path}" is not a script; read it with readSkillFile instead.`);
  }

  const extension = script.path.includes('.') ? script.path.slice(script.path.lastIndexOf('.') + 1).toLowerCase() : '';
  // `Object.hasOwn` first: a file legitimately named `x.constructor` would
  // otherwise read `Object.prototype.constructor` out of this table, and a
  // truthy value is all the check below asks for. The path is a real file of a
  // real skill, so the name is somebody else's to choose.
  const interpreter = Object.hasOwn(INTERPRETERS, extension) ? INTERPRETERS[extension] : undefined;
  if (!interpreter) {
    throw new SkillScriptError(
      `Alia cannot run a ${extension || 'file'} script. Supported: ${[...new Set(Object.values(INTERPRETERS))].join(', ')}.`,
    );
  }

  const sandbox = getSandboxProvider();
  const containerId = opts.containerId ?? (await sandboxFor(opts.conversationId ?? 'anonymous'));
  const directory = `${ROOT}/${opts.skill.name}`;

  await materialise(containerId, directory, opts.skill, files);

  const timeout = Math.min(Math.max(opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 1), MAX_TIMEOUT_SECONDS);
  const args = (opts.args ?? []).map(shellQuote).join(' ');
  const command = `cd ${shellQuote(directory)} && ${interpreter} ${shellQuote(script.path)}${args ? ` ${args}` : ''} 2>&1`;

  const result = await sandbox.exec(containerId, command, timeout);
  log.general.info(
    { skill: opts.skill.name, script: script.path, exitCode: result.exitCode },
    'Skill script executed',
  );
  return result;
}

/** Forget (and destroy) a conversation's container — used by tests and by shutdown. */
export async function releaseSkillSandbox(conversationId: string): Promise<void> {
  const cached = sandboxes.get(conversationId);
  if (!cached) return;
  sandboxes.delete(conversationId);
  await getSandboxProvider()
    .destroy(cached.id)
    .catch((err) => log.general.warn({ err }, 'Failed to destroy a skill sandbox'));
}

async function sandboxFor(conversationId: string): Promise<string> {
  const now = Date.now();
  const cached = sandboxes.get(conversationId);
  if (cached && cached.expiresAt > now) {
    cached.expiresAt = now + CACHE_TTL_MS;
    return cached.id;
  }
  if (cached) await releaseSkillSandbox(conversationId);

  const created = await getSandboxProvider().createSandbox({
    size: 'small',
    persistent: false,
    network: 'none',
    labels: { 'alia.purpose': 'skill-script' },
  });
  sandboxes.set(conversationId, { id: created.id, expiresAt: now + CACHE_TTL_MS });
  return created.id;
}

/**
 * Copy the bundle into the container, unless the marker says this exact version
 * is already there.
 */
async function materialise(
  containerId: string,
  directory: string,
  skill: LoadedSkillVersion,
  files: Awaited<ReturnType<typeof listVersionFiles>>,
): Promise<void> {
  const sandbox = getSandboxProvider();
  const marker = `${directory}/${MARKER}`;
  const present = await sandbox.readFile(containerId, marker).catch(() => null);
  if (present?.trim() === skill.versionId) return;

  // `SKILL.md` travels too: a script may read its own skill's instructions, and
  // a bundle missing the one file the format guarantees is a confusing thing to
  // hand somebody's code.
  await sandbox.writeFile(containerId, `${directory}/SKILL.md`, skill.body);

  for (const file of files) {
    const target = `${directory}/${file.path}`;
    if (file.contentText !== null) {
      await sandbox.writeFile(containerId, target, file.contentText);
      continue;
    }
    // Binary content: the write path takes text, so the bytes travel base64 and
    // are decoded in the container. One extra exec per binary asset, and only
    // the first time a version is materialised.
    const object = await readS3Object(file.s3Key!);
    if (!object) throw new SkillScriptError(`${file.path} is missing from storage`);
    const bytes = await streamToBuffer(object.body);
    await sandbox.writeFile(containerId, `${target}.b64`, bytes.toString('base64'));
    await sandbox.exec(
      containerId,
      `base64 -d ${shellQuote(`${target}.b64`)} > ${shellQuote(target)} && rm ${shellQuote(`${target}.b64`)}`,
      30,
    );
  }

  await sandbox.exec(containerId, `chmod -R u+rx ${shellQuote(directory)}`, 30);
  await sandbox.writeFile(containerId, marker, skill.versionId);
  log.general.info({ skill: skill.name, version: skill.version, files: files.length }, 'Skill bundle materialised');
}

/** `readS3Object` answers a stream; the base64 hop needs the whole object. */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Single-quote for `sh`.
 *
 * Every argument reaching the command line comes from the model, so the closing
 * quote is the only thing between an argument and a second command. `'` is
 * escaped the one way POSIX allows: end the quote, an escaped quote, reopen.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
