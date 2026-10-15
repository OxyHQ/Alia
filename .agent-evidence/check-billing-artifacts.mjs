import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Peable } from '@peable.to/sdk';
import { convertDisplayAmount } from '@peable.to/sdk/display';
import { OxyServices } from '@oxy.so/core';
const manifest = JSON.parse(readFileSync(new URL('../vendor/display/provenance.json', import.meta.url)));
for (const [name, hash] of Object.entries(manifest.files)) {
  const bytes = readFileSync(new URL(`../vendor/display/${name}`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, name);
}
// Construct clients only. No requests, wallet access or mutations are made.
const peable = new Peable({publicKey:'synthetic',secret:'synthetic',baseURL:'http://127.0.0.1:9'});
const oxy = new OxyServices({baseURL:'http://127.0.0.1:9'});
for (const fn of [convertDisplayAmount, peable.billing.createCheckoutSession, peable.billing.renewSubscription,
  oxy.billing.productPlans, oxy.billing.startProductPlanCheckout, oxy.billing.renewProductSubscription,
  oxy.accounts.invitations.create, oxy.accounts.invitations.accept, oxy.users.updateMe]) assert.equal(typeof fn,'function');
const services = JSON.parse(readFileSync(new URL('../node_modules/@oxy.so/services/package.json',import.meta.url)));
const types = readFileSync(new URL(`../node_modules/@oxy.so/services/${services.types}`,import.meta.url),'utf8');
assert.match(types,/useDisplayCurrency/);
assert.match(types,/DisplayCurrencySelector/);
console.log('Pinned artifacts verified: Peable display/native billing and Oxy invitations, preferences, product checkout, renewal.');
