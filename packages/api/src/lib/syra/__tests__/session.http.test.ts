import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('uses installed Syra/Oxy SDKs with verified human authority, disposal and ticket isolation', () => {
  // Run outside the API suite's OxyServer mock alias.
  const result = spawnSync(
    'bun',
    [fileURLToPath(new URL('./fixtures/session-probe.ts', import.meta.url))],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: process.env,
    },
  );
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout).toContain('ALIA_SYRA_SESSION_OK');
}, 20000);
