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
  fs.writeFileSync(path.join(bloom, 'package.json'), JSON.stringify({ name: '@oxy.so/bloom' }));
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
  assert.equal(pkg.peerDependencies['@oxy.so/bloom'], '>=15.10.1');
  const helper = requireFromApp('@alia.onl/sdk/metro');
  assert.equal(typeof helper.withAliaGranularCharts({}).resolver.resolveRequest, 'function');
});
