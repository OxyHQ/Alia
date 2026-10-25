import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkProductionChatCanary } from './check-production-chat-canary.mjs';

const sources = {
  workflow: readFileSync(
    new URL('../.github/workflows/production-chat-canary.yml', import.meta.url),
    'utf8',
  ),
  runner: readFileSync(
    new URL('../packages/api/src/scripts/production-chat-canary.ts', import.meta.url),
    'utf8',
  ),
  build: readFileSync(new URL('../packages/api/build.ts', import.meta.url), 'utf8'),
};
assert.deepEqual(checkProductionChatCanary(sources), []);
const mutations = [
  ['workflow', "if: github.ref == 'refs/heads/main'", 'if: true'],
  ['workflow', 'QA_USER_ID: ${{ vars.ALIA_CANARY_OXY_USER_ID }}', 'QA_USER_ID: ${{ inputs.user }}'],
  ['workflow', 'QA_TASK_ID: ${{ vars.ALIA_CANARY_OXY_TASK_ID }}', 'QA_TASK_ID: ${{ inputs.task }}'],
  [
    'workflow',
    '{name:"ALIA_CANARY_OXY_USER_ID",value:$user}',
    '{name:"ALIA_CANARY_OXY_USER_ID",value:"owner"}',
  ],
  ['workflow', '{name:"ALIA_CANARY_OXY_TASK_ID",value:$task}', ''],
  ['workflow', 'expected_live_image_digest', 'mutable_tag'],
  ['workflow', 'stop-task', 'echo'],
  ['runner', 'const accountId = env.ALIA_CANARY_OXY_USER_ID;', 'const accountId = "owner";'],
  ['runner', 'const taskId = env.ALIA_CANARY_OXY_TASK_ID;', 'const taskId = "unbound";'],
  ['runner', 'return { accountId, taskId };', 'return { accountId };'],
  ['runner', 'const requester = canaryRequester(process.env);', 'const requester = {};'],
  ['runner', 'const oxy = oxyServiceClient();', 'const oxy = fakeClient();'],
  ['runner', '    requester,', '    requester: { accountId: "owner" },'],
  [
    'runner',
    "await transport.fetch('http://127.0.0.1:3001/alia/chat', {",
    "await fetch('http://127.0.0.1:3001/alia/chat', {",
  ],
  ['runner', 'transport.dispose();', ''],
  ['runner', 'conversationId: null', 'conversationId: "persisted"'],
  ['runner', 'markerMatched', 'arbitraryOutput'],
  ['runner', 'expectTool: true', 'expectTool: false'],
  ['build', "entryPoints: ['src/scripts/production-chat-canary.ts']", 'entryPoints: []'],
];
for (const [key, before, after] of mutations) {
  assert.ok(sources[key].includes(before), `fixture missing: ${before}`);
  const mutated = { ...sources, [key]: sources[key].replaceAll(before, after) };
  assert.ok(checkProductionChatCanary(mutated).length > 0, `gate accepted mutation: ${before}`);
}
for (const forbidden of [
  'handleChatCompletions',
  'x-oxy-user-id',
  'authorization: `Bearer ${token}`',
]) {
  assert.ok(
    checkProductionChatCanary({ ...sources, runner: `${sources.runner}\n${forbidden}` }).length > 0,
  );
}
process.stdout.write(
  `Production canary gate: baseline and ${mutations.length + 3} mutations passed.\n`,
);
