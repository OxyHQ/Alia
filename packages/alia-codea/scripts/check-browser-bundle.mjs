import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Evaluate the shipped entry without Node globals. Process-backed local tools
// may import Node modules when invoked on a capable host, never at browser load.
const module = { exports: {} };
const sandbox = {
  module,
  exports: module.exports,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  AbortController,
  AbortSignal,
  Request,
  Response,
  Headers,
  fetch,
  crypto: globalThis.crypto,
  setTimeout,
  clearTimeout,
  console,
  require(name) {
    assert.equal(name, 'vscode', `Browser entry eagerly loaded ${name}`);
    return {};
  },
};
vm.runInNewContext(
  await readFile(new URL('../dist/web/extension.js', import.meta.url), 'utf8'),
  sandbox,
  { timeout: 10_000 },
);
assert.equal(typeof module.exports.activate, 'function');
assert.equal(typeof module.exports.deactivate, 'function');
console.log('Browser extension entry loads without Node globals or builtins.');
