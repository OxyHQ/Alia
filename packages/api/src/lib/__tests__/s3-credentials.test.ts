import { describe, expect, it } from 'vitest';
import { resolveS3Credentials } from '../s3.js';

/**
 * Which credential the S3 client is built with, and — the part that matters —
 * when it is built with NONE.
 *
 * The version this replaces read `process.env.AWS_ACCESS_KEY_ID || ''` into an
 * explicit `credentials` object. With the variables absent that is not "no
 * credential", it is the empty credential: the SDK signs with it and every call
 * fails, instead of falling through to its provider chain and resolving the ECS
 * task role. The difference is invisible in an environment that carries keys —
 * which is every environment this has ever run in — and becomes total the
 * moment they are removed.
 */
describe('the S3 credential', () => {
  it('is the environment pair when the environment has one', () => {
    expect(resolveS3Credentials({ AWS_ACCESS_KEY_ID: 'AKIA...', AWS_SECRET_ACCESS_KEY: 'secret' })).toEqual({
      accessKeyId: 'AKIA...',
      secretAccessKey: 'secret',
    });
  });

  it('is UNDEFINED when the environment has none, so the SDK resolves the task role', () => {
    expect(resolveS3Credentials({})).toBeUndefined();
  });

  it('is undefined for a half pair, rather than a credential with an empty half', () => {
    expect(resolveS3Credentials({ AWS_ACCESS_KEY_ID: 'AKIA...' })).toBeUndefined();
    expect(resolveS3Credentials({ AWS_SECRET_ACCESS_KEY: 'secret' })).toBeUndefined();
  });

  it('treats an empty string as absent, which is the bug this exists for', () => {
    // A task definition that stops injecting the pair leaves the variables
    // absent; a misconfigured one can leave them empty. Both must reach the
    // provider chain, and the old `|| ''` sent the second straight to a failed
    // signature.
    expect(resolveS3Credentials({ AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' })).toBeUndefined();
  });
});
