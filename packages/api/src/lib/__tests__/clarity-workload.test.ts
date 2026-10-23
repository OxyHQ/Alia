import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('uses the real Clarity SDK with scope-less workload mint, refresh and disposal', () => {
  const result = spawnSync(
    'bun',
    [fileURLToPath(new URL('./fixtures/clarity-workload-probe.ts', import.meta.url))],
    { encoding: 'utf8', timeout: 15000, env: process.env },
  );
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout).toBe('ALIA_CLARITY_WORKLOAD_OK\n');
}, 20000);
