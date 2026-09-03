/**
 * Skills: the catalogue, a person's shelf, and the four ways one gets in.
 *
 * A skill here is an Agent Skill (<https://agentskills.io/specification>) — a
 * directory with a `SKILL.md`, optionally bundling references, assets and
 * scripts. Four sources produce one, and all four funnel through the SAME
 * pipeline (`lib/skills/spec.ts` → `lib/skills/bundle.ts` → `lib/skills/store.ts`):
 * a repository on GitHub, a zip upload, the editor in the app, and the built-in
 * seed. That is deliberate — a rule enforced on one path and not another is a
 * skill that installs here and is refused there for reasons nobody can see.
 *
 * ## Who may read what
 *
 * The catalogue is public because it is a catalogue: a person deciding whether
 * to install somebody else's instructions has to be able to read them first,
 * which is also why a version's body is served rather than hidden. A PRIVATE
 * skill is its owner's alone. What is not public in either case is the ability
 * to make a skill act — that needs an install, and `lib/skills/runtime.ts`
 * resolves every activation against one.
 *
 * ## Ids and names
 *
 * A skill is addressed by `name` in the app and by row id in payloads that link
 * one to an agent, so the read routes accept either. Write routes take the id:
 * a name is unique only within an owner's namespace, and a write has to know
 * which row it is changing.
 */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { generateText } from 'ai';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
  deleteOwnedSkill,
  findLatestVersion,
  findSkillById,
  findSkillByName,
  findSkillFileByPath,
  findSkillInNamespace,
  installSkill,
  listInstalledSkills,
  listOwnedSkills,
  listSkillCatalogue,
  listSkillVersions,
  listVersionFiles,
  uninstallSkill,
  updateInstall,
  updateOwnedSkill,
  type PublicSkill,
} from '../db/agents/skillRepository.js';
import { SKILL_SOURCES, type SkillSource } from '../domain/skill.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { resolveModel, getAIModel, getDefaultRoutingProfile } from '../lib/chat-core.js';
import { readS3Object } from '../lib/s3.js';
import { log } from '../lib/logger.js';
import { MAX_BUNDLE_BYTES, buildSkillBundle, SkillBundleError } from '../lib/skills/bundle.js';
import { readZipArchive, SkillArchiveError } from '../lib/skills/archive.js';
import { SkillSpecError, parseSkillDocument, serializeSkillDocument } from '../lib/skills/spec.js';
import { importSkillsFromGitHub, sourceUrl, SkillImportError } from '../lib/skills/github.js';
import { storeSkillBundle } from '../lib/skills/store.js';

const router = Router();

/** Uploads are held in memory and never written to disk; see `lib/skills/archive.ts`. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BUNDLE_BYTES } });

/**
 * One route parameter, as a string.
 *
 * `@types/express` v5 types a parameter as `string | string[]` because a
 * repeated name is legal, and every route here takes each of its parameters
 * once. Narrowing at the read is honest about that; casting the whole
 * dictionary would also silence a genuinely repeated parameter somewhere else.
 */
