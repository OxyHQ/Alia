'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const source = path.resolve(__dirname, '../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-metro-test-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
let sequence = 0;

function fixture() {
  const root = path.join(temporary, String(sequence++));
  const sdk = path.join(root, 'sdk');
  const bloom = path.join(root, 'bloom');
  fs.mkdirSync(sdk, { recursive: true });
  const metadata = JSON.parse(fs.readFileSync(path.join(source, 'src/metro/chart-importers.json')));
  for (const file of [
    'package.json',
    'src/metro/index.cjs',
    'src/metro/chart-importers.json',
    metadata.adapter.path,
    ...metadata.importers.map((x) => x.path),
  ]) {
    const dest = path.join(sdk, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(source, file), dest);
  }
  fs.mkdirSync(bloom, { recursive: true });
  fs.writeFileSync(
    path.join(bloom, 'package.json'),
    JSON.stringify({
      name: '@oxy.so/bloom',
      exports: { './chart-cards/bar-list': './bar.js', './chart-cards/line': './line.js' },
    }),
  );
  for (const file of ['barrel.js', 'bar.js', 'line.js'])
    fs.writeFileSync(path.join(bloom, file), '');
  const importer = path.join(sdk, metadata.importers[0].path);
  const adapter = path.join(sdk, metadata.adapter.path);
  return {
    root,
    sdk,
    bloom,
    importer,
    adapter,
    metadata,
    helper: require(path.join(sdk, 'src/metro/index.cjs')),
  };
}

function resolver(f, override = () => undefined) {
  const calls = [];
  const previous = (context, name, platform) => {
    calls.push({ context, name, platform });
    const custom = override(context, name, platform);
    if (custom !== undefined) return custom;
    const names = {
      '@oxy.so/bloom/chart-cards': path.join(f.bloom, 'barrel.js'),
      '@oxy.so/bloom/chart-cards/bar-list': path.join(f.bloom, 'bar.js'),
      '@oxy.so/bloom/chart-cards/line': path.join(f.bloom, 'line.js'),
    };
    return { type: 'sourceFile', filePath: names[name] || name };
  };
  const config = { resolver: { resolveRequest: previous } };
  return { config, calls, previous };
}

for (const platform of ['web', 'android', 'ios']) {
  test(`${platform}: only selected importers redirect, preserving prior resolver`, () => {
    const f = fixture();
    const r = resolver(f);
    f.helper.withAliaGranularCharts(r.config);
    const context = { originModulePath: f.importer };
    const result = r.config.resolver.resolveRequest(context, '@oxy.so/bloom/chart-cards', platform);
    assert.equal(result.filePath, f.adapter);
    assert.equal(r.calls.length, 6);
    assert.ok(r.calls.every((call) => call.platform === platform));
    assert.ok(r.calls.some((call) => call.context.originModulePath === f.adapter));
    assert.equal(
      r.config.resolver.resolveRequest(context, 'unchanged', platform).filePath,
      'unchanged',
    );
    assert.equal(
      r.config.resolver.resolveRequest(
        { originModulePath: __filename },
        '@oxy.so/bloom/chart-cards',
        platform,
      ).filePath,
      path.join(f.bloom, 'barrel.js'),
    );
  });
  test(`${platform}: unavailable granular paths fail explicitly`, () => {
    const f = fixture();
    const r = resolver(f, (_, name) => {
      if (name.endsWith('/line')) throw new Error('not exported');
    });
    f.helper.withAliaGranularCharts(r.config);
    assert.throws(
      () =>
        r.config.resolver.resolveRequest(
          { originModulePath: f.importer },
          '@oxy.so/bloom/chart-cards',
          platform,
        ),
      /install a compatible Bloom/,
    );
  });
  test(`${platform}: a different Bloom copy fails closed`, () => {
    const f = fixture();
    const other = fixture();
    const r = resolver(f, (context, name) => {
      if (context.originModulePath === f.adapter && name.endsWith('/line'))
        return { type: 'sourceFile', filePath: path.join(other.bloom, 'line.js') };
    });
    f.helper.withAliaGranularCharts(r.config);
    assert.throws(
      () =>
        r.config.resolver.resolveRequest(
          { originModulePath: f.importer },
          '@oxy.so/bloom/chart-cards',
          platform,
        ),
      /different Bloom copy/,
    );
  });
}

test('symlinks work; other copies require explicit registration', () => {
  const a = fixture();
  const b = fixture();
  const alias = path.join(a.root, 'linked-sdk');
  fs.symlinkSync(a.sdk, alias, 'dir');
  const aliasImporter = path.join(alias, a.metadata.importers[0].path);
  const r = resolver(a);
  a.helper.withAliaGranularCharts(r.config, { additionalSdkRoots: [b.sdk] });
  assert.equal(
    r.config.resolver.resolveRequest(
      { originModulePath: aliasImporter },
      '@oxy.so/bloom/chart-cards',
      'web',
    ).filePath,
    a.adapter,
  );
  assert.equal(
    r.config.resolver.resolveRequest(
      { originModulePath: b.importer },
      '@oxy.so/bloom/chart-cards',
      'web',
    ).filePath,
    b.adapter,
  );
  const c = fixture();
  assert.equal(
    r.config.resolver.resolveRequest(
      { originModulePath: c.importer },
      '@oxy.so/bloom/chart-cards',
      'web',
    ).filePath,
    path.join(a.bloom, 'barrel.js'),
  );
});

