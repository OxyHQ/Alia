import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Audit records for configuration changes — epic #139 workstream 15, *"Add audit
 * logs for configuration changes that affect model/routing behavior."*
 *
 * Three properties, and each is checked where it can fail:
 *
 *  1. **Every configuration writer emits one.** Derived structurally, from what a
 *     function DOES to the five tables, not from what it is called. The writer
 *     census in `routes/__tests__/inference-boundary.test.ts` matches names
 *     beginning `create|update|delete|upsert|set|reset|mark`, and three real
 *     mutations of these tables — `replaceProviderMappings`, `rotateProviderKey`
 *     and the four `recordKey*` functions — begin with something else and were
 *     invisible to it. A name-based census cannot see a writer that is not named
 *     like one.
 *  2. **The record carries no credential and no content.** Enforced by an
 *     allow-list, and tested by feeding it a row that HAS a credential.
 *  3. **The record names an actor.** A required parameter, asserted on every
 *     audited writer's signature — an audit log whose actor defaults to
 *     `system` is an audit log that says `system` for the change somebody needs
 *     to attribute.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));
const PROVIDERS_DIR = path.join(REPO_ROOT, 'packages/api/src/db/providers');

/** Captured `log.info` payloads, one array shared by the fake child logger. */
const emitted: { payload: Record<string, unknown>; message: string }[] = [];

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: (payload: Record<string, unknown>, message: string) => {
      emitted.push({ payload, message });
    },
  }),
}));

const { AUDITED_FIELDS, auditedFields, recordConfigChange } = await import('../config-audit.js');

beforeEach(() => {
  emitted.length = 0;
});

/* -------------------------------------------------------------------------- */
/*  The record itself                                                          */
/* -------------------------------------------------------------------------- */

