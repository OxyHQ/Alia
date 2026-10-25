#!/usr/bin/env python3
"""Finite phase-B barrier. Remove with the dual process readers in phase C."""
import json
import os
import re
import subprocess
import time


def command_json(argv):
    return json.loads(subprocess.check_output(argv, text=True))


def api_deployment_succeeded(runs, sha):
    matching = [r for r in runs if r.get('head_sha') == sha and r.get('head_branch') == 'main']
    if not matching:
        return False
    run = max(matching, key=lambda r: (r.get('id', 0), r.get('run_attempt', 0)))
    if run.get('status') != 'completed':
        return False
    if run.get('conclusion') != 'success':
        raise RuntimeError('Exact-release API deployment failed or was cancelled')
    return True


def drained_service(response):
    services = response.get('services', [])
    if response.get('failures') or len(services) != 1:
        return None
    service = services[0]
    deployments = service.get('deployments', [])
    desired = service.get('desiredCount', 0)
    if (service.get('status') != 'ACTIVE' or desired < 1 or
            service.get('runningCount') != desired or service.get('pendingCount') != 0 or
            len(deployments) != 1):
        return None
    deployment = deployments[0]
    if (deployment.get('status') != 'PRIMARY' or deployment.get('rolloutState') != 'COMPLETED' or
            deployment.get('runningCount') != desired or deployment.get('pendingCount') != 0):
        return None
    return deployment['taskDefinition'], desired


def runtime_digest(response, sha):
    # ECR may repeat an immutable manifest under several tag aliases. Require
    # the requested release tag and one identical manifest, not one array row.
    images = [image for image in response.get('images', []) if image.get('imageId', {}).get('imageTag') == sha]
    manifests = {json.dumps(json.loads(image['imageManifest']), sort_keys=True) for image in images}
    if response.get('failures') or len(manifests) != 1:
        raise RuntimeError('Exact-release API image is unavailable or ambiguous')
    index = json.loads(next(iter(manifests)))
    descriptors = [m for m in index.get('manifests', [])
                   if m.get('platform', {}).get('os') == 'linux'
                   and m.get('platform', {}).get('architecture') == 'arm64']
    if len(descriptors) != 1 or not re.fullmatch(r'sha256:[0-9a-f]{64}', descriptors[0]['digest']):
        raise RuntimeError('API image has no unambiguous arm64 runtime')
    return descriptors[0]['digest']


def matching_tasks(response, task_definition, desired, digest):
    tasks = response.get('tasks', [])
    if response.get('failures') or len(tasks) != desired:
        return False
    for task in tasks:
        if task.get('lastStatus') != 'RUNNING' or task.get('taskDefinitionArn') != task_definition:
            return False
        containers = [c for c in task.get('containers', []) if c.get('name') == 'alia']
        if len(containers) != 1 or containers[0].get('imageDigest') != digest:
            return False
    return True


def check_ready(sha, repository, cluster, run=command_json):
    runs = run(['gh', 'api', f'repos/{repository}/actions/workflows/deploy-aws.yml/runs?head_sha={sha}&branch=main&per_page=100'])
    if not api_deployment_succeeded(runs.get('workflow_runs', []), sha):
        return False
    service = drained_service(run(['aws', 'ecs', 'describe-services', '--cluster', cluster, '--services', 'alia']))
    if not service:
        return False
    digest = runtime_digest(run(['aws', 'ecr', 'batch-get-image', '--repository-name', 'oxy/alia', '--image-ids', f'imageTag={sha}']), sha)
    task_arns = run(['aws', 'ecs', 'list-tasks', '--cluster', cluster, '--service-name', 'alia', '--desired-status', 'RUNNING']).get('taskArns', [])
    if len(task_arns) != service[1]:
        return False
    tasks = run(['aws', 'ecs', 'describe-tasks', '--cluster', cluster, '--tasks', *task_arns])
    return matching_tasks(tasks, *service, digest)


def main():
    sha = os.environ['RELEASE_SHA']
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise RuntimeError('RELEASE_SHA must identify the exact reviewed commit')
    # Applies identically to workflow_run and manual dispatch. No bypass input.
    deadline = time.monotonic() + 3600
    while time.monotonic() < deadline:
        if check_ready(sha, os.environ['GITHUB_REPOSITORY'], os.environ['CLUSTER']):
            print(f'API release {sha} succeeded and all active API tasks use its exact runtime image')
            return
        print('Waiting for exact-release API deployment, reconciliation and old-task drain', flush=True)
        time.sleep(30)
    raise RuntimeError('API transition did not complete within the bounded rollout window')


if __name__ == '__main__':
    main()
