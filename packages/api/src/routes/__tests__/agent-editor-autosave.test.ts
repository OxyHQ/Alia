/**
 * The agent editor's autosave reaches `PATCH /agents/:id` and PERSISTS.
 *
 * ## The bug this is written from
 *
 * It did not. Every autosave the screen sent was a **400**, on every keystroke,
 * for as long as the screen has existed — so the prompt, the tagline, the
 * description, the skills, the knowledge and the capabilities were all
 * decorative. The whole editor was.
 *
 * The cause was two lists free to disagree: the editor put `permissions` in the
 * body and `updateAgentSchema` — `.strict()` — did not name it, so zod raised
 * `unrecognized_keys` and the handler answered `400 Invalid input`. Nothing
 * surfaced it, because the failure was swallowed twice on the way back: the
 * store logged and the screen had a literal `} catch { // silent }`, with the
 * spinner cleared in `finally`, so the UI said "saved".
 *
 * ## Why this file censuses SOURCE and also drives the route
 *
 * A test that only fed a hand-written body to the schema would have passed on
 * the broken code, because the hand-written body is written by whoever writes
 * the test and they write the one the schema accepts. The body has to come from
 * the EDITOR, read out of its own source, or the two lists are still free to
 * drift the moment somebody adds a field to the screen.
 *
 * And a test that only checked the schema would have missed the other half:
 * that a body the schema accepts survives the route and lands in the
 * repository. So the keys are extracted from the screen and then sent through a
 * real express server.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_FAMILIES,
  FIXED_FAMILY_TOOLS,
  UNGRANTED_TOOLS,
  type FixedCapabilityFamily,
} from '../../domain/capability-grants.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const EDITOR = 'packages/app/app/(app)/agents/edit/[id].tsx';
const FAMILIES = 'packages/app/lib/constants/capability-families.ts';

const state = vi.hoisted(() => ({ userId: 'oxy-caller', accessToken: 'token-abc' as string | undefined }));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    const typed = req as Request & { user?: { id: string }; accessToken?: string };
    typed.user = { id: state.userId };
    typed.accessToken = state.accessToken;
    next();
  },
  optionalAuth: (req: Request, _res: Response, next: NextFunction) => next(),
  oxyClient: { getUsersByIds: async () => [], getFileDownloadUrl: (id: string) => id },
}));

/**
 * The act-as verdict is stubbed here, unlike in `agents-identity.test.ts`.
 *
 * That file is about the verdict and runs the real one. This file is about the
 * BODY, and a real verdict would only add an Oxy double between the request and
 * the assertion.
 */
vi.mock('../../lib/agent-account.js', () => ({
  loadAgentForActor: vi.fn(async () => ({ ok: true, agent: AGENT_ROW })),
  verifyAgentAccount: vi.fn(async () => ({ permitted: true })),
  refusalMessage: () => 'refused',
  refusalStatus: () => 403,
}));