describe('a configuration audit record (#139 ws15)', () => {
  it('carries actor, before, after and a timestamp', () => {
    recordConfigChange({
      resource: 'alia_model',
      action: 'update',
      target: 'alia-v1-pro',
      actor: { kind: 'user', id: 'oxy-user-1' },
      before: { isActive: true },
      after: { isActive: false },
    });

    expect(emitted).toHaveLength(1);
    const { payload } = emitted[0];
    expect(payload.event).toBe('config.change');
    expect(payload.resource).toBe('alia_model');
    expect(payload.action).toBe('update');
    expect(payload.target).toBe('alia-v1-pro');
    expect(payload.actor).toEqual({ kind: 'user', id: 'oxy-user-1' });
    expect(payload.before).toEqual({ isActive: true });
    expect(payload.after).toEqual({ isActive: false });
    expect(String(payload.at)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('cannot carry a provider credential, even handed a whole row', () => {
    // The row a caller would most plausibly pass straight through. Two of its
    // fields are the credential; one is the prefix, which is the only
    // identifier `docs/runbooks/credential-rotation.md` treats as safe.
    const row = {
      id: 'pk_1',
      name: 'primary',
      provider: 'groq',
      key: 'gsk_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2',
      keyHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      keyPrefix: 'gsk_A1b2...',
      isActive: true,
    };
    const projected = auditedFields('provider_key', row);

    expect(projected).not.toBeNull();
    expect(Object.keys(projected ?? {})).not.toContain('key');
    expect(Object.keys(projected ?? {})).not.toContain('keyHash');
    // The positive control: the projection is not simply empty. It kept the
    // fields that make the record mean something.
    expect(projected).toMatchObject({ name: 'primary', provider: 'groq', keyPrefix: 'gsk_A1b2...' });

    // And nothing in the serialized record contains either value.
    recordConfigChange({
      resource: 'provider_key',
      action: 'update',
      target: row.id,
      actor: { kind: 'user', id: 'oxy-user-1' },
      before: projected,
      after: projected,
    });
    const serialized = JSON.stringify(emitted[0]);
    expect(serialized).not.toContain(row.key);
    expect(serialized).not.toContain(row.keyHash);
    // The control for THAT: the prefix, which is meant to be there, is.
    expect(serialized).toContain(row.keyPrefix);
  });

  it('cannot carry prompt or response content', () => {
    /**
     * Two directions. First: no allow-list names a content-shaped field.
     *
     * Matched per camelCase WORD rather than as a substring, which is not
     * fussiness — `contextWindow` contains `text`, and a substring predicate
     * reports it as content on a field that is a token count. A predicate that
     * cries wolf on a legitimate field is a predicate somebody deletes.
     */
    const CONTENT_WORDS = new Set([
      'message',
      'messages',
      'content',
      'prompt',
      'completion',
      'response',
      'transcript',
      'body',
      'text',
    ]);
    const carriesContent = (field: string): boolean =>
      field
        .split(/(?=[A-Z])/)
        .map((word) => word.toLowerCase())
        .some((word) => CONTENT_WORDS.has(word));

    for (const [resource, fields] of Object.entries(AUDITED_FIELDS)) {
      for (const field of fields) {
        expect(carriesContent(field), `${resource}.${field}`).toBe(false);
      }
      // The floor: the allow-list for this resource is not empty, so "no field
      // matches" is not true of nothing.
      expect(fields.length, resource).toBeGreaterThan(0);
    }
    // The controls, in both directions: it catches content and leaves the
    // legitimate field that contains one of the words alone.
    expect(carriesContent('systemPrompt')).toBe(true);
    expect(carriesContent('lastCompletion')).toBe(true);
    expect(carriesContent('contextWindow')).toBe(false);

    // Second, and the one that matters: a row that DOES carry content has it
    // dropped rather than passed through.
    const projected = auditedFields('alia_model', {
      aliasModelId: 'alia-v1',
      isActive: true,
      systemPrompt: 'you are a helpful assistant',
      lastCompletion: 'hello there',
    });
    expect(projected).toEqual({ aliasModelId: 'alia-v1', isActive: true });
  });

  it('projects null to null, so a create and a delete need no special case', () => {
    expect(auditedFields('alia_model', null)).toBeNull();
    expect(auditedFields('alia_model', undefined)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  Every writer, derived from what it does                                    */
/* -------------------------------------------------------------------------- */

describe('every configuration writer emits a record (#139 ws15)', () => {
  const REPOSITORIES = [
    'aliaModelRepository.ts',
    'externalModelRepository.ts',
    'modelConfigRepository.ts',
    'providerKeyRepository.ts',
  ] as const;

  interface Writer {
    readonly file: string;
    readonly name: string;
    readonly exported: boolean;
    readonly audits: boolean;
    readonly takesActor: boolean;
  }

  /**
   * The five tables a configuration change touches.
   *
   * The predicate below is `.insert(<one of these>)`, not a bare `.update(`:
   * `crypto.createHash('sha256').update(key)` is a `.update(` too, and naming
   * the tables is what tells a hash from a write. Shared with the last test in
   * this file, which asks the same question of every OTHER file.
   */
  const CONFIG_TABLES = [
    'aliaModels',
    'aliaModelProviderMappings',
    'modelConfigs',
    'providerKeys',
    'externalModels',
  ] as const;

  const MUTATES = new RegExp(
    `\\.(?:insert|update|delete)\\s*\\(\\s*(?:${CONFIG_TABLES.join('|')})\\b`,
  );

  /**
   * Every top-level function in the four repositories that MUTATES.
   *
   * Found on the AST so a mention in a comment or a string is not one. That is
   * the definition a name cannot dodge: `replaceProviderMappings` and
   * `rotateProviderKey` are both here and neither matches a `create|update|…`
   * prefix.
   */
  function writers(): Writer[] {
    const found: Writer[] = [];
    for (const file of REPOSITORIES) {
      const text = readFileSync(path.join(PROVIDERS_DIR, file), 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
        if (statement.body === undefined) continue;
        const body = statement.body.getText(source);
        if (!MUTATES.test(body)) continue;
        found.push({
          file,
          name: statement.name.text,
          exported:
            statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true,
          audits: body.includes('recordConfigChange('),
          takesActor: statement.parameters.some(
            (parameter) => parameter.getText(source).includes('ConfigAuditActor'),
          ),
        });
      }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The mutations that are automatic KEY HEALTH rather than configuration.
   *
   * A key cools down because an upstream said no; nobody configured anything, so
   * an audit record of it is a metric wearing an audit record's clothes and
   * `lib/observability/metrics.ts` is where that belongs. Exact, and with the
   * count asserted, so a NEW writer cannot join this list by looking like one.
   */
  const HEALTH_ONLY: readonly string[] = [
    'markKeyCreditExhausted',
    'recordKeyFailure',
    'recordKeySpend',
    'recordKeySuccess',
    'recordKeyUsage',
    'setKeyCooldown',
  ];

  /**
   * The one mutation that neither audits nor is health: it is module-private and
   * every caller audits the change it is part of.
   *
   * Named rather than skipped, and required to be UNEXPORTED below — the moment
   * it becomes callable from outside, it is a public routing mutation with no
   * record and this entry stops being true.
   */
  const PRIVATE_HELPERS: readonly string[] = ['replaceProviderMappings'];

  it('found the mutations, including the ones a name-based census misses', () => {
    const found = writers();
    // The floor: the AST scan read four real files and found real writers.
    expect(found.length).toBeGreaterThanOrEqual(19);
    for (const name of ['rotateProviderKey', 'replaceProviderMappings', 'recordKeyFailure']) {
      expect(
        found.map((w) => w.name),
        `${name} is a mutation a prefix-based census cannot see`,
      ).toContain(name);
    }
  });

  it('every one is audited, health-only, or a private helper — exactly', () => {
    const found = writers();
    const audited = found.filter((w) => w.audits).map((w) => w.name).sort();
    const rest = found.filter((w) => !w.audits).map((w) => w.name).sort();

    // Exact, both directions: an unaudited writer that is on neither list fails,
    // and a list entry for a writer that no longer exists fails too.
    expect(rest).toEqual([...HEALTH_ONLY, ...PRIVATE_HELPERS].sort());
    // The floor before that equality: something IS audited, so an empty scan
    // cannot satisfy it.
    expect(audited.length).toBeGreaterThanOrEqual(13);
  });

  it('every audited writer takes an actor, and the private helper is not exported', () => {
    for (const writer of writers()) {
      if (writer.audits) {
        expect(writer.takesActor, `${writer.file}: ${writer.name} audits with no actor`).toBe(true);
        expect(writer.exported, `${writer.file}: ${writer.name} audits but is unreachable`).toBe(
          true,
        );
      }
      if (PRIVATE_HELPERS.includes(writer.name)) {
        expect(writer.exported, `${writer.name} is exported; it mutates routing unaudited`).toBe(
          false,
        );
      }
    }
  });

  it('no caller can omit the actor, because it is not optional', () => {
    // A `actor?: ConfigAuditActor` would satisfy the signature census above and
    // record `undefined` for every change. Read off the source text of the four
    // files rather than the AST, because the hazard is one character.
    for (const file of REPOSITORIES) {
      const text = readFileSync(path.join(PROVIDERS_DIR, file), 'utf8');
      expect(text, `${file} made the actor optional`).not.toMatch(/actor\?\s*:/);
    }
    // The floor: the files were read and DO name the actor.
    const named = REPOSITORIES.filter((file) =>
      readFileSync(path.join(PROVIDERS_DIR, file), 'utf8').includes('actor: ConfigAuditActor'),
    );
    expect(named).toEqual([...REPOSITORIES]);
  });

  it('nothing outside the repositories writes these tables directly', () => {
    // The other way to change configuration without a record: skip the
    // repository and write the table. The five tables are named, and the only
    // files allowed to mutate them are the four repositories and the migrator.
    const files = execFileSync('git', ['ls-files', '--', 'packages/api/src'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(
        (file) =>
          file.endsWith('.ts') &&
          !file.includes('/__tests__/') &&
          !file.startsWith('packages/api/src/db/providers/') &&
          !file.startsWith('packages/api/src/db/schema/'),
      );

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      for (const table of CONFIG_TABLES) {
        const pattern = new RegExp(`\\.(?:insert|update|delete)\\s*\\(\\s*${table}\\b`);
        if (pattern.test(text)) offenders.push(`${file} -> ${table}`);
      }
    }
    expect(files.length).toBeGreaterThan(300);
    expect(offenders).toEqual([]);

    // The control: the predicate fires on a real one.
    expect(/\.(?:insert|update|delete)\s*\(\s*providerKeys\b/.test('await db.update(providerKeys)')).toBe(
      true,
    );
  });
});
