import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Message content does not reach ordinary request logs — epic #139 workstream 15,
 * *"Do not log prompts, images, audio or model outputs in ordinary request logs."*
 *
 * ## Why this is a census and not a runtime redactor
 *
 * `lib/logger.ts` scrubs CREDENTIALS out of everything it serializes (#150). It
 * cannot do the same for content, and the reason is worth stating because the
 * obvious fix is the wrong one: a credential has a SHAPE a scrubber can
 * recognise, and a prompt does not. A name-keyed runtime redactor would have to
 * blank `text`, `content`, `query` and `data` everywhere, which deletes
 * `image` (a Docker tag), `value` (an env var) and `message` (an upstream
 * receipt error) along with them — and the cheapest way to make a log line pass
 * it would be to RENAME the field, which is worse than the line it replaced,
 * because the rename hides the content from the reviewer too.
 *
 * So the control is a review trigger: a content-shaped key in a log call is a
 * line somebody has to justify, and the justification lives in the frozen list
 * below. It is checked against the only thing that cannot disagree with what
 * ships — the parsed source of every tracked file in the package.
 *
 * **There is no runtime net behind this.** `LOGGER_REDACT_PATHS_ARE_CREDENTIALS_ONLY`
 * below proves it rather than asserting it, so nobody reads this file as
 * belt-and-braces.
 *
 * ## The measurement that produced the frozen list
 *
 * On `main` at `a1b74a6b` this census found **39** content-shaped properties
 * across 1027 logger calls. Twenty-nine were real: the first 100 characters of
 * every inbound Telegram/WhatsApp message at `info`
 * (`routes/webhooks.ts`), the raw upstream SSE payload at `warn`
 * (`lib/sse-stream.ts`), voice tool arguments at `info`
 * (`voice-session-manager.ts`), the whole unrecognised stream chunk at `warn`
 * (`lib/chat/stream-runner.ts`), 500-character previews of every tool call and
 * tool result at `debug`, search queries, conversation titles, and 50
 * characters of whatever the browser agent types into a page. Production runs at
 * `info` by default (`lib/logger.ts`: `LOG_LEVEL || (isDev ? 'debug' : 'info')`),
 * so four of those shipped every request and the rest were one environment
 * variable away. All twenty-nine were removed in the same commit as this file.
 *
 * ## The second measurement, and why the key list is the fragile part
 *
 * The list below is the whole reach of this file, and a key it does not name is
 * a leak it reports as absence. Four such keys were found by re-deriving the
 * census from scratch (#139 ws19) and reading every distinct property name the
 * package logs rather than only the ones already listed:
 *
 *  - `reasoning` — 100 characters of the model's chain of thought, twice, in
 *    `lib/chat/stream-runner.ts`;
 *  - `responseText` — the WHOLE model output at `error`, three times, on the
 *    JSON-parse failure path of the agent, skill and suggestion generators;
 *  - `userContext` — the user's own memories, preferences and writing style, at
 *    `info`, in `services/chat.service.ts`;
 *  - `task` — the task text handed to a multi-agent run, at `info`, twice.
 *
 * All nine call sites shipped, all nine were emitting at or below the default
 * production level, and this file was green throughout. That is what a guard
 * measuring nothing looks like from the inside, and it is the reason the key
 * list is deliberately BROAD and narrowed by exemptions rather than the other
 * way round.
 *
 * ## The cheapest way to make this green
 *
 * Add a triple to {@link ALLOWED}. That is a reviewed diff in a file whose
 * subject is what may be logged, which is the point. The list is an EXACT
 * equality, not a superset check, so a stale entry fails too — an exemption
 * cannot outlive the line it excuses.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const SELF = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));
const PACKAGE_PREFIX = 'packages/api/src';

const LEVELS: ReadonlySet<string> = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/**
 * Keys that name message content.
 *
 * Chosen to be BROAD and then narrowed by the exemption list, rather than narrow
 * and quietly blind: `image` is a Docker tag four times in this package and a
 * user's uploaded picture nowhere, and the right way to record that is an
 * exemption a reader can see, not an absent word a reader cannot.
 */
