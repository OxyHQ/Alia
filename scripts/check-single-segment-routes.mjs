/**
 * `/@pepe` must not have swallowed the rest of the app.
 *
 * The agent thread lives at `app/(app)/[username].tsx` — a DYNAMIC segment at
 * the top of the group, because Expo Router cannot mix static text with a
 * dynamic segment and so there is no `@[username].tsx`. The `@` rides inside the
 * parameter value.
 *
 * A dynamic segment at the top of a group matches EVERY single-segment path.
 * Twelve static routes and eight directories sit at that same level, and the
 * only thing keeping `/settings` out of an agent's profile is Expo Router
 * preferring a static route over a dynamic one — a preference in somebody
 * else's package, which is exactly the kind of thing to assert rather than
 * assume.
 *
 * ## It resolves paths through the REAL resolver
 *
 * The route tree comes from `expo-router`'s own `getRoutes` reading the real
 * `app` directory, the linking config from its own `getReactNavigationConfig`,
 * and the matching from its own forked `getStateFromPath` — the three functions
 * the running app uses, in that order. A gate that re-implemented the
 * precedence rule would be a gate on the re-implementation, and would agree with
 * itself forever.
 *
 * `getStateFromPath` reaches one barrel that pulls the whole navigation library
 * and, through it, React Native's Flow source, which Node cannot parse. It wants
 * a single function from there, `validatePathConfig`, so that one module is
 * stubbed with expo-router's OWN copy of it before the fork is loaded. Nothing
 * about the matching is replaced.
 *
 * ## The routes are DISCOVERED, not listed
 *
 * A list is a claim about the app at the moment somebody typed it: a route added
 * next month would not be in it, and this would keep passing while the new route
 * resolved to an agent's profile. Every path the group DECLARES is read out of
 * the linking config instead — expo-router's own patterns, not a derivation of
 * them — so every route has to survive, including the ones nobody remembered.
 *
 * Declared, not "one path per directory": `/c`, `/invite` and `/org-invite` are
 * directories holding nothing but a dynamic child, so those bare paths were
 * never routes and never resolved anywhere. Asserting on them was this gate's
 * first version, and it reported three failures that were not failures.
 *
 * ## What turns it red, measured rather than assumed
 *
 * Each of these was run against this file before it was committed:
 *
 *  - a SECOND dynamic route beside `[username]` — red, and the one that matters,
 *    because the loser of that pair is unreachable and which one loses is not a
 *    decision anybody makes;
 *  - `[username]` deleted, or moved back under a static segment — red;
 *  - a declared route resolving into `[username]` — red, one line per route.
 *
 * And what does NOT: **deleting a static route is green**, deliberately. A route
 * that no longer exists stops being declared, so there is nothing left to assert
 * about it — and `/library` answering "not found" through the agent profile
 * rather than through `+not-found` is the same answer from a different page.
 *
 * The remaining risk is Expo Router changing its precedence rule under an
 * upgrade, which would fail every one of the forty-one checks at once. That one
 * is asserted, not demonstrated: simulating it means patching somebody else's
 * resolver, and a simulation of a resolver proves nothing about the resolver.
 *
 * ## And it proves, on every run, that it can still fail
 *
 * "`/settings` resolves to `settings`" would also pass if the resolver had
 * stopped being able to swallow anything at all. So the last check removes one
 * static route from a COPY of the tree and REQUIRES that its path then lands on
 * `[username]` — the swallow, performed on purpose. A run that prints OK has
 * just demonstrated it can still print something else.
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(root, 'packages/app/app');

const require = createRequire(join(root, 'packages/app/package.json'));

/**
 * Give the forked matcher the one function it wants from a barrel that cannot
 * be loaded outside Metro, using expo-router's own implementation of it.
 */
const NATIVE_BARREL = require.resolve('expo-router/build/react-navigation/native');
require.cache[NATIVE_BARREL] = {
  id: NATIVE_BARREL,
  filename: NATIVE_BARREL,
  loaded: true,
  exports: require('expo-router/build/react-navigation/core/validatePathConfig'),
};

const { getRoutes } = require('expo-router/build/getRoutes');
const { getReactNavigationConfig } = require('expo-router/build/getReactNavigationConfig');
const { getStateFromPath } = require('expo-router/build/fork/getStateFromPath');

/** Every route module under `app/`, as the keys a `require.context` hands over. */
function routeKeys(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...routeKeys(path));
    else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) found.push(`./${relative(APP_DIR, path)}`);
  }
  return found;
}

/**
 * The linking config for a set of route files.
 *
 * `internal_stripLoadRoute` keeps the tree from importing a screen — and
 * everything a screen imports — so the context is only ever asked for its keys.
 */
function linkingConfig(keys) {
  const context = () => ({ default: () => null });
  context.keys = () => [...keys];
  context.resolve = (id) => id;
  context.id = 'app';

  const tree = getRoutes(context, {
    internal_stripLoadRoute: true,
    skipGenerated: true,
    platform: 'web',
    getSystemRoute: ({ route, type }) => ({
      type: type ?? 'route',
      loadRoute: () => ({ default: () => null }),
      route: route ?? '',
      contextKey: `./${route || 'index'}.js`,
      children: [],
      dynamic: null,
    }),
  });
  if (tree === null) return null;
  return getReactNavigationConfig(tree, true);
}