function param(req: Request, name: string): string {
  const value = req.params[name as keyof typeof req.params] as string | string[] | undefined;
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** Every refusal these routes can make, in one shape the app can act on. */
function fail(res: Response, status: number, message: string, code: string): void {
  res.status(status).json({ error: { message, code } });
}

/** The three importer errors are the caller's fault, and their messages say why. */
function handleWriteError(res: Response, err: unknown, action: string): void {
  if (err instanceof SkillSpecError || err instanceof SkillBundleError || err instanceof SkillArchiveError) {
    fail(res, 400, err.message, 'invalid_skill');
    return;
  }
  if (err instanceof SkillImportError) {
    fail(res, 400, err.message, 'skill_import_failed');
    return;
  }
  log.skills.error({ err }, `Failed to ${action}`);
  fail(res, 500, `Failed to ${action}`, 'skill_error');
}

/**
 * A skill by row id or by name, in the namespace this caller can see.
 *
 * The order matters: an id is unambiguous, a name is only unique per owner, and
 * a caller's own skill wins over a public one with the same name.
 */
async function resolveVisibleSkill(idOrName: string, oxyUserId?: string): Promise<PublicSkill | null> {
  const byId = await findSkillById(getDb(), idOrName);
  if (byId && (byId.visibility === 'public' || (oxyUserId && byId.ownerOxyUserId === oxyUserId))) return byId;
  return findSkillByName(getDb(), idOrName, oxyUserId);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const catalogueQuery = z.object({
  query: z.string().trim().min(1).max(200).optional(),
  source: z.enum(SKILL_SOURCES as unknown as [SkillSource, ...SkillSource[]]).optional(),
  tag: z.string().trim().min(1).max(64).optional(),
  publisher: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

router.get('/', async (req: Request, res: Response) => {
  const parsed = catalogueQuery.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, 'Invalid catalogue filters', 'invalid_query');
  try {
    res.json({ skills: await listSkillCatalogue(getDb(), parsed.data) });
  } catch (err) {
    log.skills.error({ err }, 'Failed to list the skill catalogue');
    fail(res, 500, 'Failed to list skills', 'skill_error');
  }
});

/** The caller's shelf: what is installed, enabled, and which version each follows. */
router.get('/installed', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return fail(res, 401, 'Unauthorized', 'unauthorized');
  res.json({ skills: await listInstalledSkills(getDb(), req.user.id) });
});

/** What the caller has written or imported into their own namespace. */
router.get('/mine', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return fail(res, 401, 'Unauthorized', 'unauthorized');
  res.json({ skills: await listOwnedSkills(getDb(), req.user.id) });
});

// ---------------------------------------------------------------------------
// Writes: the four ways a skill gets in
// ---------------------------------------------------------------------------

const importBody = z.object({
  /** `owner/repo`, a github.com URL, or a tree URL into one skill directory. */
  source: z.string().trim().min(1).max(500),
  /** Import only this skill when the repository holds several. */
  name: z.string().trim().min(1).max(64).optional(),
});

/**
 * Import from a public GitHub repository.
 *
 * The repository is read at a resolved COMMIT, every `SKILL.md` under the named
 * path becomes a skill, and each one is stored in the caller's own namespace —
 * never in the shared catalogue, which only the built-in seed and the registry
 * sync write to.
 */
router.post('/import', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return fail(res, 401, 'Unauthorized', 'unauthorized');
  const parsed = importBody.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'A repository or URL is required', 'invalid_source');

  try {
    const imported = await importSkillsFromGitHub(parsed.data.source);
    const wanted = parsed.data.name
      ? imported.skills.filter((skill) => skill.bundle.document.frontmatter.name === parsed.data.name)
      : imported.skills;
    if (wanted.length === 0) {
      return fail(res, 404, `No skill named "${parsed.data.name}" in that repository`, 'skill_not_found');
    }

    const stored = [];
    for (const skill of wanted) {
      const result = await storeSkillBundle(getDb(), skill.bundle, {
        source: 'github',
        ownerOxyUserId: req.user.id,
        sourceRepo: `${imported.source.owner}/${imported.source.repo}`,
        sourcePath: skill.directory,
        sourceUrl: sourceUrl(imported.source, imported.commit, skill.directory),
        sourceCommit: imported.commit,
        publisher: imported.source.owner,
        createdByOxyUserId: req.user.id,
      });
      // An import is a decision to use the skill, so it lands on the shelf. The
      // catalogue sync does the opposite for the same reason: nobody asked for
      // those.
      await installSkill(getDb(), req.user.id, result.skill._id);
      stored.push(result);
    }

    res.status(201).json({
      commit: imported.commit,
      skills: stored.map((entry) => ({ ...entry.skill, version: entry.version?.version ?? null, unchanged: entry.unchanged })),
      rejected: imported.rejected,
      warnings: wanted.flatMap((skill) => skill.bundle.warnings),
    });
  } catch (err) {
    handleWriteError(res, err, 'import that repository');
  }
});

/**
 * Upload a skill, in the two shapes the ecosystem already produces.
 *
 * Anthropic's Skills API takes a multipart body that is either ONE zip or a set
 * of path-qualified files (`files[]=@skill/SKILL.md;filename=skill/SKILL.md`),
 * and `package_skill.py` from `anthropics/skills` produces the zip. Accepting
 * both here means a skill packaged for that API uploads to Alia unchanged,
 * which is most of what compatibility is worth.
 *
 * It is on THIS surface rather than at `/v1/skills` deliberately. ADR 0004
 * freezes `api.alia.onl/v1/*` as a bounded compatibility window that "gains no
 * new capability, no new route", and `routes/__tests__/v1-compatibility-surface.test.ts`
 * enforces it. A new product feature does not ship there.
 *
 * An archive may hold the skill at its root or inside one directory; both are
 * common, because one is what `zip -r skill.zip my-skill` produces and the other
 * is what zipping the contents produces.
 */
