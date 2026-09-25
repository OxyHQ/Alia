/**
 * Moves `packages/app` from its `components/` + `lib/` + `types/` + `test/`
 * layout into the feature tree under `src/` (#608 §4, `docs/app-architecture.mdx`)
 * and rewrites every path that named the old layout.
 *
 *   bun packages/app/scripts/move-to-features.ts [--dry-run] [--scope=app,repo,docs]
 *
 * What it does, in order:
 *
 *  1. Maps every tracked file under the old directories to its destination with
 *     {@link RULES}. A file no rule places is an error — nothing is left behind
 *     in `components/` or `lib/` by accident — and so is a platform pair
 *     (`x.tsx` + `x.web.tsx`/`x.native.tsx`) that two rules would split.
 *  2. `git mv`s each file, so blame follows it.
 *  3. Rewrites, with the TypeScript parser, every module specifier in every
 *     `.ts`/`.tsx`/`.js`/`.mjs` file of the package: import/export
 *     declarations, `import()`, `import("…")` types, `require()`,
 *     `vi.mock`/`doMock`/`unmock`/`importActual`/`importMock`, plus any
 *     relative string literal that names an old file with its extension
 *     (`new URL('../lib/x.ts', import.meta.url)`, `resolve(dirname, '../x.tsx')`).
 *     Each specifier is resolved from where its file USED to be, against the
 *     layout as it was, and written as `@/…` (the alias is `./src/*`) when it
 *     lands under `src/`, or relative from the file's new place when it does
 *     not (`assets/`, `app/`, `scripts/`, sibling packages). A relative
 *     specifier whose relationship survived the move is left as written.
 *     An import-position specifier that resolves to nothing is an error.
 *  4. Rewrites textual mentions of the moved files — comments, docs — where
 *     they are written as file paths: inside `packages/app` as
 *     `components/x.tsx` or `packages/app/components/x.tsx`; elsewhere in the
 *     repo only in the prefixed form, since an unprefixed `lib/config.ts` in
 *     `packages/api` is the API's own. `--scope` limits this: `app` (the
 *     package), `repo` (every tracked file outside the package and `docs/`),
 *     `docs` (`docs/`, less the dated `docs/superpowers/` plans). Default: all
 *     three. On a tree already moved, `--from=<rev>` (a commit before the move)
 *     supplies the old file list, so prose can still be brought across.
 *
 * It is idempotent: on a tree already moved there is no old file to map and no
 * specifier naming the old layout, and it exits having changed nothing.
 *
 * ── Bringing a branch that predates the move across ────────────────────────
 *
 * The move commit is this script's output plus a handful of hand fixes (the
 * alias in tsconfig/babel/vitest, `global.css` `@source`, tests that build
 * paths by `join(ROOT, 'components')`). So, on a branch B cut before it:
 *
 *   git merge <parent of the move commit>          # B holds everything up to it
 *   bun packages/app/scripts/move-to-features.ts   # B moves itself the same way
 *   # if it names an unmapped file, B added it: add a RULE for it, re-run
 *   git add -A && git commit -m "refactor(app): move to the feature tree"
 *   git merge <the move commit>                    # same renames on both sides
 *   git merge main                                 # and the rest
 *
 * Both sides of the `<the move commit>` merge made identical renames and
 * identical rewrites, so git has nothing to reconcile but B's own lines and the
 * hand fixes. Then run `bun run --filter @alia/app typecheck && test`: the
 * feature-boundaries gate names any import B added that crosses a feature
 * edge the tree does not allow.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import ts from 'typescript';

const APP = resolve(import.meta.dirname, '..');
const REPO = resolve(APP, '..', '..');
const OLD_DIRS = ['components', 'lib', 'types', 'test'];

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const scopeArg = args.find((a) => a.startsWith('--scope='));
const SCOPE = new Set((scopeArg ? scopeArg.slice('--scope='.length) : 'app,repo,docs').split(','));

// ── 1. Where each file goes ─────────────────────────────────────────────────
//
// `[old, new]`, both relative to `packages/app`. An entry ending in `/` moves
// a directory prefix; any other is one file. The most specific match wins
// (exact file before prefix, longer prefix before shorter), so a directory
// rule can carry the bulk and a file rule can pull one file out of it.

const C = 'src/features/chat';
const RULES: Array<[string, string]> = [
  // shell
  ...[
    'sidebar.tsx', 'sidebar-menus.tsx', 'command-palette.tsx', 'keyboard-shortcuts-dialog.tsx',
    'error-boundary.tsx', 'workspace-panel.tsx',
  ].map((f): [string, string] => [`components/${f}`, `src/shell/${f}`]),
  ['components/app-shell/page-chrome.tsx', 'src/shell/page-chrome.tsx'],
  ['lib/sidebar-history.ts', 'src/shell/sidebar-history.ts'],
  ...[
    'sidebar-tree.test.tsx', 'app-error-boundary.test.tsx', 'right-panel-divider.test.ts',
    'workspace-panel-terminal.test.tsx',
  ].map((f): [string, string] => [`components/__tests__/${f}`, `src/shell/__tests__/${f}`]),
  ...['conversations-for-history.test.ts', 'sidebar-sections.test.ts', 'sidebar-selection.test.ts'].map(
    (f): [string, string] => [`lib/__tests__/${f}`, `src/shell/__tests__/${f}`],
  ),

  // chat — model
  ...['attachment-intake', 'context-usage', 'timeline', 'tool-cards', 'turn-selection', 'work-log'].map(
    (f): [string, string] => [`lib/chat/${f}.ts`, `${C}/model/${f}.ts`],
  ),
  ...[
    'chat-message-history', 'message-days', 'message-processor', 'thought-utils', 'thread-history',
    'tool-registry', 'attachment-utils', 'conversation-export', 'task-utils', 'workspace-panel-kind',
  ].map((f): [string, string] => [`lib/${f}.ts`, `${C}/model/${f}.ts`]),
  ['lib/constants/capability-families.ts', `${C}/model/capability-families.ts`],
  ['types/chat.ts', `${C}/model/chat.ts`],
  ...['attachment-intake', 'timeline', 'tool-cards', 'turn-selection', 'work-log'].map(
    (f): [string, string] => [`lib/chat/__tests__/${f}.test.ts`, `${C}/model/__tests__/${f}.test.ts`],
  ),
  ...[
    'attachment-utils', 'chat-message-history', 'context-usage', 'conversation-export', 'message-days',
    'research-sources', 'thought-utils', 'thread-history', 'turn-timings-scale',
  ].map((f): [string, string] => [`lib/__tests__/${f}.test.ts`, `${C}/model/__tests__/${f}.test.ts`]),
  ['components/__tests__/workspace-panel-kind.test.ts', `${C}/model/__tests__/workspace-panel-kind.test.ts`],

  // chat — runtime
  ...[
    'sse-frame-reader', 'stream-outcome', 'use-capability-modes', 'use-credit-warnings',
    'use-local-models-invite', 'use-open-thought', 'use-turn-edit',
  ].map((f): [string, string] => [`lib/chat/${f}.ts`, `${C}/runtime/${f}.ts`]),
  ...[
    'streaming-chat', 'chat-conversation', 'conversations', 'thread-history', 'thread-search',
    'timeline-window', 'suggestions', 'at-bottom', 'catalogue', 'product-modes', 'agent-activity',
    'agent-row-preview',
  ].map((f): [string, string] => [`lib/hooks/use-${f}.ts`, `${C}/runtime/use-${f}.ts`]),
  ...['ui-store', 'global-store', 'composer-draft-store', 'model-store'].map(
    (f): [string, string] => [`lib/stores/${f}.ts`, `${C}/runtime/${f}.ts`],
  ),
  ['lib/conversation-share.ts', `${C}/runtime/conversation-share.ts`],
  ['lib/chat/__tests__/', `${C}/runtime/__tests__/`],
  ...[
    'use-streaming-chat-lifecycle.test.tsx', 'use-streaming-chat-message-ids.test.tsx',
    'use-streaming-chat-synthetic.test.tsx', 'use-streaming-chat-usage.test.tsx',
  ].map((f): [string, string] => [`components/__tests__/${f}`, `${C}/runtime/__tests__/${f}`]),
  ...[
    'use-chat-conversation-clear.test.tsx', 'use-chat-conversation-regenerate.test.tsx',
    'use-clear-conversation.test.tsx', 'use-rename-conversation.test.tsx', 'use-product-modes.test.ts',
    'use-agent-row-preview.test.tsx',
  ].map((f): [string, string] => [`lib/hooks/__tests__/${f}`, `${C}/runtime/__tests__/${f}`]),
  ...['composer-draft-store.test.tsx', 'agent-session-owner.test.ts', 'right-panel-width.test.ts'].map(
    (f): [string, string] => [`lib/stores/__tests__/${f}`, `${C}/runtime/__tests__/${f}`],
  ),
  ['lib/__tests__/ui-store-thought-scope.test.ts', `${C}/runtime/__tests__/ui-store-thought-scope.test.ts`],

  // chat — ui
  ['components/chat/', `${C}/ui/`],
  ...[
    'chat-interface', 'chat-page-content', 'conversation-screen', 'new-conversation-offer', 'welcome-intro',
    'welcome-message', 'thought-panel', 'file-card', 'ambient-field', 'thread-search',
  ].map((f): [string, string] => [`components/${f}.tsx`, `${C}/ui/${f}.tsx`]),
  ['components/ui/markdown.tsx', `${C}/ui/markdown.tsx`],
  ['components/ui/rich-blocks.tsx', `${C}/ui/rich-blocks.tsx`],
  ['components/canvas/', `${C}/ui/canvas/`],
  ['components/execution/', `${C}/ui/execution/`],
  ...['agent-panel', 'agent-terminal', 'credits-limits'].map(
    (f): [string, string] => [`components/${f}.tsx`, `${C}/ui/workspace/${f}.tsx`],
  ),
  ...['agent-result-card', 'agent-task-card'].map(
    (f): [string, string] => [`components/${f}.tsx`, `${C}/ui/cards/${f}.tsx`],
  ),
  // The rest of the component tests are about chat surfaces.
  ['components/__tests__/', `${C}/ui/__tests__/`],

  // voice
  ...['voice-mode', 'voice-room', 'tts', 'speech-to-text'].map(
    (f): [string, string] => [`lib/hooks/use-${f}.ts`, `src/features/voice/runtime/use-${f}.ts`],
  ),
  ['lib/hooks/__tests__/use-voice-mode-disconnect.test.tsx', 'src/features/voice/runtime/__tests__/use-voice-mode-disconnect.test.tsx'],
  ['lib/voice-error-text.ts', 'src/features/voice/model/voice-error-text.ts'],
  ['lib/speech-locale.ts', 'src/features/voice/model/speech-locale.ts'],
  ['components/icons/voice-mode-icon.tsx', 'src/features/voice/ui/voice-mode-icon.tsx'],

  // agents
  ...['approvals-banner', 'capability-toggles', 'card', 'connector-grants'].map(
    (f): [string, string] => [`components/agent-${f}.tsx`, `src/features/agents/ui/agent-${f}.tsx`],
  ),
  ['components/__tests__/agent-connector-grants.test.tsx', 'src/features/agents/ui/__tests__/agent-connector-grants.test.tsx'],
  ['components/agents/', 'src/features/agents/ui/'],
  ['components/detail/activity-grid.tsx', 'src/features/agents/ui/detail/activity-grid.tsx'],
  ['lib/agents/', 'src/features/agents/model/'],
  ['lib/hooks/agents/', 'src/features/agents/runtime/'],
  ...['activity-grid', 'agent-approvals', 'agent-bots', 'agents', 'agent-teams', 'agent-threads', 'agent-thread', 'my-agents'].map(
    (f): [string, string] => [`lib/hooks/use-${f}.ts`, `src/features/agents/runtime/use-${f}.ts`],
  ),
  ...['use-agents.test.tsx', 'agents-store-is-gone.test.ts'].map(
    (f): [string, string] => [`lib/hooks/__tests__/${f}`, `src/features/agents/runtime/__tests__/${f}`],
  ),

  // automations (and tasks)
  ['lib/automations/types.ts', 'src/shared/contracts/automations.ts'],
  ['lib/automations/', 'src/features/automations/model/'],
  ['lib/hooks/use-automations.ts', 'src/features/automations/runtime/use-automations.ts'],
  ['lib/hooks/use-tasks.ts', 'src/features/automations/runtime/use-tasks.ts'],
  ['lib/hooks/tasks/', 'src/features/automations/runtime/'],
  ['components/automations/', 'src/features/automations/ui/'],
  ['components/tasks/', 'src/features/automations/ui/'],

  // research
  ['lib/citations.ts', 'src/features/research/model/citations.ts'],
  ['lib/__tests__/citations.test.ts', 'src/features/research/model/__tests__/citations.test.ts'],

  // memory
  ['lib/stores/user-data-store.ts', 'src/features/memory/runtime/user-data-store.ts'],
  ['lib/hooks/use-user-data.ts', 'src/features/memory/runtime/use-user-data.ts'],

  // library
  ['lib/stores/library-store.ts', 'src/features/library/runtime/library-store.ts'],

  // projects
  ...['projects', 'folders', 'pinned', 'favorites'].map(
    (f): [string, string] => [`lib/stores/${f}-store.ts`, `src/features/projects/runtime/${f}-store.ts`],
  ),
  ['lib/stores/__tests__/account-scoped-collections.test.ts', 'src/features/projects/runtime/__tests__/account-scoped-collections.test.ts'],
  ['components/project-edit-dialog.tsx', 'src/features/projects/ui/project-edit-dialog.tsx'],

  // shows
  ['components/show/', 'src/features/shows/ui/'],
  ['lib/stores/show-store.ts', 'src/features/shows/runtime/show-store.ts'],
  ['lib/hooks/use-show-progress.ts', 'src/features/shows/runtime/use-show-progress.ts'],
  ['lib/hooks/use-episode-audio.ts', 'src/features/shows/runtime/use-episode-audio.ts'],
  ['lib/stores/__tests__/show-store.test.ts', 'src/features/shows/runtime/__tests__/show-store.test.ts'],
  ...['use-episode-audio.test.tsx', 'use-episode-audio-player-import.test.tsx'].map(
    (f): [string, string] => [`lib/hooks/__tests__/${f}`, `src/features/shows/runtime/__tests__/${f}`],
  ),
  ['lib/utils/show-format.ts', 'src/features/shows/model/show-format.ts'],
  ['lib/utils/__tests__/show-format.test.ts', 'src/features/shows/model/__tests__/show-format.test.ts'],

  // skills
  ['lib/hooks/use-skills.ts', 'src/features/skills/runtime/use-skills.ts'],
  ...[
    'skill-cover.tsx', 'skill-cover-animated.tsx', 'skill-cover-canvas.tsx', 'skill-cover-canvas.web.tsx',
    'skill-cover-canvas-skia.tsx', 'skill-cover-palette.ts', 'skill-cover-static.tsx',
  ].map((f): [string, string] => [`components/ui/${f}`, `src/features/skills/ui/${f}`]),
  ['components/__tests__/skill-cover-static.test.tsx', 'src/features/skills/ui/__tests__/skill-cover-static.test.tsx'],

  // connections
  ...['connected-accounts', 'integrations', 'mcp-servers', 'bots'].map(
    (f): [string, string] => [`lib/hooks/use-${f}.ts`, `src/features/connections/runtime/use-${f}.ts`],
  ),

  // local models
  ...['use-local-runtime.ts', 'use-local-runtimes.ts'].map(
    (f): [string, string] => [`lib/hooks/${f}`, `src/features/local-models/runtime/${f}`],
  ),
  ...['local-runtime-store.ts', 'local-runtime-migration.ts'].map(
    (f): [string, string] => [`lib/stores/${f}`, `src/features/local-models/runtime/${f}`],
  ),
  ['lib/stores/__tests__/local-runtime-migration.test.ts', 'src/features/local-models/runtime/__tests__/local-runtime-migration.test.ts'],

  // billing
  ['lib/hooks/use-billing.ts', 'src/features/billing/runtime/use-billing.ts'],
  ['lib/hooks/use-credits.ts', 'src/features/billing/runtime/use-credits.ts'],
  ['lib/hooks/billing/', 'src/features/billing/runtime/'],
  ['lib/credits-limits.ts', 'src/features/billing/model/credits-limits.ts'],
  ['lib/__tests__/credits-limits.test.ts', 'src/features/billing/model/__tests__/credits-limits.test.ts'],
  ['lib/errors/usage-limit-error.ts', 'src/features/billing/model/usage-limit-error.ts'],
  ['components/usage-limit-dialog.tsx', 'src/features/billing/ui/usage-limit-dialog.tsx'],
  ['components/subscribe-shared.tsx', 'src/features/billing/ui/subscribe-shared.tsx'],

  // onboarding
  ['components/auth/', 'src/features/onboarding/ui/'],
  ['lib/hooks/auth/', 'src/features/onboarding/runtime/'],
  ['lib/hooks/use-organization-invites.ts', 'src/features/onboarding/runtime/use-organization-invites.ts'],
  ['lib/hooks/use-referrals.ts', 'src/features/onboarding/runtime/use-referrals.ts'],
  ['components/invite-dialog.tsx', 'src/features/onboarding/ui/invite-dialog.tsx'],

  // notifications
  ['lib/hooks/use-notifications.ts', 'src/features/notifications/runtime/use-notifications.ts'],
  ['lib/hooks/use-notification-setup.ts', 'src/features/notifications/runtime/use-notification-setup.ts'],
  ['lib/api/notifications-socket.ts', 'src/features/notifications/runtime/notifications-socket.ts'],
  ['lib/api/__tests__/notifications-socket.test.ts', 'src/features/notifications/runtime/__tests__/notifications-socket.test.ts'],
  ['lib/hooks/__tests__/use-notification-setup-platform.test.ts', 'src/features/notifications/runtime/__tests__/use-notification-setup-platform.test.ts'],

  // settings
  ['components/settings/', 'src/features/settings/ui/'],
  ['components/__tests__/settings-modal-navigation.test.tsx', 'src/features/settings/ui/__tests__/settings-modal-navigation.test.tsx'],
  ['lib/personality-styles.ts', 'src/features/settings/model/personality-styles.ts'],
  ['lib/hooks/use-personality-sample-phrase.ts', 'src/features/settings/runtime/use-personality-sample-phrase.ts'],
  ['lib/hooks/__tests__/use-personality-sample-phrase.test.tsx', 'src/features/settings/runtime/__tests__/use-personality-sample-phrase.test.tsx'],

  // shared/api
  ['lib/api/client.ts', 'src/shared/api/client.ts'],
  ['lib/api/routes.ts', 'src/shared/api/routes.ts'],
  ['lib/hooks/create-query.ts', 'src/shared/api/create-query.ts'],
  ['lib/hooks/query-keys.ts', 'src/shared/api/query-keys.ts'],
  ['lib/errors/error-utils.ts', 'src/shared/api/error-utils.ts'],
  ['lib/errors/__tests__/error-utils.test.ts', 'src/shared/api/__tests__/error-utils.test.ts'],
  ['lib/generate-api-url.ts', 'src/shared/api/generate-api-url.ts'],

  // shared/i18n
  ['lib/i18n/', 'src/shared/i18n/'],
  ['lib/hooks/use-translation.ts', 'src/shared/i18n/use-translation.ts'],
  ['lib/hooks/__tests__/use-translation.test.tsx', 'src/shared/i18n/__tests__/use-translation.test.tsx'],
  ['lib/stores/i18n-store.ts', 'src/shared/i18n/i18n-store.ts'],

  // shared/platform
  ...['config.ts', 'device-info.ts', 'themePersistence.ts', 'keyboard.tsx', 'keyboard.native.tsx', 'useColorScheme.tsx'].map(
    (f): [string, string] => [`lib/${f}`, `src/shared/platform/${f}`],
  ),
  ...['is-large-screen', 'image-picker', 'document-picker', 'sound-effects', 'screen-on-show'].map(
    (f): [string, string] => [`lib/hooks/use-${f}.ts`, `src/shared/platform/use-${f}.ts`],
  ),
  ['lib/hooks/__tests__/use-screen-on-show.test.tsx', 'src/shared/platform/__tests__/use-screen-on-show.test.tsx'],
  ['lib/utils/random-uuid.ts', 'src/shared/platform/random-uuid.ts'],
  ['lib/utils/__tests__/random-uuid.test.ts', 'src/shared/platform/__tests__/random-uuid.test.ts'],

  // shared/state, format, contracts, domain
  ['lib/stores/account-scope.ts', 'src/shared/state/account-scope.ts'],
  ['lib/stores/create-collection-store.ts', 'src/shared/state/create-collection-store.ts'],
  ...['format-file-size', 'relative-time', 'title-tags'].map(
    (f): [string, string] => [`lib/utils/${f}.ts`, `src/shared/format/${f}.ts`],
  ),
  ['lib/types/', 'src/shared/contracts/'],
  ['lib/agents/agent-color.ts', 'src/shared/domain/agent-color.ts'],
  ['lib/agents/__tests__/agent-color.test.ts', 'src/shared/domain/__tests__/agent-color.test.ts'],
  ['lib/constants/agent-colors.ts', 'src/shared/domain/agent-colors.ts'],

  // shared/ui
  ...['action-key-icon', 'alia-logo', 'image'].map(
    (f): [string, string] => [`components/ui/${f}.tsx`, `src/shared/ui/${f}.tsx`],
  ),
  ['components/ui/icons/', 'src/shared/ui/icons/'],
  ['components/__tests__/generated-icons.test.ts', 'src/shared/ui/__tests__/generated-icons.test.ts'],

  // shared/testing
  ['test/', 'src/shared/testing/'],
  ['components/__tests__/native-module-stubs.tsx', 'src/shared/testing/native-module-stubs.tsx'],
  ['components/__tests__/panel-bloom-stubs.tsx', 'src/shared/testing/panel-bloom-stubs.tsx'],

  // package-wide tests stay at the package root
  ...['bloom-boundaries', 'removed-dependencies-stay-removed', 'single-overlay-host', 'native-system-bars'].map(
    (f): [string, string] => [`lib/__tests__/${f}.test.ts`, `__tests__/${f}.test.ts`],
  ),
];

function destinationOf(old: string): string | undefined {
  let best: [string, string] | undefined;
  for (const rule of RULES) {
    const [from] = rule;
    if (from.endsWith('/') ? old.startsWith(from) : old === from) {
      if (!from.endsWith('/')) return rule[1];
      if (!best || from.length > best[0].length) best = rule;
    }
  }
  return best ? best[1] + old.slice(best[0].length) : undefined;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const git = (...a: string[]) => execFileSync('git', a, { cwd: APP, encoding: 'utf8', maxBuffer: 1 << 28 });
const toPosix = (p: string) => p.split('\\').join('/');
const relApp = (abs: string) => toPosix(relative(APP, abs));
const isFile = (abs: string) => existsSync(abs) && statSync(abs).isFile();

const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);
const bail = () => {
  if (errors.length === 0) return;
  console.error(errors.map((e) => `  ✗ ${e}`).join('\n'));
  console.error(`\n${errors.length} problem(s); nothing past this point was done.`);
  process.exit(1);
};

// ── pass 1: map and move ────────────────────────────────────────────────────

const tracked = git('ls-files', '--', ...OLD_DIRS).split('\n').filter(Boolean);
const untracked = git('ls-files', '-o', '--exclude-standard', '--', ...OLD_DIRS).split('\n').filter(Boolean);
for (const f of untracked) fail(`untracked file under an old directory (commit or remove it first): ${f}`);

/** old path (relative to the package) → new path. Only what exists now. */
const MOVES = new Map<string, string>();
for (const old of tracked) {
  const to = destinationOf(old);
  if (!to) fail(`no rule places ${old} — add one to RULES`);
  else MOVES.set(old, to);
}
const byTarget = new Map<string, string>();
for (const [old, to] of MOVES) {
  if (byTarget.has(to)) fail(`${old} and ${byTarget.get(to)} would both become ${to}`);
  byTarget.set(to, old);
  if (existsSync(join(APP, to))) fail(`${to} already exists; ${old} would overwrite it`);
}
// A platform pair resolves as one module; it cannot live in two directories.
for (const [old, to] of MOVES) {
  const m = /^(.*)\.(web|native|ios|android)\.(tsx?)$/.exec(old);
  if (!m) continue;
  for (const base of [`${m[1]}.tsx`, `${m[1]}.ts`]) {
    const baseTo = MOVES.get(base);
    if (baseTo && posix.dirname(baseTo) !== posix.dirname(to)) {
      fail(`platform pair split: ${base} → ${baseTo} but ${old} → ${to}`);
    }
  }
}
bail();