const CONTENT_KEYS: readonly string[] = [
  'answer',
  'args',
  'arguments',
  'audio',
  'base64',
  'body',
  'chunk',
  'completion',
  'content',
  'contents',
  'data',
  'dataUrl',
  'delta',
  'description',
  'image',
  'imageUrl',
  'images',
  'input',
  'inputs',
  'instructions',
  'message',
  'messages',
  'output',
  'outputs',
  'payload',
  'prompt',
  'prompts',
  'query',
  'question',
  'reasoning',
  'reply',
  'response',
  'responseText',
  'result',
  'results',
  'summary',
  'systemPrompt',
  'task',
  'text',
  'title',
  'toolArgs',
  'toolResult',
  'transcript',
  'userContext',
  'value',
];

/** Identifiers that hold a thrown value. Logging one outside `err` skips #150. */
const ERROR_IDENTIFIERS: ReadonlySet<string> = new Set(['err', 'error', 'e', 'cause', 'thrown', 'caught']);

/* -------------------------------------------------------------------------- */
/*  The scanner                                                                */
/* -------------------------------------------------------------------------- */

interface LoggedProperty {
  readonly file: string;
  readonly key: string;
  /** The initializer's source text, whitespace-collapsed. */
  readonly value: string;
}

interface LoggerCall {
  readonly file: string;
  readonly properties: readonly LoggedProperty[];
  /** True when the first argument spreads something whose keys are not visible here. */
  readonly spreads: boolean;
}

/** The identifier a property-access chain bottoms out at: `log.v1.info` -> `log`. */
function rootIdentifier(expression: ts.Expression): string | null {
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : null;
}

/**
 * Whether a call is a pino level call on a logger.
 *
 * Matched on the ROOT identifier rather than on an import, so the three spellings
 * this package actually uses — `log.<subsystem>.<level>` from `lib/logger.ts`,
 * a `createLogger()` result held in a `…Log` const, and a bare `logger` — are all
 * seen. A logger stored under a name matching none of these is the census's
 * blind spot, which is why `logger roots` is asserted below.
 */
function isLoggerLevelCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (!LEVELS.has(node.expression.name.text)) return false;
  const root = rootIdentifier(node.expression.expression);
  return root !== null && /^(log|logger)$|[lL]og(ger)?$/.test(root);
}

function collectCalls(file: string, source: ts.SourceFile): LoggerCall[] {
  const out: LoggerCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isLoggerLevelCall(node)) {
      const first = node.arguments[0];
      const properties: LoggedProperty[] = [];
      let spreads = false;
      if (first !== undefined && ts.isObjectLiteralExpression(first)) {
        for (const property of first.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            properties.push({ file, key: property.name.text, value: property.name.text });
          } else if (
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          ) {
            properties.push({
              file,
              key: property.name.text,
              value: property.initializer.getText(source).replace(/\s+/g, ' '),
            });
          } else if (ts.isSpreadAssignment(property)) {
            spreads = true;
          }
        }
      }
      out.push({ file, properties, spreads });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * `git ls-files` rather than a directory walk, for the same reason
 * `inference/__tests__/relay-boundary.test.ts` uses it: it reports the INDEX, so
 * it cannot disagree with what git tracks.
 *
 * Its blind spot is the same one too — an UNTRACKED file is invisible and reads
 * as absence. A local green therefore says less than a CI green, and a probe
 * used to mutation-test this file must be `git add -f`ed before it counts.
 *
 * `__tests__` is excluded because the subject is what a SERVING process writes:
 * a fixture prompt inside a test never reaches a request log. The exclusion is
 * measured rather than assumed — see the scope assertion below.
 */