router.post('/upload', authenticateToken, upload.any(), async (req: Request, res: Response) => {
  if (!req.user?.id) return fail(res, 401, 'Unauthorized', 'unauthorized');
  const uploaded = Array.isArray(req.files) ? req.files : [];
  if (uploaded.length === 0) return fail(res, 400, 'A zip file, or the skill\'s files, are required', 'missing_file');

  try {
    const single = uploaded.length === 1 ? uploaded[0] : undefined;
    const isZip = single !== undefined && (single.mimetype.includes('zip') || single.originalname.endsWith('.zip'));

    // Path-qualified files carry the skill's directory in their own names, which
    // is what the Skills API's `filename=skill/SKILL.md` form means.
    const files = isZip
      ? readZipArchive(single.buffer)
      : uploaded.map((file) => ({ path: file.originalname, content: file.buffer }));

    const roots = files.filter((file) => file.path.endsWith('SKILL.md'));
    if (roots.length === 0) return fail(res, 400, 'The upload has no SKILL.md', 'invalid_skill');
    if (roots.length > 1) return fail(res, 400, 'The upload holds more than one skill', 'invalid_skill');

    const prefix = roots[0].path.slice(0, roots[0].path.length - 'SKILL.md'.length);
    const rebased = files
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => ({ ...file, path: file.path.slice(prefix.length) }));

    const bundle = buildSkillBundle(rebased, { authored: true });
    const result = await storeSkillBundle(getDb(), bundle, {
      source: 'upload',
      ownerOxyUserId: req.user.id,
      createdByOxyUserId: req.user.id,
    });
    await installSkill(getDb(), req.user.id, result.skill._id);
    res.status(201).json({ skill: result.skill, version: result.version, warnings: bundle.warnings });
  } catch (err) {
    handleWriteError(res, err, 'read that archive');
  }
});

const authoredBody = z
  .object({
    /** A complete `SKILL.md`, which the editor sends verbatim. */
    document: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(64).optional(),
    description: z.string().trim().min(1).max(1024).optional(),
    body: z.string().optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    license: z.string().trim().max(500).optional(),
    compatibility: z.string().trim().max(500).optional(),
    allowedTools: z.array(z.string().trim().min(1)).max(50).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
    icon: z.string().trim().max(16).optional(),
    color: z.string().trim().max(32).optional(),
  })
  .refine((value) => value.document !== undefined || (value.name !== undefined && value.description !== undefined), {
    message: 'Send either a SKILL.md document, or a name and a description',
  });

/**
 * Compose the `SKILL.md` a write is really about.
 *
 * The editor can send fields, and anything else can send a document. Fields are
 * turned into a document rather than validated separately, so there is exactly
 * one parser and a skill written here is portable to every other client that
 * reads the format.
 */
function documentFrom(input: z.infer<typeof authoredBody>): string {
  if (input.document !== undefined) return input.document;
  return serializeSkillDocument(
    {
      name: input.name!,
      description: input.description!,
      license: input.license ?? null,
      compatibility: input.compatibility ?? null,
      metadata: input.metadata ?? {},
      allowedTools: input.allowedTools ?? [],
    },
    input.body ?? '',
  );
}

/** Write a skill in Alia's own editor. */
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return fail(res, 401, 'Unauthorized', 'unauthorized');
  const parsed = authoredBody.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid skill', 'invalid_skill');

  try {
    const document = documentFrom(parsed.data);
    const bundle = buildSkillBundle([{ path: 'SKILL.md', content: Buffer.from(document) }], { authored: true });
    const existing = await findSkillInNamespace(getDb(), bundle.document.frontmatter.name, req.user.id);
    if (existing) {
      return fail(res, 409, `You already have a skill named "${existing.name}"`, 'skill_exists');
    }

    const result = await storeSkillBundle(getDb(), bundle, {
      source: 'authored',
      ownerOxyUserId: req.user.id,
      createdByOxyUserId: req.user.id,
      displayName: parsed.data.displayName,
      tags: parsed.data.tags,
      icon: parsed.data.icon,
      color: parsed.data.color,
    });
    await installSkill(getDb(), req.user.id, result.skill._id);
    res.status(201).json({ skill: result.skill, version: result.version, warnings: bundle.warnings });
  } catch (err) {
    handleWriteError(res, err, 'create that skill');
  }
});

/**
 * A draft `SKILL.md` written by the model, from a sentence about what it should do.
 *
 * It PERSISTS NOTHING. What comes back is a document for the person to read,
 * edit and then send to `POST /skills` — the same thing a skill written by hand
 * sends. The old version of this route returned thirteen invented fields that
 * were saved as-is, which is how a skill's "triggers" and "good at" lists came
 * to be text nothing ever read.
 */