const repository = vi.hoisted(() => ({
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  findAgentById: vi.fn(),
  findAgentSkills: vi.fn(async () => []),
  findAgentKnowledge: vi.fn(async () => []),
  listAgentCatalogue: vi.fn(async () => ({ agents: [], total: 0 })),
  listAgentsByAuthor: vi.fn(async () => []),
}));
vi.mock('../../db/agents/agentRepository.js', () => repository);
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../lib/agent/health.js', () => ({ getAgentCapabilities: async () => ({}) }));
vi.mock('../../lib/agent-identity.js', () => ({
  attachAgentIdentity: async (agent: unknown) => agent,
  attachAgentIdentities: async (agents: unknown) => agents,
}));
vi.mock('../../lib/logger.js', () => ({
  log: {
    agents: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));
vi.mock('../../lib/trigger-engine.js', () => ({ reloadTrigger: vi.fn(), generateWebhookToken: () => 'tok' }));
vi.mock('../../db/automation/triggerRepository.js', () => ({
  createTrigger: vi.fn(),
  findAgentTriggerByType: vi.fn(async () => null),
  updateTrigger: vi.fn(),
}));

const AGENT_ROW = {
  _id: 'agent-1',
  id: 'agent-1',
  oxyAccountId: 'acct-bot',
  tagline: 'finds things out',
  description: 'a description',
  author: 'oxy-caller',
  category: 'research',
  tags: [],
  rating: 0,
  reviewCount: 0,
  usageCount: 0,
  hireCount: 0,
  price: null,
  capabilityGrants: [],
  isFeatured: false,
  isTrending: false,
  isPublished: true,
  status: 'active',
  access: 'private',
  handlesAutonomousEvents: false,
  systemPrompt: null,
  preferredImage: null,
  allowedModels: ['alia-v1'],
  scheduleInterval: null,
  archetype: 'general',
  archetypeConfig: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const { default: crudRouter } = await import('../agents/crud.js');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app: Express = express();
  app.use(express.json());
  app.use('/agents', crudRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.updateAgent.mockResolvedValue(AGENT_ROW);
  repository.findAgentById.mockResolvedValue(AGENT_ROW);
});

/**
 * The property names of every object literal the editor hands to a save call.
 *
 * Parsed with the TypeScript compiler rather than matched with a regex: the
 * autosave payload is a multi-line object of shorthand properties inside a
 * `useEffect`, and a regex over it would find the state variables one edit away
 * from finding the wrong ones. `ts.forEachChild` walks the real tree.
 */
function editorSaveKeys(): string[] {
  const file = path.join(REPO_ROOT, EDITOR);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const keys = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      // `debouncedSave({…})` is the autosave; `updateAgent(id, {…})` is the
      // publish toggle, which sends its own body through the same route.
      const literal =
        node.expression.text === 'debouncedSave'
          ? node.arguments[0]
          : node.expression.text === 'updateAgent'
            ? node.arguments[1]
            : undefined;
      if (literal !== undefined && ts.isObjectLiteralExpression(literal)) {
        for (const property of literal.properties) {
          const name = property.name;
          if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
            keys.add(name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...keys].sort();
}

/** Every `catch` in the source whose block does nothing at all. */
function emptyCatchCount(source: string): number {
  const file = ts.createSourceFile('probe.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && node.block.statements.length === 0) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

/** A value the schema will accept for each key the editor can send. */
const VALUE_FOR: Readonly<Record<string, unknown>> = {
  tagline: 'a tagline',
  description: 'a description',
  systemPrompt: 'you are helpful',
  category: 'research',
  tags: ['one'],
  capabilityGrants: ['web', 'mcp:conn-1'],
  skills: ['skill-1'],
  knowledge: ['file-1'],
  price: 12,
  access: 'public',
  handlesAutonomousEvents: false,
  archetype: 'general',
  archetypeConfig: { citeSources: true },
  isPublished: false,
  status: 'active',
  allowedModels: ['alia-v1'],
  scheduleInterval: 60,
};

async function patch(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/agents/agent-1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('the editor and the route agree on what a save contains', () => {
  it('reads a real payload out of the screen, so an empty parse cannot pass', () => {
    const keys = editorSaveKeys();
    // The vacuity floor. A renamed save function, a moved file or a parser that
    // stopped matching all produce an empty list, which would satisfy every
    // assertion below by iterating zero times.
    expect(keys.length).toBeGreaterThanOrEqual(10);
    expect(keys).toContain('tagline');
    expect(keys).toContain('systemPrompt');
  });

  it('has a fixture value for every key the editor sends', () => {
    // Without this, a key the editor added and the fixture did not know about
    // would be sent as `undefined`, dropped by `JSON.stringify`, and the route
    // test below would pass while never exercising the new field at all.
    const unmapped = editorSaveKeys().filter((key) => VALUE_FOR[key] === undefined);
    expect(
      unmapped,
      `${unmapped.join(', ')} is sent by the agent editor and has no fixture here. ` +
        'Add one, and make sure `updateAgentSchema` names the field.',
    ).toEqual([]);
  });

  /**
   * THE ONE. The editor's real body, through the real route, to a 200.
   *
   * This is what was red: `permissions` in the payload against a `.strict()`
   * schema that did not name it, on every autosave, silently.
   */
  it('answers 200 to the exact body the editor sends, and persists every field', async () => {
    const keys = editorSaveKeys();
    /**
     * Every key gets a VALUE, including one the fixture does not know.
     *
     * `undefined` would be dropped by `JSON.stringify` on the way out, so a key
     * the editor sends and the schema refuses would never reach the route — and
     * this test would answer 200 over a body missing the very field that breaks
     * it. The sentinel is what makes the 400 reproducible here.
     */
    const body = Object.fromEntries(keys.map((key) => [key, VALUE_FOR[key] ?? 'unmapped']));

    const res = await patch(body);

    expect(res.status, `PATCH refused the editor's own body: ${JSON.stringify(res.body)}`).toBe(200);
    expect(repository.updateAgent).toHaveBeenCalledTimes(1);

    /**
     * Reached the repository, not merely survived the schema. The route renames
     * two of them on the way through — `skills` and `knowledge` become
     * `skillIds` and `libraryFileIds` — so the check is that nothing was
     * DROPPED rather than that the names match.
     */
    const written = repository.updateAgent.mock.calls[0][2] as Record<string, unknown>;
    const renamed: Readonly<Record<string, string>> = { skills: 'skillIds', knowledge: 'libraryFileIds' };
    const missing = keys.filter((key) => !(renamed[key] ?? key in written) && !((renamed[key] ?? key) in written));
    expect(missing, `${missing.join(', ')} never reached the repository`).toEqual([]);
    expect(written.capabilityGrants).toEqual(['web', 'mcp:conn-1']);
  });

  it('still refuses a key the schema does not name, which is what made the bug', async () => {
    // The positive control for the 200 above: `.strict()` is still strict, so
    // the pass is the body being right rather than the schema being loose.
    const res = await patch({ tagline: 'fine', somethingNobodyDeclared: true });

    expect(res.status).toBe(400);
    expect(repository.updateAgent).not.toHaveBeenCalled();
  });

  it('refuses a capability grant outside the vocabulary rather than storing it', async () => {
    // Refused at the boundary, where somebody can still be told — the reader
    // that runs at request time drops what it cannot parse, and a grant that
    // was silently dropped is the failure mode this whole change is about.
    expect((await patch({ capabilityGrants: ['not-a-family'] })).status).toBe(400);
    // A bare instanced family is a blank cheque over rows, and is refused too.
    expect((await patch({ capabilityGrants: ['mcp'] })).status).toBe(400);
    expect(repository.updateAgent).not.toHaveBeenCalled();
  });
});

/**
 * The app's family list, read out of its own source.
 *
 * `packages/app` cannot import from `packages/api`, so the labels live on one
 * side and the vocabulary on the other — which is exactly the arrangement that
 * let `AGENT_TOOLS` and `PERMISSION_CONFIG` disagree for as long as they both
 * existed. This is the check that stops the new pair repeating it.
 */
function appRuntimeToolFamilies(): Record<string, string> {
  const file = path.join(REPO_ROOT, FAMILIES);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const map: Record<string, string> = {};

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'RUNTIME_TOOL_FAMILIES' &&
      node.initializer !== undefined
    ) {
      const literal = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isObjectLiteralExpression(literal)) {
        for (const property of literal.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
            ts.isStringLiteralLike(property.initializer)
          ) {
            map[property.name.text] = property.initializer.text;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return map;
}

function appFamilyIds(): string[] {
  const file = path.join(REPO_ROOT, FAMILIES);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ids: string[] = [];

  const visit = (node: ts.Node): void => {
    // Every `id: '…'` inside the exported array, and the instanced ids from the
    // label map beside it — the two shapes the file declares.
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'id' &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      ids.push(node.initializer.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'INSTANCED_FAMILY_LABELS' &&
      node.initializer !== undefined
    ) {
      const literal = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isObjectLiteralExpression(literal)) {
        for (const property of literal.properties) {
          // `mcp: 'Connectors'` and `'oxy_service': '…'` alike: a key written
          // bare is an `Identifier`, quoted it is a string literal, and a
          // parser that knew only one would report a family as missing on the
          // day somebody added the quotes.
          if (
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
          ) {
            ids.push(property.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(ids)].sort();
}

describe('the app and the API name the same capability families', () => {
  it('reads ids out of the app source, so an empty parse cannot pass', () => {
    const ids = appFamilyIds();
    expect(ids.length).toBeGreaterThanOrEqual(10);
    expect(ids).toContain('shell');
    expect(ids).toContain('mcp');
  });

  it('declares exactly the families the vocabulary declares', () => {
    /**
     * BOTH directions, and each has its own failure.
     *
     * A family the app names and the API does not is a switch whose grant is
     * refused on write. A family the API names and the app does not is a
     * capability nobody can ever turn on — which is how `oxy_service` would
     * quietly become unreachable the day somebody added it to one side only.
     */
    expect(appFamilyIds()).toEqual([...CAPABILITY_FAMILIES].sort());
  });

  /**
   * The app's tool-to-family map agrees with the ASSEMBLER's.
   *
   * `RUNTIME_TOOL_FAMILIES` exists so the activity panel takes a tool's icon
   * from the family that grants it, instead of choosing its own — which is how
   * `delegate` ended up as lucide's `Users` in the panel and the owner's
   * `robot_2` in the editor, the same label under two icons two screens apart.
   *
   * It is a SECOND declaration of something the API already knows, so it needs
   * this: put `file_edit` under `shell` on the app side and the panel would
   * draw a terminal for a file write, silently and forever.
   */
  it('maps each runtime tool to the family the assembler grants it from', () => {
    const app = appRuntimeToolFamilies();

    // The floor: a parse that found nothing would satisfy every comparison
    // below by iterating an empty object.
    expect(Object.keys(app).length).toBeGreaterThanOrEqual(4);

    // `Object.hasOwn` first: `family` is a string parsed out of another
    // package's source, so indexing the table with it directly would answer an
    // inherited `Object.prototype` member for `constructor` — and `?.includes`
    // is a guard against `undefined`, not against inheritance.
    const wrong = Object.entries(app)
      .filter(
        ([tool, family]) =>
          !Object.hasOwn(FIXED_FAMILY_TOOLS, family) ||
          !FIXED_FAMILY_TOOLS[family as FixedCapabilityFamily].includes(tool),
      )
      .map(([tool, family]) => `${tool} is mapped to ${family}`);
    expect(
      wrong,
      `${wrong.join(', ')} — the app puts a tool in a family the assembler does not. ` +
        'The icon a tool carries has to come from the family that actually grants it.',
    ).toEqual([]);
  });

  it('covers every session primitive except the ungranted one', () => {
    // `plan` is in `UNGRANTED_TOOLS`, so it has no family and no icon to
    // inherit. Every OTHER primitive must be mapped, or the panel silently
    // falls back to a generic glyph for it.
    const app = appRuntimeToolFamilies();
    const primitives = ['shell', 'browser', 'file_edit', 'delegate'];
    expect(primitives.filter((tool) => app[tool] === undefined)).toEqual([]);
    expect(app.plan).toBeUndefined();
    expect(UNGRANTED_TOOLS).toContain('plan');
  });
});

describe('the editor screen reports a failed save instead of swallowing it', () => {
  /**
   * The reason the 400 above survived for the editor's whole life.
   *
   * `} catch { // silent }` around the autosave and a `console.error`-only
   * catch in the store meant a refused write cleared the spinner and looked
   * exactly like a successful one. `catch {}` is banned outright by the
   * repository's own standards; this is the check that keeps it out of the one
   * file where it did the most damage.
   */
  it('has no empty catch in the agent editor', () => {
    /**
     * Asked of the syntax tree, not of the text.
     *
     * A regex over the source counted this file's own DOCBLOCK — which quotes
     * `} catch { // silent }` to explain what was removed — as a live defect.
     * A check that fires on prose about the bug is a check that cannot tell the
     * bug from its own commit message.
     */
    expect(emptyCatchCount(readFileSync(path.join(REPO_ROOT, EDITOR), 'utf8')), 
      'A save that fails must say so. An empty catch here is what turned every ' +
        'autosave 400 into a spinner that stopped and a screen that looked saved.',
    ).toBe(0);
  });

  it('can tell an empty catch from a handled one, and from prose about one', () => {
    // The positive control. Without it, "found none" and "the walk never ran"
    // print the same result — and the version this replaced reported a defect
    // that was only a comment.
    expect(emptyCatchCount('try { f(); } catch {}')).toBe(1);
    expect(emptyCatchCount('try { f(); } catch { /* nothing */ }')).toBe(1);
    expect(emptyCatchCount('try { f(); } catch (e) { report(e); }')).toBe(0);
    expect(emptyCatchCount('// the old code said: } catch { // silent }')).toBe(0);
  });

  it('finds the files it reads, so a moved screen cannot pass silently', () => {
    // Both, and TRACKED rather than merely present: a new file is invisible to
    // `git ls-files` until it is staged, so this also says the app half of the
    // change was actually committed.
    const tracked = execFileSync('git', ['ls-files', EDITOR, FAMILIES], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(tracked.trim().split('\n').sort()).toEqual([EDITOR, FAMILIES].sort());
  });
});
