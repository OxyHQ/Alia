'use strict';

/**
 * Optional Metro-only resolver for Alia's chart imports. The regular SDK entries
 * and their Bloom peer remain unchanged. Each opted-in SDK copy carries the
 * exact importers and adapter it supports; an unknown copy fails explicitly.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SDK_ROOT = path.resolve(__dirname, '../..');
const LEGACY = '@oxy.so/bloom/chart-cards';
const GRANULAR = [`${LEGACY}/bar-list`, `${LEGACY}/line`];
const PREFIX = '[Alia granular charts]';
const WRAPPED = Symbol.for('@alia.onl/sdk/metro/granular-charts-resolver/v1');

function checkedFile(root, entry) {
  if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) {
    throw new Error(`${PREFIX} invalid SDK manifest entry`);
  }
  let actual;
  try {
    actual = fs.realpathSync(path.resolve(root, entry.path));
  } catch (error) {
    throw new Error(`${PREFIX} missing SDK file ${entry.path}`, { cause: error });
  }
  if (!actual.startsWith(`${root}${path.sep}`))
    throw new Error(`${PREFIX} SDK file escapes its package`);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(actual)).digest('hex');
  if (digest !== entry.sha256) throw new Error(`${PREFIX} changed SDK file ${entry.path}`);
  return actual;
}

function collectTargets(roots) {
  const targets = new Map();
  for (const input of roots) {
    let root, pkg, metadata;
    try {
      root = fs.realpathSync(input);
      pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      metadata = JSON.parse(
        fs.readFileSync(path.join(root, 'src/metro/chart-importers.json'), 'utf8'),
      );
    } catch (error) {
      throw new Error(`${PREFIX} SDK copy lacks opt-in metadata`, { cause: error });
    }
    if (
      pkg.name !== '@alia.onl/sdk' ||
      metadata.format !== 1 ||
      metadata.sdkVersion !== pkg.version ||
      !Array.isArray(metadata.importers) ||
      metadata.importers.length !== 2
    ) {
      throw new Error(`${PREFIX} unsupported SDK copy or version`);
    }
    const adapter = checkedFile(root, metadata.adapter);
    for (const importer of metadata.importers) {
      const target = { root, adapter };
      targets.set(checkedFile(root, importer), target);
      targets.set(path.resolve(root, importer.path), target);
      targets.set(path.resolve(input, importer.path), target);
    }
  }
  return targets;
}

function sourceFile(resolution, name) {
  if (resolution?.type !== 'sourceFile' || typeof resolution.filePath !== 'string') {
    throw new Error(`${PREFIX} ${name} did not resolve to a source file`);
  }
  try {
    return fs.realpathSync(resolution.filePath);
  } catch (error) {
    throw new Error(`${PREFIX} ${name} resolved to a missing file`, { cause: error });
  }
}

function bloomRoot(file) {
  let dir = path.dirname(file);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      let pkg;
      try {
        pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      } catch (error) {
        throw new Error(`${PREFIX} invalid package manifest`, { cause: error });
      }
      if (pkg.name === '@oxy.so/bloom') return fs.realpathSync(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`${PREFIX} resolved file is not inside Bloom`);
    dir = parent;
  }
}

/** Resolve only explicit, file-valued exports with Metro's active conditions. */
function exportedFile(root, entry, context, platform, subpath) {
  const names = new Set([
    'default',
    context.isESMImport === true ? 'import' : 'require',
    ...(context.unstable_conditionNames ?? []),
    ...(context.unstable_conditionsByPlatform?.[platform] ?? []),
  ]);
  let target = entry;
  while (target && typeof target === 'object' && !Array.isArray(target)) {
    const key = Object.keys(target).find((condition) => names.has(condition));
    target = key === undefined ? null : target[key];
  }
  if (
    typeof target !== 'string' ||
    !target.startsWith('./') ||
    target.includes('\\') ||
    target.includes('*') ||
    target.split('/').some((segment) => segment === '..' || segment === 'node_modules')
  ) {
    throw new Error(`${PREFIX} ${subpath} has no supported export for ${platform}`);
  }
  try {
    const file = fs.realpathSync(path.resolve(root, target));
    if (!file.startsWith(`${root}${path.sep}`) || !fs.statSync(file).isFile())
      throw new Error('invalid target');
    return file;
  } catch (error) {
    throw new Error(`${PREFIX} ${subpath} export target is unavailable for ${platform}`, {
      cause: error,
    });
  }
}