/** The chain of route names a path lands on, outermost first. */
function resolveRoute(path, config) {
  let level;
  try {
    level = getStateFromPath(path, config);
  } catch {
    return ['THREW'];
  }
  const names = [];
  while (level?.routes?.length) {
    const route = level.routes[level.routes.length - 1];
    names.push(route.name);
    level = route.state;
  }
  return names.length > 0 ? names : ['NO MATCH'];
}

const DYNAMIC = '[username]';
const failures = [];

const keys = routeKeys(APP_DIR);
const config = linkingConfig(keys);

if (config === null || keys.length === 0) {
  console.error('check-single-segment-routes: built no route tree from packages/app/app.');
  console.error('  The walk or expo-router stopped answering, so this gate is measuring nothing.');
  process.exit(1);
}

/** Every path the group declares, flattened out of the linking config. */
function declaredPaths(screens, prefix = '') {
  const paths = [];
  for (const [name, value] of Object.entries(screens)) {
    if (typeof value === 'string') {
      paths.push({ name, pattern: [prefix, value].filter(Boolean).join('/') });
    } else {
      paths.push(...declaredPaths(value.screens, [prefix, value.path].filter(Boolean).join('/')));
    }
  }
  return paths;
}

/** A concrete URL for a pattern: every parameter filled with something inert. */
function concrete(pattern) {
  return `/${pattern.split('/').map((s) => (s.startsWith(':') || s.startsWith('*') ? 'probe' : s)).filter(Boolean).join('/')}`;
}

const groupScreens = config.screens?.['(app)'];
if (typeof groupScreens !== 'object' || groupScreens === null) {
  console.error('check-single-segment-routes: the (app) group is not in the linking config.');
  console.error('  The group was renamed or moved, so this gate is measuring nothing.');
  process.exit(1);
}

const declared = declaredPaths(groupScreens.screens);
const others = declared.filter((route) => route.name !== DYNAMIC);

if (others.length < 20) {
  console.error(`check-single-segment-routes: only ${String(others.length)} routes beside the dynamic one.`);
  console.error('  The group moved or was renamed, so this gate is measuring nothing.');
  process.exit(1);
}

/**
 * The dynamic route has to exist, and be the ONLY one of its kind here.
 *
 * Two of them at the same level is ambiguity the resolver settles by an order
 * nobody chose: one wins every bare path and the other is unreachable, silently.
 * It is checked before anything else because a missing or duplicated dynamic
 * route makes every result below mean something different.
 */
const bareDynamics = declared.filter((route) => /^:[^/]*$/.test(route.pattern));
if (bareDynamics.length !== 1 || bareDynamics[0].name !== DYNAMIC) {
  console.error('check-single-segment-routes: the group root does not hold exactly one dynamic route.');
  console.error('');
  console.error(`  found: ${bareDynamics.map((r) => r.name).join(', ') || '(none)'} — expected only ${DYNAMIC}.`);
  console.error('');
  console.error(
    '  One dynamic route at the root of a group matches every single-segment path.\n' +
      '  A second one is unreachable, and which of the two loses is not a decision\n' +
      '  anybody made. Nest it under a static segment instead.'
  );
  process.exit(1);
}

for (const route of others) {
  const path = concrete(route.pattern);
  const chain = resolveRoute(path, config);
  if (chain.includes(DYNAMIC)) {
    failures.push(`${path} (${route.name}) resolves to ${chain.join(' > ')} — the agent profile swallowed it.`);
  }
}

/** And the route this all exists for still works, sigil and all. */
for (const path of ['/@pepe', '/pepe']) {
  const chain = resolveRoute(path, config);
  if (!chain.includes(DYNAMIC)) {
    failures.push(`${path} resolves to ${chain.join(' > ')} — it should reach the agent profile.`);
  }
}

/**
 * The control, run on every invocation rather than written in a comment.
 *
 * Every check above passes when the dynamic route swallows NOTHING — and would
 * also pass if the resolver had stopped being able to swallow anything at all,
 * or if this file had stopped resolving what it thinks it resolves. So one
 * static route is removed from a COPY of the tree, and its path is required to
 * fall onto the dynamic one. That is the swallow this gate exists to detect,
 * performed deliberately, so a run that reports "OK" has just demonstrated it
 * can still say otherwise.
 */
const sacrificed = 'settings';
const withoutOne = keys.filter((key) => !key.startsWith(`./(app)/${sacrificed}`));
const controlChain = resolveRoute(`/${sacrificed}`, linkingConfig(withoutOne));
if (!controlChain.includes(DYNAMIC)) {
  console.error('check-single-segment-routes: the control did not fire, so nothing above is trustworthy.');
  console.error('');
  console.error(
    `  With ./(app)/${sacrificed}.tsx removed, /${sacrificed} resolves to ` +
      `${controlChain.join(' > ')} rather than ${DYNAMIC}.`
  );
  console.error('');
  console.error('  Removing a route it claims MUST hand that path to the dynamic route. That it');
  console.error('  did not means this gate can no longer tell a swallowed route from a kept one —');
  console.error('  fix the gate before trusting the green it would otherwise print.');
  process.exit(1);
}

if (failures.length > 0) {
  console.error('check-single-segment-routes: a route no longer resolves to itself.');
  console.error('');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('');
  console.error(
    '  `app/(app)/[username].tsx` matches every single-segment path that no static\n' +
      '  route claims. Restore the route, or move the agent profile off the group root.'
  );
  process.exit(1);
}

console.log(
  `check-single-segment-routes: OK — ${String(others.length)} declared routes resolve past ` +
    `${DYNAMIC}, /@pepe and /pepe reach it, and removing /${sacrificed} moves it there.`
);