function trackedSources(): { readonly file: string; readonly source: ts.SourceFile }[] {
  return execFileSync('git', ['ls-files', '--', PACKAGE_PREFIX], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.endsWith('.ts') && !file.includes('/__tests__/') && file !== SELF)
    .map((file) => ({
      file,
      source: ts.createSourceFile(
        file,
        readFileSync(path.join(REPO_ROOT, file), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      ),
    }));
}

const sources = trackedSources();
const calls = sources.flatMap(({ file, source }) => collectCalls(file, source));
const properties = calls.flatMap((call) => call.properties);

/** One offender line: file, key and the expression that produced the value. */
const triple = (property: LoggedProperty): string =>
  `${property.file} | ${property.key} | ${property.value}`;

/* -------------------------------------------------------------------------- */
/*  The scanner's own controls                                                 */
/* -------------------------------------------------------------------------- */

describe('the census reads what it claims to read', () => {
  const parse = (text: string): ts.SourceFile =>
    ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true);

  it('finds every logger spelling this package uses, and no commented-out one', () => {
    expect(collectCalls('p', parse(`log.v1.info({ prompt }, 'x');`))).toHaveLength(1);
    expect(collectCalls('p', parse(`obsLog.warn({ prompt }, 'x');`))).toHaveLength(1);
    expect(collectCalls('p', parse(`logger.error({ prompt }, 'x');`))).toHaveLength(1);
    expect(collectCalls('p', parse(`log.chat.debug({ prompt: body.messages }, 'x');`))).toHaveLength(1);
    // The AST sees no comment, so this file's own prose naming `prompt` and
    // `messages` cannot inflate the count. grep is line-based and would.
    expect(collectCalls('p', parse(`// log.v1.info({ prompt }, 'x');\nconst a = 1;`))).toEqual([]);
    expect(collectCalls('p', parse(`/* log.v1.info({ prompt }, 'x'); */\nconst a = 1;`))).toEqual([]);
    // Not a logger: a same-named method on something else must not be counted,
    // or the exemption list fills up with lines that were never log calls.
    expect(collectCalls('p', parse(`emitter.info({ prompt }, 'x');`))).toEqual([]);
  });

  it('reads both property spellings and records the value expression', () => {
    const found = collectCalls('p', parse(`log.v1.info({ a, 'b': x.y, c: z.slice(0, 10) }, 'm');`));
    expect(found[0].properties.map(triple)).toEqual([
      'p | a | a',
      'p | b | x.y',
      'p | c | z.slice(0, 10)',
    ]);
  });

  it('scanned the whole package, so an empty offender list means absence', () => {
    // Every floor here is a vacuity guard: a wrong prefix, an empty index or a
    // failed parse produces the same clean result as a package with no leaks.
    expect(sources.length).toBeGreaterThan(400);
    expect(calls.length).toBeGreaterThan(900);
    expect(properties.length).toBeGreaterThan(1_500);
    expect(sources.map((entry) => entry.file)).toContain(`${PACKAGE_PREFIX}/lib/chat/stream-runner.ts`);
  });

  it('excluded tests only, and the exclusion removed something', () => {
    const all = execFileSync('git', ['ls-files', '--', PACKAGE_PREFIX], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((file) => file.endsWith('.ts'));
    const excluded = all.filter((file) => file.includes('/__tests__/'));
    // Non-zero, or "we excluded tests" is a claim about nothing.
    expect(excluded.length).toBeGreaterThan(30);
    // This file is itself a test, so `SELF` is already inside `excluded` and the
    // subtraction must not double-count it. Asserted rather than assumed,
    // because moving this file out of `__tests__` would make the census skip a
    // shipped module and nothing else would notice.
    expect(excluded).toContain(SELF);
    expect(all.length - excluded.length).toBe(sources.length);
  });
});

/* -------------------------------------------------------------------------- */
/*  Content-shaped properties                                                  */
/* -------------------------------------------------------------------------- */

describe('no logger call carries message content (#139 ws15)', () => {
  /**
   * Every content-shaped property that ships, with the reason it is not content.
   *
   * A triple rather than a `file:line`: a line number churns on every edit above
   * it, and a file-and-key pair would let a genuinely new `{ text: userPrompt }`
   * hide behind an existing `{ text: someLabel }` in the same file. The value
   * expression is what distinguishes them.
   *
   *  - `container-pool` — `image` is a Docker image tag, four times.
   *  - `crowdsource/config` — the unrecognised value of an env var, echoed so an
   *    operator can see what they typed. Bounded, not user data.
   *  - `notification-service` — the Expo push receipt's own error message.
   *  - `log-observer` — `metric.value` is a `number` by `ObserverMetric`.
   *  - `bots` — Telegram's `setWebhook` error description, from their API.
   */
  const ALLOWED: readonly string[] = [
    `${PACKAGE_PREFIX}/lib/crowdsource/config.ts | value | candidate`,
    `${PACKAGE_PREFIX}/lib/notification-service.ts | message | message`,
    `${PACKAGE_PREFIX}/lib/observability/log-observer.ts | value | metric.value`,
    `${PACKAGE_PREFIX}/lib/sandbox/container-pool.ts | image | image`,
    `${PACKAGE_PREFIX}/lib/sandbox/container-pool.ts | images | this.config.warmImages`,
    `${PACKAGE_PREFIX}/routes/bots.ts | description | swData.description`,
  ];

  const contentKeys = new Set(CONTENT_KEYS);
  const found = [...new Set(properties.filter((p) => contentKeys.has(p.key)).map(triple))].sort();

  it('carries only the content-shaped properties that are not content', () => {
    expect(found).toEqual([...ALLOWED].sort());
  });

  it('found some, so the equality above is not two empty lists', () => {
    // The failure this guards against: a scan that read nothing agrees with an
    // exemption list that has been emptied, and both look like success.
    expect(found.length).toBeGreaterThanOrEqual(6);
  });

  it('the key list itself cannot silently shrink', () => {
    /**
     * A key with no offenders left is a key nothing defends.
     *
     * Measured: deleting `userContext` from {@link CONTENT_KEYS} failed NOTHING
     * before this assertion existed. The equality above compares offenders to
     * exemptions, and once a leak is fixed there is no offender behind its key —
     * so the key can be removed, and the next `{ userContext: … }` sails past a
     * green census. That is the failure this whole file is about, one level up:
     * the control that measures the code has no control measuring it.
     *
     * An exact count plus the names, rather than the whole list restated: the
     * list is MEANT to grow, and freezing it would make every addition a
     * two-place edit. What must not happen silently is a REMOVAL, and a count
     * catches that whichever key goes. The four named ones are called out
     * because they are the ones with no offender left to notice their absence.
     */
    expect(CONTENT_KEYS).toHaveLength(45);
    expect(new Set(CONTENT_KEYS).size).toBe(CONTENT_KEYS.length);
    for (const key of ['reasoning', 'responseText', 'task', 'userContext']) {
      expect(CONTENT_KEYS, `${key} was dropped from the key list`).toContain(key);
    }
  });

  it('the key list can actually fire, on every key in it', () => {
    // A positive control per key, in the same currency as the measurement: if
    // `CONTENT_KEYS` were misspelled or the property reader broke, this fails
    // before the census reports its comfortable zero.
    for (const key of CONTENT_KEYS) {
      const probe = collectCalls('probe.ts', ts.createSourceFile(
        'probe.ts',
        `log.v1.info({ ${key}: somethingSensitive }, 'm');`,
        ts.ScriptTarget.Latest,
        true,
      ));
      const hits = probe.flatMap((call) => call.properties).filter((p) => contentKeys.has(p.key));
      expect(hits.map((p) => p.key), `${key} is not detectable`).toEqual([key]);
    }
  });

  it('the four production leaks this file was written for are gone', () => {
    // Named, not merely covered by the equality above, because these are the
    // ones that were emitting on every request at the default level. If any
    // returns, it fails here with its own name attached.
    const text = (file: string): string => readFileSync(path.join(REPO_ROOT, PACKAGE_PREFIX, file), 'utf8');
    expect(text('routes/webhooks.ts')).not.toContain('text: message.text.slice');
    expect(text('lib/sse-stream.ts')).not.toContain("warn({ data }");
    expect(text('internal/providers/lib/voice-session-manager.ts')).not.toContain('toolName: fc.name, args,');
    expect(text('lib/chat/stream-runner.ts')).not.toContain('chunkType: chunk.type, chunk }');
    // The floor: the reads found real files, so four absences are absences.
    expect(text('routes/webhooks.ts')).toContain('Inbound message');
    expect(text('lib/sse-stream.ts')).toContain('Failed to parse SSE chunk');
    expect(text('internal/providers/lib/voice-session-manager.ts')).toContain('Executing voice tool');
    expect(text('lib/chat/stream-runner.ts')).toContain('Unhandled chunk type');
  });

  it('the nine leaks the second measurement found are gone', () => {
    // Named for the same reason the four above are: these were emitting at or
    // below the default production level while this file was green, and the
    // equality alone would let one back in under a key the list still does not
    // have. Each pair is an absence plus the floor that proves the file was
    // read.
    const text = (file: string): string => readFileSync(path.join(REPO_ROOT, PACKAGE_PREFIX, file), 'utf8');

    expect(text('lib/chat/stream-runner.ts')).not.toContain('reasoning: content.slice');
    expect(text('lib/chat/stream-runner.ts')).not.toContain('reasoning: reasoningText.slice');
    expect(text('lib/chat/stream-runner.ts')).toContain('Reasoning chunk (provider)');

    expect(text('routes/agents/generate.ts')).not.toContain('{ responseText }');
    expect(text('routes/agents/generate.ts')).toContain('Failed to parse AI-generated agent config');
    expect(text('routes/skills.ts')).not.toContain('{ responseText }');
    expect(text('routes/skills.ts')).toContain('Failed to parse AI-generated skill config');
    expect(text('routes/suggestions.ts')).not.toContain('{ responseText }');
    expect(text('routes/suggestions.ts')).toContain('Failed to parse AI-generated suggestions');

    expect(text('services/chat.service.ts')).not.toContain('userContext: userContextParts');
    expect(text('services/chat.service.ts')).toContain('Personalization applied');

    expect(text('lib/tools/agent-orchestrator.ts')).not.toContain('task: task.slice');
    expect(text('lib/tools/agent-orchestrator.ts')).toContain('Multi-agent orchestration completed');
  });

  it('no debug-only payload preview survives', () => {
    // `previewForLog` emitted 500 characters of every tool call and every tool
    // result. It was reachable in production behind `LOG_LEVEL=debug` and on by
    // default in development, which is what makes "it is only debug" the wrong
    // reading — and it is also the whole of Alia's "debug payload capture", so
    // its absence is what makes that checkbox answerable.
    const offenders = sources
      .filter(({ source }) => source.text.includes('previewForLog'))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
    // The control: the file it lived in is still being read.
    expect(sources.map((entry) => entry.file)).toContain(`${PACKAGE_PREFIX}/lib/chat/stream-runner.ts`);
  });
});

/* -------------------------------------------------------------------------- */
/*  Spreads: the keys the census cannot see                                    */
/* -------------------------------------------------------------------------- */

describe('nothing spreads an unbounded object into a log', () => {
  /**
   * A spread hides its keys from every check above, so each one is frozen with
   * the type that bounds it.
   *
   *  - `log-observer` spreads `ObserverEvent` and `ObserverMetric.labels`
   *    (`lib/observability/types.ts`). That union is a closed set of scalars —
   *    `resultSizeChars`, not the result — which is the property asserted below.
   *  - `expirySweeper` spreads `{ truncated }`, a table-name array.
   */
  const FROZEN_SPREADERS: readonly string[] = [
    `${PACKAGE_PREFIX}/db/expirySweeper.ts`,
    `${PACKAGE_PREFIX}/lib/observability/log-observer.ts`,
  ];

  const spreaders = [...new Set(calls.filter((call) => call.spreads).map((call) => call.file))].sort();

  it('is exactly the two files whose spread is a closed type', () => {
    expect(spreaders).toEqual([...FROZEN_SPREADERS].sort());
  });

  it('the observability event union still carries sizes rather than payloads', () => {
    // What makes the `log-observer` exemption true rather than assumed. A field
    // added to `ObserverEvent` holding a tool result or a prompt would travel
    // through the spread invisibly, so the union's own text is checked here.
    const types = readFileSync(
      path.join(REPO_ROOT, PACKAGE_PREFIX, 'lib/observability/types.ts'),
      'utf8',
    );
    expect(types).toContain('resultSizeChars');
    for (const forbidden of ['prompt', 'messages', 'content:', 'output:', 'args', 'transcript']) {
      expect(types, `ObserverEvent gained ${forbidden}`).not.toContain(forbidden);
    }
    // The floor: the file was read and does contain the union.
    expect(types).toContain('export type ObserverEvent');
  });
});

/* -------------------------------------------------------------------------- */
/*  Errors reach the credential scrub                                          */
/* -------------------------------------------------------------------------- */

describe('a thrown value is logged as `err`, so #150 applies to it', () => {
  /**
   * pino's error serializer is keyed on the PROPERTY NAME, and `lib/logger.ts`
   * hangs its credential scrub off that serializer. An `Error` logged as
   * `{ data: err }` is therefore emitted with the scrub not applied — which is
   * exactly what `internal/providers/lib/alia-models.ts` did until the commit
   * that added this file, one property away from #150's chokepoint doing its
   * job.
   */
  const offenders = properties
    .filter((property) => property.key !== 'err' && ERROR_IDENTIFIERS.has(property.value))
    .map(triple)
    .sort();

  it('never puts one under another key', () => {
    expect(offenders).toEqual([]);
  });

  it('the check can fire', () => {
    const probe = collectCalls('probe.ts', ts.createSourceFile(
      'probe.ts',
      `log.v1.warn({ data: err }, 'm');\nlog.v1.warn({ err }, 'm');`,
      ts.ScriptTarget.Latest,
      true,
    ));
    const caught = probe
      .flatMap((call) => call.properties)
      .filter((property) => property.key !== 'err' && ERROR_IDENTIFIERS.has(property.value));
    expect(caught.map((property) => property.key)).toEqual(['data']);
  });
});

/* -------------------------------------------------------------------------- */
/*  There is no runtime net                                                    */
/* -------------------------------------------------------------------------- */

describe('the logger does not redact content, which is why the census is the control', () => {
  it('redacts credential paths and nothing content-shaped', async () => {
    // Read off the module rather than restated, so this cannot drift into a
    // comforting comment about a config it no longer describes.
    const loggerSource = readFileSync(
      path.join(REPO_ROOT, PACKAGE_PREFIX, 'lib/logger.ts'),
      'utf8',
    );
    const block = /const REDACT_PATHS = \[([\s\S]*?)\];/.exec(loggerSource);
    expect(block, 'REDACT_PATHS moved or was renamed').not.toBeNull();
    const paths = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);

    // The floor: the parse found the real list, not an empty match.
    expect(paths.length).toBeGreaterThanOrEqual(5);
    expect(paths).toContain('apiKey');

    const contentKeys = new Set<string>(CONTENT_KEYS);
    const contentPaths = paths.filter((entry) => contentKeys.has(entry.split('.').pop() ?? entry));
    expect(
      contentPaths,
      'a runtime content redactor appeared: rewrite this file, do not delete it',
    ).toEqual([]);

    // And the module still loads, so the claim is about the shipped logger.
    const logger = await import('../logger.js');
    expect(typeof logger.createLogger).toBe('function');
  });
});
