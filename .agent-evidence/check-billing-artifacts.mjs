import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Peable } from '@peable.to/sdk';
import { convertDisplayAmount } from '@peable.to/sdk/display';
import { OxyServices } from '@oxy.so/core';
const manifest = JSON.parse(
  readFileSync(new URL('./published-billing-packages.json', import.meta.url)),
);
const lock = readFileSync(new URL('../bun.lock', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
for (const [name, pkg] of Object.entries(manifest.packages)) {
  assert.ok(lock.includes(`${name}@${pkg.version}`), `${name} registry version`);
  assert.ok(lock.includes(pkg.integrity), `${name} registry integrity`);
  let directory = dirname(require.resolve(name));
  let installed;
  while (directory !== dirname(directory)) {
    try {
      const candidate = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (candidate.name === name) {
        installed = candidate;
        break;
      }
    } catch {
      /* Walk upward to the owning package manifest. */
    }
    directory = dirname(directory);
  }
  assert.equal(installed?.version, pkg.version, `${name} installed version`);
}
assert.ok(!lock.includes('file:vendor/display/'), 'Review artifacts must not reach production');
// Construct clients only. No requests, wallet access or mutations are made.
const peable = new Peable({
  publicKey: 'synthetic',
  secret: 'synthetic',
  baseURL: 'http://127.0.0.1:9',
});
const oxy = new OxyServices({ baseURL: 'http://127.0.0.1:9' });
for (const fn of [
  convertDisplayAmount,
  peable.billing.createCheckoutSession,
  peable.billing.renewSubscription,
  oxy.billing.productPlans,
  oxy.billing.startProductPlanCheckout,
  oxy.billing.renewProductSubscription,
  oxy.accounts.invitations.create,
  oxy.accounts.invitations.accept,
  oxy.users.updateMe,
])
  assert.equal(typeof fn, 'function');
const services = JSON.parse(
  readFileSync(new URL('../node_modules/@oxy.so/services/package.json', import.meta.url)),
);
const types = readFileSync(
  new URL(`../node_modules/@oxy.so/services/${services.types}`, import.meta.url),
  'utf8',
);
assert.match(types, /useDisplayCurrency/);
assert.match(types, /DisplayCurrencySelector/);
console.log(
  'Published registry packages verified: Peable display/native billing and Oxy invitations, preferences, product checkout, renewal.',
);
