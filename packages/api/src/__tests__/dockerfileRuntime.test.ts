/**
 * Every command that runs this image names the runtime the image ships.
 *
 * The API image runs on Bun (`oven/bun:*-slim`, CMD `bun ...`). Four other
 * places start a process in it by naming a runtime explicitly: the pre-rollout
 * migrator (`MIGRATION_RUNTIME` in deploy-aws.yml, read by
 * deploy-ecs-image.sh), the post-rollout migrator and seeder (the `phases`
 * step of deploy-aws.yml) and the production chat canary. They are one fact
 * written five times.
 *
 * The asymmetry is why it is a gate: `oven/bun` ships a `node` that is a
 * symlink to bun, so a stale `node` against this image still runs (on Bun,
 * while claiming Node), but a `bun` against a Node image dies before the
 * migrator starts — at the one-shot step, after a full arm64 build. A rollback
 * to Node must therefore move every line below with the Dockerfile, and this
 * test fails until it does.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const dockerfile = read('../../Dockerfile');
const deploy = read('../../../../.github/workflows/deploy-aws.yml');
const canary = read('../../../../.github/workflows/production-chat-canary.yml');

/** The images the build and runtime stages start FROM, and the command it runs. */
const builderStage = dockerfile.match(/^FROM (\S+) AS builder$/m)?.[1];
const runtimeStage = dockerfile.match(/^FROM (\S+) AS runtime$/m)?.[1];
const cmd = dockerfile.match(/^CMD \["([^"]+)", "([^"]+)"\]$/m);

describe('the API image and the commands that run it agree on Bun', () => {
  it('ships Bun as the runtime and starts the bundle with it', () => {
    // Positive controls: a regex that stopped matching must fail here rather
    // than let every comparison below pass against `undefined`.
    // Pinned by digest (the tag is for readers; the digest is what is pulled),
    // and the builder's own image, so the runtime is the Bun and libc the
    // dependency tree was installed against.
    expect(runtimeStage).toMatch(/^oven\/bun:\d+\.\d+\.\d+-slim@sha256:[0-9a-f]{64}$/);
    expect(builderStage).toBe(runtimeStage);
    expect(cmd?.[1]).toBe('bun');
    expect(cmd?.[2]).toBe('packages/api/dist/index.js');
    expect(dockerfile).not.toMatch(/^FROM node:/m);
  });

  it('runs the pre-rollout migrator with bun', () => {
    expect(deploy).toMatch(/^\s+MIGRATION_RUNTIME: bun$/m);
  });

  it('runs the post-rollout migrator and the seeder with bun', () => {
    expect(deploy).toContain("SEED='bun packages/api/dist/scripts/seed.js");
    expect(deploy).toContain("MIGRATE='bun packages/api/dist/db/migrate.js");
  });

  it('runs the live-image one-shot with bun', () => {
    expect(canary).toContain(
      'command:["bun","packages/api/dist/scripts/production-chat-canary.js"]',
    );
  });

  it('names no API entrypoint with node anywhere in those workflows', () => {
    for (const workflow of [deploy, canary]) {
      expect(workflow).not.toMatch(/\bnode packages\/api\/dist\//);
      expect(workflow).not.toMatch(/"node",\s*"packages\/api\/dist\//);
    }
  });
});