// ── resolution against the layout as it was ─────────────────────────────────

/** Every file of the package as it was before this run, relative to it. */
const BEFORE = new Set(git('ls-files').split('\n').filter(Boolean));
const existedBefore = (p: string) => BEFORE.has(p) || (!MOVES.has(p) && isFile(join(APP, p)));
const TRIES = [
  '', '.ts', '.tsx', '.web.ts', '.web.tsx', '.native.ts', '.native.tsx', '.js', '.jsx', '.json',
  '/index.ts', '/index.tsx', '/index.js',
];

/** Resolves an absolute old-layout path to `[file relative to APP or absolute, appended tail]`. */
function resolveOld(abs: string): { file: string; tail: string } | undefined {
  const inside = !relative(APP, abs).startsWith('..');
  for (const tail of TRIES) {
    const cand = abs + tail;
    if (inside ? existedBefore(relApp(cand)) : isFile(cand)) {
      return { file: inside ? relApp(cand) : cand, tail };
    }
  }
  return undefined;
}

const newPathOf = (appRel: string) => MOVES.get(appRel) ?? appRel;

/**
 * The new spelling of `spec`, written in `fileOld` (now at `fileNew`), both
 * relative to APP. `strict` = it is a module specifier, so it may be written
 * `@/…` and must resolve. `undefined` = leave it; `null` = unresolvable.
 */
