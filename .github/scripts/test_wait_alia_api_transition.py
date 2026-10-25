import importlib.util
import json
import pathlib
import unittest

path = pathlib.Path(__file__).with_name('wait-alia-api-transition.py')
spec = importlib.util.spec_from_file_location('transition', path)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
SHA = 'a' * 40
DIGEST = 'sha256:' + 'b' * 64


def successful(**overrides):
    return dict(id=5, run_attempt=1, head_sha=SHA, head_branch='main', status='completed', conclusion='success', **overrides)


class TransitionBarrier(unittest.TestCase):
    def test_workflow_wires_barrier_and_reconciliation_for_every_trigger(self):
        root = path.parent.parent.parent
        gateway = (root / '.github/workflows/deploy-integrations.yml').read_text()
        api = (root / '.github/workflows/deploy-aws.yml').read_text()
        self.assertIn('run: python3 -B .github/scripts/wait-alia-api-transition.py', gateway)
        self.assertIn('actions: read', gateway)
        self.assertIn('GH_TOKEN: ${{ github.token }}', gateway)
        step = gateway.split('- name: Verify API producer transition and old-task drain')[1].split('- name:', 1)[0]
        self.assertNotIn('if:', step)
        self.assertNotIn('continue-on-error', step)
        self.assertIn('CMD="$CMD && bun packages/api/dist/db/migrate-channel-tasks.js --target-database=alia --apply"', api)
        self.assertIn('POST_DEPLOY_TASK_COMMAND_JSON: ${{ steps.phases.outputs.post_command }}', api)

    def test_app_waits_before_upload_but_canvas_stays_independent(self):
        root = path.parent.parent.parent
        workflow = (root / '.github/workflows/deploy-frontends.yml').read_text()
        app, canvas = workflow.split('  deploy-app:', 1)[1].split('  deploy-canvas:', 1)
        self.assertIn('actions: read', app)
        self.assertIn('id-token: write', app)
        self.assertIn('CLUSTER: oxy-cluster', app)
        self.assertIn('GH_TOKEN: ${{ github.token }}', app)
        command = 'run: python3 -B .github/scripts/wait-alia-api-transition.py'
        self.assertLess(app.index(command), app.index('- name: Deploy the Worker'))
        step = app.split('- name: Verify API producer transition and old-task drain')[1].split('- uses:', 1)[0]
        self.assertNotIn('if:', step)
        self.assertNotIn('continue-on-error', step)
        self.assertNotIn(command, canvas)

    def test_only_exact_sha_main_success(self):
        self.assertFalse(gate.api_deployment_succeeded([], SHA))
        for field, value in [('head_sha', 'c' * 40), ('head_branch', 'feature'), ('status', 'in_progress')]:
            self.assertFalse(gate.api_deployment_succeeded([{**successful(), field: value}], SHA))
        self.assertTrue(gate.api_deployment_succeeded([successful()], SHA))

    def test_failure_cancellation_skip_do_not_pass(self):
        for conclusion in ['failure', 'cancelled', 'skipped', 'timed_out', None]:
            with self.assertRaises(RuntimeError):
                gate.api_deployment_succeeded([{**successful(), 'conclusion': conclusion}], SHA)

    def test_new_attempt_does_not_reuse_old_success(self):
        self.assertFalse(gate.api_deployment_succeeded([successful(), {**successful(), 'run_attempt': 2, 'status': 'in_progress'}], SHA))

    def test_requires_complete_nonzero_drain(self):
        service = dict(status='ACTIVE', desiredCount=2, runningCount=2, pendingCount=0, deployments=[dict(status='PRIMARY', rolloutState='COMPLETED', runningCount=2, pendingCount=0, taskDefinition='new')])
        self.assertEqual(gate.drained_service({'services': [service]}), ('new', 2))
        for changed in [dict(desiredCount=0), dict(runningCount=1), dict(pendingCount=1), dict(deployments=[*service['deployments'], {'taskDefinition': 'old'}])]:
            self.assertIsNone(gate.drained_service({'services': [{**service, **changed}]}))

    def test_registry_runtime_and_every_live_task_must_match(self):
        manifest = dict(manifests=[dict(platform=dict(os='linux', architecture='arm64'), digest=DIGEST)])
        image = dict(imageId=dict(imageTag=SHA), imageManifest=json.dumps(manifest))
        self.assertEqual(gate.runtime_digest({'images': [image]}, SHA), DIGEST)
        self.assertEqual(gate.runtime_digest({'images': [image, image, {**image, 'imageId': {'imageTag': 'latest'}}]}, SHA), DIGEST)
        with self.assertRaises(RuntimeError):
            gate.runtime_digest({'images': [image]}, 'c' * 40)
        task = dict(lastStatus='RUNNING', taskDefinitionArn='new', containers=[dict(name='alia', imageDigest=DIGEST)])
        self.assertTrue(gate.matching_tasks({'tasks': [task]}, 'new', 1, DIGEST))
        self.assertFalse(gate.matching_tasks({'tasks': [task]}, 'old', 1, DIGEST))
        self.assertFalse(gate.matching_tasks({'tasks': [task]}, 'new', 2, DIGEST))
        self.assertFalse(gate.matching_tasks({'tasks': [task]}, 'new', 1, 'sha256:' + 'c' * 64))

    def test_workflow_failure_never_reaches_aws(self):
        calls = []
        def run(argv):
            calls.append(argv)
            return {'workflow_runs': [{**successful(), 'conclusion': 'failure'}]}
        with self.assertRaises(RuntimeError):
            gate.check_ready(SHA, 'OxyHQ/Alia', 'oxy-cluster', run)
        self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
