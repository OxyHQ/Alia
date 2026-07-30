import { describe, expect, it } from 'vitest';
import { supportsTransactions } from '../topology.js';

/**
 * Alia used no transactions before this feature, so a standalone `mongod` would
 * accept every other write the application makes and fail only the first time a
 * report and its outbox event try to commit together — which is the moment the
 * outbox stops being able to protect anything.
 */
describe('supportsTransactions', () => {
  it('accepts a replica set member', () => {
    expect(supportsTransactions({ setName: 'rs0' })).toBe(true);
  });

  it('accepts a mongos router', () => {
    expect(supportsTransactions({ msg: 'isdbgrid' })).toBe(true);
  });

  it('rejects a standalone', () => {
    expect(supportsTransactions({})).toBe(false);
  });

  /** An empty `setName` is what a half-initialised member reports. */
  it('rejects an empty replica set name', () => {
    expect(supportsTransactions({ setName: '' })).toBe(false);
  });

  it('rejects a non-string setName rather than trusting a truthy value', () => {
    expect(supportsTransactions({ setName: 1 })).toBe(false);
    expect(supportsTransactions({ setName: true })).toBe(false);
  });

  it('rejects a mongos-shaped msg that is not isdbgrid', () => {
    expect(supportsTransactions({ msg: 'something else' })).toBe(false);
  });
});