/**
 * Wrap a finished Metro config. Only the two verified importers in each
 * explicitly opted-in SDK copy are redirected. Register other installed copies
 * through `additionalSdkRoots`; unregistered copies use their original path.
 * The app must install Bloom with both granular chart subpaths.
 *
 * @param {object} config Metro config, after the app's other resolver wrappers.
 * @param {{additionalSdkRoots?: string[]}} [options]
 * @returns {object} The same config, with its previous resolver preserved.
 */
function withAliaGranularCharts(config, options = {}) {
  if (!Array.isArray(options.additionalSdkRoots ?? []))
    throw new Error(`${PREFIX} additionalSdkRoots must be an array`);
  const previous = config.resolver?.resolveRequest;
  if (config[WRAPPED] || previous?.[WRAPPED]) {
    throw new Error(
      `${PREFIX} already configured; register all SDK copies with additionalSdkRoots in one call`,
    );
  }
  const targets = collectTargets([SDK_ROOT, ...(options.additionalSdkRoots ?? [])]);
  config.resolver ??= {};
  const delegate = (context, name, platform) =>
    previous ? previous(context, name, platform) : context.resolveRequest(context, name, platform);
  const wrapped = (context, name, platform) => {
    if (name !== LEGACY) return delegate(context, name, platform);
    const lexicalOrigin = path.resolve(context.originModulePath);
    const lexicalTarget = targets.get(lexicalOrigin);
    let origin;
    try {
      origin = fs.realpathSync(lexicalOrigin);
    } catch (error) {
      if (lexicalTarget) throw new Error(`${PREFIX} SDK importer is missing`, { cause: error });
      return delegate(context, name, platform);
    }
    const registered = lexicalTarget ?? targets.get(origin);
    if (!registered) return delegate(context, name, platform);
    const refreshed = collectTargets([registered.root]).get(origin);
    if (!refreshed || refreshed.adapter !== registered.adapter) {
      throw new Error(`${PREFIX} SDK targets changed; restart Metro`);
    }
    const adapter = refreshed.adapter;

    let legacy;
    try {
      legacy = sourceFile(delegate(context, LEGACY, platform), LEGACY);
    } catch (error) {
      throw new Error(`${PREFIX} the original Bloom chart barrel is unavailable for ${platform}`, {
        cause: error,
      });
    }
    const expectedBloom = bloomRoot(legacy);
    const bloom = JSON.parse(fs.readFileSync(path.join(expectedBloom, 'package.json'), 'utf8'));
    const adapterContext = { ...context, originModulePath: adapter };
    for (const subpath of GRANULAR) {
      const exported = `.${subpath.slice('@oxy.so/bloom'.length)}`;
      if (!bloom.exports || !Object.hasOwn(bloom.exports, exported)) {
        throw new Error(
          `${PREFIX} ${subpath} is not exported by this Bloom; install a compatible Bloom`,
        );
      }
      const publicTarget = exportedFile(
        expectedBloom,
        bloom.exports[exported],
        context,
        platform,
        subpath,
      );
      let originalTarget, adapterTarget;
      try {
        originalTarget = sourceFile(delegate(context, subpath, platform), subpath);
        adapterTarget = sourceFile(delegate(adapterContext, subpath, platform), subpath);
      } catch (error) {
        throw new Error(
          `${PREFIX} ${subpath} is unavailable for ${platform}; install a compatible Bloom`,
          { cause: error },
        );
      }
      if (originalTarget !== adapterTarget || bloomRoot(originalTarget) !== expectedBloom) {
        throw new Error(`${PREFIX} ${subpath} selects a different Bloom copy for ${platform}`);
      }
      if (originalTarget !== publicTarget) {
        throw new Error(
          `${PREFIX} ${subpath} did not resolve to its declared public export for ${platform}`,
        );
      }
    }
    const resolvedAdapter = sourceFile(delegate(context, adapter, platform), 'SDK chart adapter');
    if (resolvedAdapter !== adapter) throw new Error(`${PREFIX} SDK chart adapter was redirected`);
    return { type: 'sourceFile', filePath: adapter };
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  Object.defineProperty(config, WRAPPED, { value: true, enumerable: true });
  config.resolver.resolveRequest = wrapped;
  return config;
}
module.exports = { withAliaGranularCharts };
