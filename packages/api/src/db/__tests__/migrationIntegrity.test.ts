import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The three things about this service's migrations that nothing was checking.
 *
 * Every one of them was learned the hard way in a single afternoon, and every
 * one passed all six CI jobs on its way in:
 *
 *  1. A commit deleted four tables from the schema and shipped WITHOUT the
 *     migration that drops them. Production keeps the tables forever, and —
 *     worse — the drift is contagious: `drizzle-kit generate` diffs the schema
 *     against the latest snapshot, so the next person's unrelated migration
 *     silently absorbs those `DROP TABLE`s, attributed to their change, under
 *     whatever deploy phase THEY chose. A drop is `post`; an additive change is
 *     `pre`. That is how a drop lands before the image that tolerates it.
 *  2. A migration was generated, collided with a number `main` had taken, and
 *     the tempting repair was to rename it. A migration's identity is the
 *     `when` in `_journal.json`, not its index or filename, so a rename carries
 *     the ORIGINAL timestamp — and one attempt really did end up with a `when`
 *     EARLIER than the migration already on `main`.
 *  3. `drizzle-kit` does not write the `-- oxy:deploy-phase=` marker that
 *     `src/db/migrate.ts` refuses to run without, so a generated file is
 *     unrunnable until somebody adds it by hand.
 *
 * None of these breaks a test, because every suite migrates a database from
 * ZERO. From empty, a missing drop is a table that never existed, and a journal
 * that does not ascend applies in file order anyway. They are invisible from
 * empty and destructive against a database that already exists — which is the
 * only kind production has.
 */

const PACKAGE_ROOT = path.join(__dirname, '..', '..', '..');
const DRIZZLE = path.join(PACKAGE_ROOT, 'drizzle');

interface JournalEntry {
  readonly idx: number;
  readonly when: number;
  readonly tag: string;
}

const journal = (): JournalEntry[] =>
  JSON.parse(readFileSync(path.join(DRIZZLE, 'meta', '_journal.json'), 'utf8')).entries;

const migrationFiles = (): string[] =>
  readdirSync(DRIZZLE).filter((f) => f.endsWith('.sql')).sort();

/** `-- oxy:deploy-phase=pre|post`, on a line of its own, as `migrate.ts` reads it. */
const PHASE = /^-- oxy:deploy-phase=(pre|post)$/gm;
const phaseMarkers = (sql: string): string[] => [...sql.matchAll(PHASE)].map((m) => m[1]);

describe('every migration declares the half of the rollout it belongs to', () => {
  it('finds migrations at all, so an empty sweep cannot pass', () => {
    // The vacuity floor. A glob that matched nothing would satisfy every
    // per-file assertion below by iterating zero times.
    expect(migrationFiles().length).toBeGreaterThanOrEqual(30);
  });

  it('carries exactly one phase marker per file', () => {
    const wrong = migrationFiles()
      .map((f) => ({ file: f, markers: phaseMarkers(readFileSync(path.join(DRIZZLE, f), 'utf8')) }))
      .filter((r) => r.markers.length !== 1)
      .map((r) => `${r.file}: ${r.markers.length} markers`);

    expect(
      wrong,
      'Every migration needs exactly one `-- oxy:deploy-phase=pre` or\n' +
        '`-- oxy:deploy-phase=post` line. `drizzle-kit` never writes it, and\n' +
        '`src/db/migrate.ts` REFUSES a file without one — so the failure lands in\n' +
        'a deploy rather than here unless this catches it first.\n' +
        'Additive changes are `pre`; drops, renames and narrows are `post`.',
    ).toEqual([]);
  });

  it('the marker test can tell a missing or doubled marker from a correct one', () => {
    // The positive control. Reading real files and finding nothing wrong is the
    // same result as a matcher that matches nothing.
    expect(phaseMarkers('-- oxy:deploy-phase=post\nDROP TABLE "x";')).toEqual(['post']);
    expect(phaseMarkers('DROP TABLE "x";')).toEqual([]);
    expect(phaseMarkers('-- oxy:deploy-phase=pre\n-- oxy:deploy-phase=post\n')).toEqual(['pre', 'post']);
    // Not a marker: the prefix has to own the whole line.
    expect(phaseMarkers('  -- oxy:deploy-phase=post')).toEqual([]);
  });
});