test('changed source, adapter, and package version fail before configuring Metro', () => {
  for (const kind of ['importer', 'adapter', 'version']) {
    const f = fixture();
    if (kind === 'version') {
      const file = path.join(f.sdk, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(file));
      pkg.version = '99.0.0';
      fs.writeFileSync(file, JSON.stringify(pkg));
    } else fs.appendFileSync(f[kind], '\n// changed');
    assert.throws(
      () => f.helper.withAliaGranularCharts({}),
      /changed SDK file|unsupported SDK copy or version/,
    );
  }
});

test('fallback resolver is delegated, and redirected adapters are rejected', () => {
  const f = fixture();
  const r = resolver(f);
  const context = { originModulePath: f.importer, resolveRequest: r.previous };
  const config = {};
  f.helper.withAliaGranularCharts(config);
  assert.equal(
    config.resolver.resolveRequest(context, '@oxy.so/bloom/chart-cards', 'web').filePath,
    f.adapter,
  );
  const bad = resolver(f, (_, name) =>
    name === f.adapter ? { type: 'sourceFile', filePath: path.join(f.bloom, 'bar.js') } : undefined,
  );
  f.helper.withAliaGranularCharts(bad.config);
  assert.throws(
    () => bad.config.resolver.resolveRequest(context, '@oxy.so/bloom/chart-cards', 'web'),
    /adapter was redirected/,
  );
});

test('packed SDK exposes an opt-in whose version and source hashes match the tarball', () => {
  const { execFileSync } = require('node:child_process');
  const { createRequire } = require('node:module');
  const dir = path.join(temporary, 'packed');
  fs.mkdirSync(dir);
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], {
      cwd: source,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: path.join(dir, 'npm-cache'), TMPDIR: dir },
    }),
  );
  assert.equal(packed.length, 1);
  const destination = path.join(dir, 'node_modules', '@alia.onl', 'sdk');
  fs.mkdirSync(destination, { recursive: true });
  execFileSync('tar', [
    '-xzf',
    path.join(dir, packed[0].filename),
    '--strip-components=1',
    '-C',
    destination,
  ]);
  const app = path.join(dir, 'app.cjs');
  fs.writeFileSync(app, '');
  const requireFromApp = createRequire(app);
  const pkg = requireFromApp('@alia.onl/sdk/package.json');
  assert.equal(pkg.peerDependencies['@oxy.so/bloom'], '>=17.41.0');
  const helper = requireFromApp('@alia.onl/sdk/metro');
  assert.equal(typeof helper.withAliaGranularCharts({}).resolver.resolveRequest, 'function');
});

test('rejects stacking wrappers from the same or different SDK copies without changing the first', () => {
  const a = fixture();
  const b = fixture();
  const r = resolver(a);
  a.helper.withAliaGranularCharts(r.config);
  const wrapped = r.config.resolver.resolveRequest;
  assert.throws(
    () => a.helper.withAliaGranularCharts(r.config),
    /already configured.*additionalSdkRoots/,
  );
  assert.throws(
    () => b.helper.withAliaGranularCharts(r.config),
    /already configured.*additionalSdkRoots/,
  );
  assert.equal(r.config.resolver.resolveRequest, wrapped);
  r.config.resolver.resolveRequest = (...args) => wrapped(...args);
  assert.throws(() => b.helper.withAliaGranularCharts(r.config), /already configured/);
  const clone = { ...r.config, resolver: { ...r.config.resolver } };
  assert.throws(() => a.helper.withAliaGranularCharts(clone), /already configured/);
  r.config.resolver.resolveRequest = wrapped;
  assert.equal(
    wrapped({ originModulePath: a.importer }, '@oxy.so/bloom/chart-cards', 'web').filePath,
    a.adapter,
  );
  assert.equal(
    wrapped({ originModulePath: b.importer }, '@oxy.so/bloom/chart-cards', 'web').filePath,
    path.join(a.bloom, 'barrel.js'),
  );
});

test('rejects filesystem fallback for a Bloom subpath absent from its export map', () => {
  const f = fixture();
  const manifest = path.join(f.bloom, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(manifest));
  delete pkg.exports['./chart-cards/line'];
  fs.writeFileSync(manifest, JSON.stringify(pkg));
  const r = resolver(f);
  f.helper.withAliaGranularCharts(r.config);
  assert.throws(
    () =>
      r.config.resolver.resolveRequest(
        { originModulePath: f.importer },
        '@oxy.so/bloom/chart-cards',
        'web',
      ),
    /line is not exported/,
  );
});