router.post('/generate', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return fail(res, 401, 'Unauthorized', 'unauthorized');
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (prompt.length < 10) return fail(res, 400, 'A prompt of at least 10 characters is required', 'invalid_prompt');
  const language = typeof req.body?.language === 'string' ? req.body.language : 'en-US';

  const MAX_PROVIDER_RETRIES = 3;
  const skipProviders = new Set<string>();
  let text: string | null = null;

  for (let attempt = 0; attempt < MAX_PROVIDER_RETRIES; attempt++) {
    const resolved = await resolveModel(getDefaultRoutingProfile(), skipProviders);
    if (!resolved) break;
    try {
      const result = await generateText({
        model: getAIModel(resolved, 'authoring'),
        messages: [
          { role: 'system', content: draftInstructions(language) },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        maxRetries: 0,
      });
      text = result.text;
      break;
    } catch (providerError) {
      log.skills.error({ err: providerError, provider: resolved.provider, attempt }, 'Provider failed for skill drafting');
      skipProviders.add(resolved.provider);
    }
  }

  if (!text) return fail(res, 503, 'No AI models available', 'service_unavailable');

  // The model is asked for a bare document, but wraps it in a fence often
  // enough that unwrapping one is cheaper than a retry.
  const document = text.replace(/^\s*```(?:markdown|md)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  try {
    const parsed = parseSkillDocument(document, { authored: true });
    res.json({ document, frontmatter: parsed.frontmatter, body: parsed.body, warnings: parsed.warnings });
  } catch (err) {
    log.skills.error({ chars: document.length }, 'The drafted skill did not parse');
    fail(res, 502, `The generated skill was not valid: ${(err as Error).message}`, 'draft_invalid');
  }
});

function draftInstructions(language: string): string {
  return [
    'You write Agent Skills: a SKILL.md file with YAML frontmatter followed by markdown instructions.',
    '',
    'Return ONLY the file, starting with --- and nothing before it.',
    '',
    'Frontmatter rules:',
    '- name: lowercase letters, numbers and single hyphens, at most 64 characters, and it may not contain "claude" or "anthropic".',
    '- description: at most 1024 characters, in the third person, saying BOTH what the skill does AND when it should be used. This is the only thing an agent matches a request against, so include the words a user would say.',
    '- Add license, compatibility, allowed-tools or metadata only if they genuinely apply.',
    '',
    'Body rules:',
    '- Write instructions for an agent, not prose about the topic. Assume the agent is already capable.',
    '- Prefer concrete steps, examples of input and output, and edge cases over explanation.',
    '- Keep it under 500 lines.',
    '',
    `Write the description and the body in this language: ${language}.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// One skill
// ---------------------------------------------------------------------------

router.get('/:idOrName', optionalAuth, async (req: Request, res: Response) => {
  try {
    const skill = await resolveVisibleSkill(param(req, 'idOrName'), req.user?.id);
    if (!skill) return fail(res, 404, 'Skill not found', 'skill_not_found');

    const latest = await findLatestVersion(getDb(), skill._id);
    const files = latest ? await listVersionFiles(getDb(), latest._id) : [];
    res.json({
      skill,
      version: latest
        ? {
            version: latest.version,
            body: latest.body,
            sourceCommit: latest.sourceCommit,
            bytes: latest.bytes,
            createdAt: latest.createdAt,
          }
        : null,
      files: files.map((file) => ({ path: file.path, kind: file.kind, mime: file.mime, bytes: file.bytes })),
    });
  } catch (err) {
    log.skills.error({ err }, 'Failed to read a skill');
    fail(res, 500, 'Failed to read that skill', 'skill_error');
  }
});

router.get('/:idOrName/versions', optionalAuth, async (req: Request, res: Response) => {
  const skill = await resolveVisibleSkill(param(req, 'idOrName'), req.user?.id);
  if (!skill) return fail(res, 404, 'Skill not found', 'skill_not_found');
  res.json({ versions: await listSkillVersions(getDb(), skill._id) });
});

/**
 * One bundled file.
 *
 * Text comes back as text and binary comes back as bytes, from S3 through this
 * API rather than from a URL: the media bucket is private, and it stays that way
 * — a canonical object URL answers 403, which is the correct behaviour and not
 * something to fix by opening the bucket.
 */
router.get('/:idOrName/files/*', optionalAuth, async (req: Request, res: Response) => {
  const skill = await resolveVisibleSkill(param(req, 'idOrName'), req.user?.id);
  if (!skill) return fail(res, 404, 'Skill not found', 'skill_not_found');

  const latest = await findLatestVersion(getDb(), skill._id);
  if (!latest) return fail(res, 404, 'That skill has no version', 'skill_not_found');

  const path = param(req, '0');
  const file = await findSkillFileByPath(getDb(), latest._id, path);
  if (!file) return fail(res, 404, 'No such file in this skill', 'file_not_found');

  if (file.contentText !== null) {
    res.type(file.mime).send(file.contentText);
    return;
  }
  const object = await readS3Object(file.s3Key!);
  if (!object) {
    log.skills.error({ path, key: file.s3Key }, 'A bundled skill file is missing from storage');
    return fail(res, 500, 'Failed to read that file', 'skill_error');
  }
  res.type(object.contentType);
  object.body.pipe(res);
});

const patchBody = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  icon: z.string().trim().max(16).nullable().optional(),
  color: z.string().trim().max(32).nullable().optional(),
  visibility: z.enum(['private', 'public']).optional(),
});

/**
 * Presentation and publication, not content.
 *
 * `name`, `description` and the body live in the document, and changing them is
 * a new VERSION rather than an edit — which is what makes a pinned install mean
 * something.
 */
router.patch('/:id', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return fail(res, 401, 'Unauthorized', 'unauthorized');
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid skill patch', 'invalid_patch');

  const updated = await updateOwnedSkill(getDb(), param(req, 'id'), req.user.id, parsed.data);
  if (!updated) return fail(res, 404, 'Skill not found', 'skill_not_found');
  res.json({ skill: updated });
});