function rewrite(spec: string, fileOld: string, fileNew: string, strict: boolean): string | undefined | null {
  let abs: string;
  if (spec.startsWith('@/')) {
    const rest = spec.slice(2);
    // Already the new layout: the alias now means `src/`.
    if (/^(features|shared|shell)\//.test(rest)) return undefined;
    abs = join(APP, rest);
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    abs = resolve(APP, dirname(fileOld), spec);
  } else {
    return undefined;
  }
  const hit = resolveOld(abs);
  if (!hit) return strict ? null : undefined;
  const moved = !hit.file.startsWith('/') && MOVES.has(hit.file);
  if (!moved && fileOld === fileNew && !spec.startsWith('@/')) return undefined; // nothing moved on either end
  const targetNew = hit.file.startsWith('/') ? hit.file : join(APP, newPathOf(hit.file));
  const cut = (p: string) => (hit.tail && p.endsWith(hit.tail) ? p.slice(0, -hit.tail.length) : p);
  // A rename (types.ts → automations.ts) keeps its extension, so the tail still cuts.
  const targetSpec = cut(toPosix(targetNew));
  const underSrc = toPosix(relative(join(APP, 'src'), targetNew));
  if (spec.startsWith('./') || spec.startsWith('../')) {
    let rel = toPosix(relative(join(APP, dirname(fileNew)), targetSpec));
    if (!rel.startsWith('.')) rel = `./${rel}`;
    if (rel === spec) return undefined;
  }
  // Only a module specifier can use the alias; a path string is read by `fs`.
  if (strict && !underSrc.startsWith('..')) return `@/${cut(underSrc)}`;
  let rel = toPosix(relative(join(APP, dirname(fileNew)), targetSpec));
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel === spec ? undefined : rel;
}

// ── pass 2: rewrite specifiers ──────────────────────────────────────────────

const VI = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock']);

function specifierEdits(text: string, fileOld: string, fileNew: string, abs: string) {
  const kind = abs.endsWith('x') ? ts.ScriptKind.TSX : abs.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, kind);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const consider = (lit: ts.StringLiteralLike, strict: boolean) => {
    const out = rewrite(lit.text, fileOld, fileNew, strict);
    if (out === null) fail(`${relApp(abs)}: cannot resolve '${lit.text}'`);
    else if (out !== undefined) edits.push({ start: lit.getStart(sf) + 1, end: lit.getEnd() - 1, text: out });
  };
  const seen = new Set<ts.Node>();
  const visit = (node: ts.Node) => {
    let spec: ts.Expression | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      spec = node.moduleSpecifier;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      spec = node.argument.literal;
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isVi =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'vi' &&
        VI.has(callee.name.text);
      if (isImport || isRequire || isVi) spec = node.arguments[0];
    }
    if (spec && ts.isStringLiteralLike(spec)) {
      seen.add(spec);
      consider(spec, true);
    }
    // Any other relative string that names a file by its extension.
    if (ts.isStringLiteralLike(node) && !seen.has(node) && /^\.\.?\/.*\.\w+$/.test(node.text)) {
      consider(node, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return edits;
}

const apply = (text: string, edits: Array<{ start: number; end: number; text: string }>) =>
  edits
    .sort((a, b) => b.start - a.start)
    .reduce((acc, e) => acc.slice(0, e.start) + e.text + acc.slice(e.end), text);

// ── pass 3 (text): file paths written in prose ──────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Prose names files by where they were. The moves of this run say where that
 * is; on a tree already moved there are none, so `--from=<rev>` reads the old
 * file list from a commit before the move instead (for prose only — nothing is
 * moved from it).
 */
const fromArg = args.find((a) => a.startsWith('--from='));
const PROSE = new Map(MOVES);
if (fromArg) {
  const listed = git('ls-tree', '-r', '--name-only', '--full-name', fromArg.slice('--from='.length), '--', ...OLD_DIRS);
  for (const full of listed.split('\n').filter(Boolean)) {
    const old = toPosix(relative(APP, join(REPO, full)));
    const to = destinationOf(old);
    if (to) PROSE.set(old, to);
  }
}
const OLD_PATHS = [...PROSE.keys()].sort((a, b) => b.length - a.length);
const PREFIXED = OLD_PATHS.length
  ? new RegExp(`packages/app/(${OLD_PATHS.map(escapeRe).join('|')})(?![\\w.-])`, 'g')
  : undefined;
const BARE = OLD_PATHS.length
  ? new RegExp(`(?<![\\w./@-])(${OLD_PATHS.map(escapeRe).join('|')})(?![\\w.-])`, 'g')
  : undefined;
function proseEdits(text: string, bare: boolean): string {
  if (!PREFIXED || !BARE) return text;
  let out = text.replace(PREFIXED, (_m, p: string) => `packages/app/${PROSE.get(p)}`);
  if (bare) out = out.replace(BARE, (_m, p: string) => PROSE.get(p)!);
  return out;
}

// ── run ─────────────────────────────────────────────────────────────────────

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
// This file names the old layout on purpose, in RULES.
const SELF = relApp(import.meta.filename);
const appFiles = [...BEFORE].filter((f) => CODE.test(f) && !f.endsWith('.d.ts') && f !== SELF);
const planned = new Map<string, string>(); // new path (relative to APP) → content
if (SCOPE.has('app')) {
  for (const fileOld of appFiles) {
    const fileNew = newPathOf(fileOld);
    const abs = join(APP, fileOld);
    if (!isFile(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const next = proseEdits(apply(text, specifierEdits(text, fileOld, fileNew, abs)), true);
    if (next !== text) planned.set(fileNew, next);
  }
  // Prose in the package's non-code text files (README, css, json manifests).
  for (const f of BEFORE) {
    if (CODE.test(f) || !/\.(md|mdx|css|json|txt)$/.test(f) || f.includes('/locales/')) continue;
    const abs = join(APP, f);
    if (!isFile(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const next = proseEdits(text, true);
    if (next !== text) planned.set(newPathOf(f), next);
  }
}
bail();

const outside: Array<[string, string]> = [];
if (SCOPE.has('repo') || SCOPE.has('docs')) {
  const all = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n')
    .filter((f) => f && !f.startsWith('packages/app/') && /\.(ts|tsx|js|mjs|cjs|md|mdx|json|ya?ml|txt)$/.test(f))
    .filter((f) => !/(^|\/)(bun\.lock|package-lock\.json)$/.test(f))
    // Dated plans and specs record the tree as it was when they were written.
    .filter((f) => !f.startsWith('docs/superpowers/'));
  for (const f of all) {
    const isDoc = f.startsWith('docs/');
    if (isDoc ? !SCOPE.has('docs') : !SCOPE.has('repo')) continue;
    const abs = join(REPO, f);
    if (!isFile(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const next = proseEdits(text, false);
    if (next !== text) outside.push([abs, next]);
  }
}

console.log(`${MOVES.size} file(s) to move, ${planned.size} package file(s) and ${outside.length} other file(s) to rewrite.`);
if (DRY) {
  for (const [a, b] of MOVES) console.log(`mv\t${a}\t${b}`);
  for (const f of planned.keys()) console.log(`edit\t${f}`);
  for (const [f] of outside) console.log(`edit\t${relative(REPO, f)}`);
  process.exit(0);
}

for (const [old, to] of MOVES) {
  execFileSync('mkdir', ['-p', dirname(join(APP, to))]);
  git('mv', old, to);
}
for (const [f, text] of planned) writeFileSync(join(APP, f), text);
for (const [f, text] of outside) writeFileSync(f, text);
console.log('done.');