describe('the journal is a strictly ordered, complete record', () => {
  it('ascends by `when`, which is the migration identity', () => {
    const entries = journal();
    expect(entries.length).toBeGreaterThanOrEqual(30);
    const outOfOrder = entries
      .slice(1)
      .map((e, i) => ({ prev: entries[i], cur: e }))
      .filter((p) => p.cur.when <= p.prev.when)
      .map((p) => `${p.prev.tag} (${p.prev.when}) then ${p.cur.tag} (${p.cur.when})`);

    /**
     * The message carries the REMEDY, because the cheapest way to make this
     * assertion pass is the thing it exists to prevent.
     *
     * A reader who sees only "these two are out of order" reaches for the
     * journal and edits a number, or renames the file — and a rename keeps the
     * ORIGINAL timestamp, which is the defect, not the fix. A gate whose
     * cheapest green is the dangerous action teaches the opposite of what it
     * was built for.
     */
    expect(
      outOfOrder,
      'A migration is ordered by its `when`, not by its index or filename.\n' +
        'REGENERATE it — delete the .sql, its meta/NNNN_snapshot.json and its\n' +
        'journal entry, then run `bunx drizzle-kit generate` again. Do NOT rename\n' +
        'the file or hand-edit `when`: a rename keeps the original timestamp, so\n' +
        'it applies cleanly to a database built from zero — it passes CI — and\n' +
        'strands the migration on one that is already partway through.',
    ).toEqual([]);
  });

  it('has unique indexes', () => {
    const idxs = journal().map((e) => e.idx);
    expect(idxs.length).toBe(new Set(idxs).size);
  });

  it('names a file for every entry, and an entry for every file', () => {
    const tags = journal().map((e) => e.tag).sort();
    const files = migrationFiles().map((f) => f.replace(/\.sql$/, '')).sort();
    // Both directions: an entry with no file is unrunnable, and a file with no
    // entry never runs. The second is how a migration goes missing while the
    // folder still looks full.
    expect(tags).toEqual(files);
  });

  it('the ordering test can report a journal that does not ascend', () => {
    // The positive control for the predicate itself, over a fixture shaped like
    // the real defect: a rename that kept an older timestamp.
    const tampered = [
      { idx: 1, when: 200, tag: 'b' },
      { idx: 2, when: 100, tag: 'a_renamed' },
    ];
    const outOfOrder = tampered.slice(1).filter((e, i) => e.when <= tampered[i].when);
    expect(outOfOrder).toHaveLength(1);
  });
});

/**
 * The schema and the migration history agree.
 *
 * Asked of drizzle-kit itself, because it is the tool whose answer actually
 * matters: it is the one that will fold an unnoticed difference into somebody
 * else's migration.
 *
 * The probe runs against a COPY so the real folder is never written to, and the
 * copy lives under `node_modules/.cache` because `out` is resolved relative to
 * the working directory and that path is already ignored by git.
 */
describe('the schema and the migrations agree', () => {
  const CACHE = path.join(PACKAGE_ROOT, 'node_modules', '.cache');

  /**
   * Generate into a copy of the migration folder and return the files it
   * emitted. Empty means the schema is fully described by the history.
   *
   * The RESULT is read from the directory rather than from the exit code:
   * `drizzle-kit generate` exits 0 even when it refuses to run — measured, a
   * bare `--out` makes it ignore the config, report `schema: undefined`, and
   * still exit 0. A gate reading `$?` would call that a pass.
   */
  function emittedBy(prepare?: (dir: string) => void): string[] {
    const dir = path.join(CACHE, `drizzle-probe-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      mkdirSync(dir, { recursive: true });
      cpSync(DRIZZLE, dir, { recursive: true });
      prepare?.(dir);
      const before = new Set(readdirSync(dir).filter((f) => f.endsWith('.sql')));
      const rel = path.relative(PACKAGE_ROOT, dir);
      const config = path.join(dir, 'probe.config.ts');
      writeFileSync(
        config,
        `import base from '${path.join(PACKAGE_ROOT, 'drizzle.config.ts')}';\n` +
          `export default { ...base, out: '${rel}' };\n`,
      );
      execFileSync('bunx', ['drizzle-kit', 'generate', `--config=${config}`, '--name=probe'], {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return readdirSync(dir).filter((f) => f.endsWith('.sql') && !before.has(f));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('drizzle-kit has nothing left to emit', () => {
    expect(
      emittedBy(),
      'The schema and the migration history disagree: `drizzle-kit` still has\n' +
        'something to emit. Run `bunx drizzle-kit generate` and commit ALL THREE\n' +
        'halves of it — the .sql, meta/NNNN_snapshot.json and the _journal.json\n' +
        'entry. A freshly generated file is UNTRACKED, so `git add` on a path you\n' +
        'already changed will miss it; check `git ls-files --others` is empty\n' +
        'before committing.\n' +
        'Left unfixed this is contagious: the next unrelated migration absorbs\n' +
        'this diff, attributed to that change, under whatever phase it chose.',
    ).toEqual([]);
  }, 120_000);

  it('the probe can detect a migration that is missing', () => {
    // The positive control, and the reason the assertion above means anything:
    // with the newest migration taken out of the copy, drizzle-kit must want to
    // write it again. Without this, "emitted nothing" and "the probe never ran"
    // are the same observation — which they were, on the first version of this,
    // where a mis-invoked drizzle-kit emitted nothing and exited 0.
    const emitted = emittedBy((dir) => {
      const entries: JournalEntry[] = JSON.parse(
        readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8'),
      ).entries;
      const last = entries[entries.length - 1];
      rmSync(path.join(dir, `${last.tag}.sql`));
      rmSync(path.join(dir, 'meta', `${String(last.idx).padStart(4, '0')}_snapshot.json`));
      writeFileSync(
        path.join(dir, 'meta', '_journal.json'),
        JSON.stringify({ version: '7', dialect: 'postgresql', entries: entries.slice(0, -1) }, null, 2),
      );
    });

    expect(emitted).toHaveLength(1);
  }, 120_000);

  it('leaves no probe directory behind', () => {
    if (!existsSync(CACHE)) return;
    expect(readdirSync(CACHE).filter((f) => f.startsWith('drizzle-probe-'))).toEqual([]);
  });
});