/** A new version: the document changed, and installs that follow the latest move to it. */
router.post('/:id/versions', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return fail(res, 401, 'Unauthorized', 'unauthorized');
  const parsed = authoredBody.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid skill', 'invalid_skill');

  const skill = await findSkillById(getDb(), param(req, 'id'));
  if (!skill || skill.ownerOxyUserId !== req.user.id) return fail(res, 404, 'Skill not found', 'skill_not_found');

  try {
    const bundle = buildSkillBundle([{ path: 'SKILL.md', content: Buffer.from(documentFrom(parsed.data)) }], {
      authored: true,
      directoryName: skill.name,
    });
    if (bundle.document.frontmatter.name !== skill.name) {
      return fail(res, 400, 'A new version cannot rename the skill', 'name_immutable');
    }
    const result = await storeSkillBundle(getDb(), bundle, {
      source: skill.source,
      ownerOxyUserId: req.user.id,
      createdByOxyUserId: req.user.id,
    });
    res.status(201).json({ skill: result.skill, version: result.version, unchanged: result.unchanged });
  } catch (err) {
    handleWriteError(res, err, 'add that version');
  }
});

router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return fail(res, 401, 'Unauthorized', 'unauthorized');
  const deleted = await deleteOwnedSkill(getDb(), param(req, 'id'), req.user.id);
  if (deleted === 0) return fail(res, 404, 'Skill not found', 'skill_not_found');
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// The shelf
// ---------------------------------------------------------------------------

/**
 * Install a skill.
 *
 * Idempotent, like `POST /mcp/install`: clicking twice is a person clicking
 * twice. A private skill can only be installed by its owner, which is the same
 * predicate `resolveVisibleSkill` applies everywhere else.
 */
router.post('/:id/install', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return fail(res, 401, 'Unauthorized', 'unauthorized');
  const skill = await resolveVisibleSkill(param(req, 'id'), req.user.id);
  if (!skill) return fail(res, 404, 'Skill not found', 'skill_not_found');

  const result = await installSkill(getDb(), req.user.id, skill._id);
  res.status(result.created ? 201 : 200).json({ skill: skill.name, installed: true });
});

const installPatch = z.object({
  enabled: z.boolean().optional(),
  autoInvoke: z.boolean().optional(),
  pinnedVersion: z.number().int().min(1).nullable().optional(),
});

/** Enable, disable, or pin. The switch the old settings screen only pretended to have. */
router.patch('/:id/install', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return fail(res, 401, 'Unauthorized', 'unauthorized');
  const parsed = installPatch.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid install patch', 'invalid_patch');

  const changed = await updateInstall(getDb(), req.user.id, param(req, 'id'), parsed.data);
  if (!changed) return fail(res, 404, 'That skill is not installed', 'not_installed');
  res.json({ ok: true });
});

router.delete('/:id/install', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return fail(res, 401, 'Unauthorized', 'unauthorized');
  const removed = await uninstallSkill(getDb(), req.user.id, param(req, 'id'));
  if (removed === 0) return fail(res, 404, 'That skill is not installed', 'not_installed');
  res.status(204).end();
});

export default router;
