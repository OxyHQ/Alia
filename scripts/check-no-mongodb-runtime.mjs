#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const consoleOutput = path.join(root, 'packages/alia-console/.output');
const failures = [];

const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);

for (const relative of tracked.filter((file) => /^packages\/[^/]+\/package\.json$/.test(file))) {
  const manifest = JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dependency of Object.keys(manifest[section] ?? {})) {
      if (dependency === 'mongodb' || dependency === 'mongoose' || dependency.startsWith('@mongodb-js/')) {
        failures.push(`${relative}: direct ${section}.${dependency}`);
      }
    }
  }
}

const runtimeImport = /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:mongodb|mongoose|@mongodb-js\/)/;
for (const relative of tracked.filter((file) =>
  /^packages\/[^/]+\/src\/.*\.(?:[cm]?[jt]sx?)$/.test(file)
  && !file.includes('/__tests__/')
  && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
)) {
  if (runtimeImport.test(readFileSync(path.join(root, relative), 'utf8'))) {
    failures.push(`${relative}: imports a Mongo runtime`);
  }
}

if (!existsSync(path.join(consoleOutput, 'server/index.mjs'))) {
  failures.push('packages/alia-console/.output/server/index.mjs is absent; build alia-console before this gate');
} else {
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!/\.(?:m?js|cjs|json)$/.test(entry)) continue;
      const source = readFileSync(absolute, 'utf8');
      if (
        runtimeImport.test(source)
        || /mongodb-connection-string-url|@mongodb-js\/saslprep|node_modules\/mongodb/.test(source)
      ) {
        failures.push(`${path.relative(root, absolute)}: built Mongo runtime fingerprint`);
      }
    }
  };
  visit(consoleOutput);
}

if (failures.length > 0) {
  console.error(`Mongo runtime boundary failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  process.exit(1);
}

console.log('Mongo runtime boundary passed: no direct dependency/import or alia-console build artefact contains the driver.');