test('rechecks a watched SDK importer and adapter only for affected requests', () => {
  for (const kind of ['importer', 'adapter']) {
    const f = fixture();
    const r = resolver(f);
    f.helper.withAliaGranularCharts(r.config);
    fs.appendFileSync(f[kind], '\n// changed after Metro started');
    assert.equal(
      r.config.resolver.resolveRequest({ originModulePath: f.importer }, 'unrelated', 'web')
        .filePath,
      'unrelated',
    );
    assert.throws(
      () =>
        r.config.resolver.resolveRequest(
          { originModulePath: f.importer },
          '@oxy.so/bloom/chart-cards',
          'web',
        ),
      /changed SDK file/,
    );
  }
});

test('real Metro rejects unexported, null, inactive and invalid chart paths even when files exist', () => {
  const metro = require('metro-resolver');
  for (const value of [
    undefined,
    null,
    { custom: './line.js' },
    '../line.js',
    { browser: './line.js' },
  ]) {
    const f = fixture();
    const modules = path.join(f.sdk, 'node_modules', '@oxy.so');
    fs.mkdirSync(modules, { recursive: true });
    const installedBloom = path.join(modules, 'bloom');
    fs.cpSync(f.bloom, installedBloom, { recursive: true });
    fs.mkdirSync(path.join(installedBloom, 'chart-cards'));
    for (const name of ['index.js', 'bar-list.js', 'line.js'])
      fs.writeFileSync(path.join(installedBloom, 'chart-cards', name), '');
    const manifest = path.join(installedBloom, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(manifest));
    pkg.exports['./chart-cards'] = './barrel.js';
    if (value === undefined) delete pkg.exports['./chart-cards/line'];
    else pkg.exports['./chart-cards/line'] = value;
    fs.writeFileSync(manifest, JSON.stringify(pkg));
    const lookup = (p) => {
      try {
        const stat = fs.statSync(p);
        return { exists: true, realPath: fs.realpathSync(p), type: stat.isDirectory() ? 'd' : 'f' };
      } catch {
        return { exists: false };
      }
    };
    const getPackageForModule = (p) => {
      let dir = p;
      while (dir !== path.dirname(dir)) {
        const manifest = path.join(dir, 'package.json');
        if (fs.existsSync(manifest))
          return {
            rootPath: dir,
            packageRelativePath: path.relative(dir, p),
            packageJson: JSON.parse(fs.readFileSync(manifest)),
          };
        dir = path.dirname(dir);
      }
      return null;
    };
    const warnings = [];
    const context = {
      allowHaste: false,
      assetExts: new Set(),
      customResolverOptions: {},
      dev: false,
      disableHierarchicalLookup: false,
      doesFileExist: (p) => lookup(p).type === 'f',
      fileSystemLookup: lookup,
      getPackage: (p) => JSON.parse(fs.readFileSync(p)),
      getPackageForModule,
      isESMImport: true,
      mainFields: ['react-native', 'browser', 'main'],
      nodeModulesPaths: [],
      originModulePath: f.importer,
      preferNativePlatform: true,
      resolveAsset: () => null,
      resolveHasteModule: () => null,
      resolveHastePackage: () => null,
      sourceExts: ['ts', 'tsx', 'js', 'jsx', 'json'],
      unstable_conditionNames: ['require'],
      unstable_conditionsByPlatform: { web: ['browser'] },
      unstable_enablePackageExports: true,
      unstable_logWarning: (warning) => warnings.push(warning),
    };
    const config = {};
    f.helper.withAliaGranularCharts(config);
    context.resolveRequest = config.resolver.resolveRequest;
    if (value?.browser) {
      assert.equal(metro.resolve(context, '@oxy.so/bloom/chart-cards', 'web').filePath, f.adapter);
      assert.deepEqual(warnings, []);
    } else {
      assert.throws(
        () => metro.resolve(context, '@oxy.so/bloom/chart-cards', 'web'),
        /not exported|no supported export|original Bloom chart barrel is unavailable|did not resolve to its declared public export/,
      );
    }
  }
});

test('rechecks a watched importer replaced by a symlink or removed', () => {
  for (const action of ['symlink', 'remove']) {
    const f = fixture();
    const r = resolver(f);
    f.helper.withAliaGranularCharts(r.config);
    fs.renameSync(f.importer, `${f.importer}.original`);
    if (action === 'symlink') {
      const changed = path.join(f.sdk, 'changed.tsx');
      fs.writeFileSync(changed, '// modified');
      fs.symlinkSync(changed, f.importer);
    }
    assert.throws(
      () =>
        r.config.resolver.resolveRequest(
          { originModulePath: f.importer },
          '@oxy.so/bloom/chart-cards',
          'web',
        ),
      /changed SDK file|SDK importer is missing/,
    );
  }
});
