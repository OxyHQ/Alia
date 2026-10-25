import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkProductionChatCanary({ workflow, runner, build }) {
  const failures = [];
  const requireText = (source, value, message) => {
    if (!source.includes(value)) failures.push(message);
  };
  requireText(workflow, "if: github.ref == 'refs/heads/main'", 'workflow is not main-only');
  // An environment changes the OIDC subject to one the deploy role does not
  // trust: the canary could never assume it.
  if (/^\s+environment:/m.test(workflow))
    failures.push(
      'workflow runs in an environment, whose OIDC subject oxy-github-deploy does not trust',
    );
  requireText(
    workflow,
    'QA_USER_ID: ${{ vars.ALIA_CANARY_OXY_USER_ID }}',
    'QA identity is not a closed protected variable',
  );
  requireText(
    workflow,
    'command:["bun","packages/api/dist/scripts/production-chat-canary.js"]',
    'workflow does not run the shipped private entrypoint',
  );
  requireText(workflow, '.taskDefinition', 'workflow is not bound to the live task definition');
  requireText(
    workflow,
    'expected_live_image_digest',
    'workflow is not bound to an immutable live image',
  );
  requireText(workflow, 'stop-task', 'workflow has no EXIT cleanup for its task');
  requireText(workflow, '.synthetic', 'workflow does not fail synthetic HTTP-200 answers');
  for (const label of ['default-1', 'arithmetic-1', 'research-1'])
    requireText(runner, label, `${label} is absent`);
  for (const label of ['search-tool', 'controlled-refusal', 'recovery'])
    requireText(runner, label, `${label} is absent`);
  requireText(runner, 'conversationId: null', 'the no-persistence result contract is absent');
  requireText(
    workflow,
    'QA_TASK_ID: ${{ vars.ALIA_CANARY_OXY_TASK_ID }}',
    'QA task is not a closed protected variable',
  );
  requireText(
    workflow,
    '{name:"ALIA_CANARY_OXY_USER_ID",value:$user}',
    'workflow does not pass the protected QA account',
  );
  requireText(
    workflow,
    '{name:"ALIA_CANARY_OXY_TASK_ID",value:$task}',
    'workflow does not pass the protected QA task',
  );
  for (const binding of [
    'const accountId = env.ALIA_CANARY_OXY_USER_ID;',
    'const taskId = env.ALIA_CANARY_OXY_TASK_ID;',
    'return { accountId, taskId };',
    'const requester = canaryRequester(process.env);',
    'const oxy = oxyServiceClient();',
  ])
    requireText(runner, binding, `runner lost requester binding: ${binding}`);
  if (
    !/createAliaTransportForOxyService\(oxy,\s*\{\s*baseURL: 'http:\/\/127\.0\.0\.1:3001',\s*requester,\s*\}\)/.test(
      runner,
    )
  )
    failures.push('runner does not bind its shared transport to the validated QA requester');
  requireText(
    runner,
    "await transport.fetch('http://127.0.0.1:3001/alia/chat', {",
    'runner does not enter real HTTP authentication through the shared transport',
  );
  requireText(runner, 'transport.dispose();', 'runner does not release its transport');
  if (/x-oxy-user-id|authorization:\s*`Bearer/i.test(runner))
    failures.push('runner constructs authority outside the shared requester transport');
  if (runner.includes('handleChatCompletions'))
    failures.push('runner bypasses HTTP authentication by importing the handler');
  requireText(runner, 'markerMatched', 'runner accepts arbitrary non-empty model output');
  requireText(runner, 'expectTool: true', 'search case does not require tool evidence');
  requireText(
    build,
    "entryPoints: ['src/scripts/production-chat-canary.ts']",
    'the runtime image does not build the canary',
  );
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workflow = readFileSync(
    new URL('../.github/workflows/production-chat-canary.yml', import.meta.url),
    'utf8',
  );
  const runner = readFileSync(
    new URL('../packages/api/src/scripts/production-chat-canary.ts', import.meta.url),
    'utf8',
  );
  const build = readFileSync(new URL('../packages/api/build.ts', import.meta.url), 'utf8');
  const failures = checkProductionChatCanary({ workflow, runner, build });
  if (failures.length) {
    process.stderr.write(`Production chat canary gate failed:\n- ${failures.join('\n- ')}\n`);
    process.exit(1);
  }
  process.stdout.write(
    'Production chat canary remains private, live-image-bound, closed-identity and full-matrix.\n',
  );
}
