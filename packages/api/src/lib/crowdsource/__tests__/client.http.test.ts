import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('uses the installed CrowdSource SDK with the shared workload client, refresh and disposal', () => {
  const result = spawnSync(
    'bun',
    [fileURLToPath(new URL('./fixtures/workload-probe.ts', import.meta.url))],
    { encoding: 'utf8', timeout: 15000, env: process.env },
  );
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout).toContain('ALIA_CROWDSOURCE_WORKLOAD_OK');
}, 20000);
