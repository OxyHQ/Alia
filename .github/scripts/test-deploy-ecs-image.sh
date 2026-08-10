#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_directory="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
test_directory="$(realpath "$test_directory")"

cleanup_test_directory() {
  if [[ "$test_directory" == "$temporary_root/"* &&
        -d "$test_directory" ]]; then
    rm -rf -- "$test_directory"
  else
    echo "Refusing to remove unexpected test directory: $test_directory" >&2
  fi
}
trap cleanup_test_directory EXIT

export DEPLOY_TEST_LOG=""
export DEPLOY_TEST_EXPECT_METRICS_ARN=false
# The SSM parameter path a case feeds to INTERNAL_METRICS_PARAMETER, and from
# which the mocked register-task-definition derives the ARN it demands. A case
# overrides it to cover a path shape the default does not.
export DEPLOY_TEST_METRICS_PARAMETER=/oxy/sampleapp/INTERNAL_METRICS_TOKEN
export DEPLOY_TEST_TASK_EXIT_CODE=0
export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN=false
export DEPLOY_TEST_SERVICE_DESIRED_COUNT=1
export DEPLOY_TEST_ROLLOUT_SCENARIO=healthy

aws() {
  local service_json='{
    "failures": [],
    "services": [{
      "status": "ACTIVE",
      "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:1",
      "desiredCount": 1,
      "networkConfiguration": {
        "awsvpcConfiguration": {
          "subnets": ["subnet-test"],
          "securityGroups": ["sg-test"]
        }
      },
      "launchType": "FARGATE",
      "deployments": [
        {
          "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:2",
          "status": "PRIMARY",
          "rolloutState": "COMPLETED",
          "runningCount": 1,
          "desiredCount": 1
        },
        {
          "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:1",
          "status": "PRIMARY",
          "rolloutState": "COMPLETED",
          "runningCount": 1,
          "desiredCount": 1
        }
      ]
    }]
  }'
  service_json="$(jq \
    --argjson desired "$DEPLOY_TEST_SERVICE_DESIRED_COUNT" \
    '.services[0].desiredCount = $desired' \
    <<<"$service_json")"

  # ECS not reporting the field at all is a DIFFERENT fault from reporting zero,
  # and the script must keep telling them apart: zero is a deliberate hold, an
  # absent count means nothing downstream can reason about capacity. Modelled by
  # deleting the key rather than by a sentinel number, because a sentinel would
  # be a number the script could compare and this one must not be comparable.
  if [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "absent-desired-count" ]]; then
    service_json="$(jq 'del(.services[0].desiredCount)' <<<"$service_json")"
  fi

  case "$1 $2" in
    "ecs describe-services")
      local describe_count_file="${DEPLOY_TEST_LOG}.describe-count"
      local describe_count=0
      if [[ -f "$describe_count_file" ]]; then
        describe_count="$(<"$describe_count_file")"
      fi
      describe_count=$((describe_count + 1))
      printf '%s\n' "$describe_count" >"$describe_count_file"
      if [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "transient-zero-deployment" &&
            "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].deployments |= map(
              if .taskDefinition == "arn:aws:ecs:test:task-definition/deploy-test:2"
              then
                .rolloutState = "IN_PROGRESS"
                | .desiredCount = 0
                | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      elif [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "zero-service-during-deploy" &&
              "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].desiredCount = 0
          | .services[0].deployments |= map(
              if .taskDefinition == "arn:aws:ecs:test:task-definition/deploy-test:2"
              then .desiredCount = 0 | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      elif [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "completed-zero-deployment" &&
              "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].deployments |= map(
              if .taskDefinition == "arn:aws:ecs:test:task-definition/deploy-test:2"
              then .desiredCount = 0 | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      fi
      printf '%s\n' "$service_json"
      ;;
    "ecs describe-task-definition")
      printf '%s\n' '{
        "family": "deploy-test",
        "networkMode": "awsvpc",
        "requiresCompatibilities": ["FARGATE"],
        "cpu": "256",
        "memory": "512",
        "containerDefinitions": [{
          "name": "deploy-test",
          "image": "example.invalid/deploy-test:old",
          "essential": true,
          "logConfiguration": {
            "logDriver": "awslogs",
            "options": {
              "awslogs-group": "/ecs/deploy-test",
              "awslogs-stream-prefix": "ecs"
            }
          }
        }]
      }'
      ;;
    "ecs register-task-definition")
      if [[ "$DEPLOY_TEST_EXPECT_METRICS_ARN" == "true" ]]; then
        local previous_argument=""
        local input_json=""
        local argument
        for argument in "$@"; do
          if [[ "$previous_argument" == "--cli-input-json" ]]; then
            input_json="${argument#file://}"
            break
          fi
          previous_argument="$argument"
        done
        # The verdict is written to the log rather than left to `set -e`. A
        # command that fails in the MIDDLE of this function does not abort the
        # run -- measured, and it holds whether the function is exported or
        # local -- because the caller consumes it as `v="$(aws ...)"` and only
        # the function's LAST command reaches that assignment's exit status. An
        # assertion whose only effect is its own exit status therefore cannot
        # fail, which is what this one did: pointing it at an ARN no case uses
        # left the suite green. Logging a distinct token instead puts the
        # mismatch in the expected.log diff, where it names itself.
        if jq -e \
          --arg expected \
          "arn:aws:ssm:test:123456789012:parameter${DEPLOY_TEST_METRICS_PARAMETER}" \
          '
          .containerDefinitions[]
          | select(.name == "deploy-test")
          | .secrets[]
          | select(
              .name == "INTERNAL_METRICS_TOKEN" and
              .valueFrom == $expected
            )
        ' "$input_json" >/dev/null; then
          printf 'metrics:arn\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'metrics:arn:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
        fi
      fi
      if [[ "$DEPLOY_TEST_EXPECT_TASK_SECRET_ARN" == "true" ]]; then
        local previous_argument=""
        local input_json=""
        local argument
        for argument in "$@"; do
          if [[ "$previous_argument" == "--cli-input-json" ]]; then
            input_json="${argument#file://}"
            break
          fi
          previous_argument="$argument"
        done
        # Same reason as the metrics assertion above: log the verdict, do not
        # rely on this function's exit status.
        if jq -e '
          .containerDefinitions[]
          | select(.name == "deploy-test")
          | .secrets[]
          | select(
              .name == "EXTRA_TASK_SECRET" and
              .valueFrom == "arn:aws:ssm:test:123456789012:parameter/oxy/sample-app/EXTRA_TASK_SECRET"
            )
        ' "$input_json" >/dev/null; then
          printf 'task-secret:arn\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'task-secret:arn:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
        fi
      fi
      printf '%s\n' "arn:aws:ecs:test:task-definition/deploy-test:2"
      ;;
    "ecs update-service")
      local previous_argument=""
      local task_definition=""
      local desired_count=""
      local argument
      for argument in "$@"; do
        if [[ "$previous_argument" == "--task-definition" ]]; then
          task_definition="$argument"
        elif [[ "$previous_argument" == "--desired-count" ]]; then
          desired_count="$argument"
        fi
        previous_argument="$argument"
      done
      if [[ -z "$desired_count" ]]; then
        echo "Mocked update-service requires an explicit --desired-count." >&2
        return 1
      fi
      printf 'service:%s:desired=%s\n' \
        "$task_definition" \
        "$desired_count" \
        >>"$DEPLOY_TEST_LOG"
      printf '{}\n'
      ;;
    "ecs run-task")
      # Log the COMMAND, not a fixed label. A stub that prints the same string
      # whatever it was asked to run cannot tell a correct migrator invocation
      # from one naming a package that does not exist in this repo, a runtime the
      # image does not carry, or a path build.ts never emits -- which is exactly
      # how `bun packages/backend/dist/scripts/migrate.js` survived here.
      run_task_command="$(
        prev_arg=""
        for arg in "$@"; do
          if [[ "$prev_arg" == "--overrides" ]]; then
            jq -r '.containerOverrides[0].command | join(" ")' <<<"$arg"
            break
          fi
          prev_arg="$arg"
        done
      )"
      printf 'run-task:%s\n' "$run_task_command" >>"$DEPLOY_TEST_LOG"
      printf '%s\n' '{
        "failures": [],
        "tasks": [{"taskArn": "arn:aws:ecs:test:task/deploy-test-reconcile"}]
      }'
      ;;
    "ecs describe-tasks")
      printf '{
        "failures": [],
        "tasks": [{
          "lastStatus": "STOPPED",
          "stoppedReason": "Essential container exited",
          "containers": [{
            "name": "deploy-test",
            "exitCode": %s
          }]
        }]
      }\n' "$DEPLOY_TEST_TASK_EXIT_CODE"
      ;;
    "logs get-log-events")
      printf 'tasklogs\n' >>"$DEPLOY_TEST_LOG"
      printf '%s\n' '{
        "events": [{
          "message": "[migration] fixture failure"
        }]
      }'
      ;;
    *)
      printf 'Unexpected mocked AWS call: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
export -f aws

# A bare `grep -F ... >/dev/null` under `set -e` aborts this harness at the
# failing line and prints NOTHING — the exit code fails the job, but the log says
# only that it stopped, with no assertion named and no output to read. That is
# the same "a check that cannot distinguish success from failure" shape the rest
# of this repo's gates are built against, applied to the gate itself.
#
# So every assertion goes through one of these two, which name the case, quote
# what they were looking for, and dump the output that did not contain it.
assert_output_contains() {
  local case_name="$1" needle="$2"
  local file="$test_directory/$case_name/output.log"
  if ! grep -qF -- "$needle" "$file"; then
    printf 'ASSERTION FAILED [%s]: output does not contain: %s\n' "$case_name" "$needle" >&2
    printf -- '--- %s ---\n' "$file" >&2
    sed -n '1,240p' "$file" >&2
    return 1
  fi
}

assert_output_lacks() {
  local case_name="$1" needle="$2"
  local file="$test_directory/$case_name/output.log"
  if grep -qF -- "$needle" "$file"; then
    printf 'ASSERTION FAILED [%s]: output unexpectedly contains: %s\n' "$case_name" "$needle" >&2
    printf -- '--- %s ---\n' "$file" >&2
    sed -n '1,240p' "$file" >&2
    return 1
  fi
}

# The AWS call log is the other observable: which mutating calls were made, in
# order. `assert_aws_log` diffs it against an exact expected list.
assert_aws_log() {
  local case_name="$1"
  shift
  local file="$test_directory/$case_name/aws.log"
  printf '%s\n' "$@" >"$test_directory/$case_name/expected.log"
  if ! diff -u "$test_directory/$case_name/expected.log" "$file"; then
    printf 'ASSERTION FAILED [%s]: AWS call log differs from expected (- expected, + actual)\n' "$case_name" >&2
    return 1
  fi
}

assert_aws_log_lacks() {
  local case_name="$1" needle="$2"
  local file="$test_directory/$case_name/aws.log"
  if grep -qF -- "$needle" "$file"; then
    printf 'ASSERTION FAILED [%s]: AWS call log unexpectedly contains: %s\n' "$case_name" "$needle" >&2
    printf -- '--- %s ---\n' "$file" >&2
    cat "$file" >&2
    return 1
  fi
}

assert_aws_log_empty() {
  local case_name="$1"
  local file="$test_directory/$case_name/aws.log"
  if [[ -s "$file" ]]; then
    printf 'ASSERTION FAILED [%s]: expected NO mutating AWS calls, got:\n' "$case_name" >&2
    cat "$file" >&2
    return 1
  fi
}

run_release() {
  local case_name="$1"
  local expect_success="$2"
  local run_migrations="${3:-false}"
  local inject_internal_metrics="${4:-false}"
  local task_exit_code="${5:-0}"
  local inject_task_secret="${6:-false}"
  local service_desired_count="${7:-1}"
  local rollout_scenario="${8:-healthy}"
  local smoke_exit_code="${9:-0}"
  local case_directory="$test_directory/$case_name"
  local output_file="$case_directory/output.log"
  local smoke_script="$case_directory/smoke.sh"

  mkdir -p "$case_directory"
  DEPLOY_TEST_LOG="$case_directory/aws.log"
  DEPLOY_TEST_EXPECT_METRICS_ARN="$inject_internal_metrics"
  DEPLOY_TEST_TASK_EXIT_CODE="$task_exit_code"
  DEPLOY_TEST_EXPECT_TASK_SECRET_ARN="$inject_task_secret"
  DEPLOY_TEST_SERVICE_DESIRED_COUNT="$service_desired_count"
  DEPLOY_TEST_ROLLOUT_SCENARIO="$rollout_scenario"
  export DEPLOY_TEST_LOG DEPLOY_TEST_EXPECT_METRICS_ARN
  export DEPLOY_TEST_TASK_EXIT_CODE
  export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN
  export DEPLOY_TEST_SERVICE_DESIRED_COUNT
  export DEPLOY_TEST_ROLLOUT_SCENARIO

  # The generated smoke fixture expands DEPLOY_TEST_LOG when it runs; its exit
  # code is the entire interface deploy-ecs-image.sh reads, so each case picks
  # one. 75 is the "failed, but a rollback cannot repair it" code.
  # shellcheck disable=SC2016
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "smoke\n" >>"$DEPLOY_TEST_LOG"' \
    "exit $smoke_exit_code" \
    >"$smoke_script"

  local -a release_environment=(
    AWS_REGION=test
    AWS_ACCOUNT_ID=123456789012
    CLUSTER=deploy-test
    APP=deploy-test
    CONTAINER_NAME=deploy-test
    IMAGE_URI="example.invalid/deploy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    MAX_WAIT_SECS=5
    POLL_INTERVAL=1
    RUN_MIGRATIONS="$run_migrations"
    POST_DEPLOY_SMOKE_SCRIPT="$smoke_script"
    POST_DEPLOY_TASK_COMMAND_JSON='["reconcile"]'
  )
  if [[ "$inject_internal_metrics" == "true" ]]; then
    release_environment+=(
      INTERNAL_METRICS_PARAMETER="$DEPLOY_TEST_METRICS_PARAMETER"
    )
  fi
  if [[ "$inject_task_secret" == "true" ]]; then
    release_environment+=(
      TASK_SECRET_OVERRIDES_JSON='{"EXTRA_TASK_SECRET":"arn:aws:ssm:test:123456789012:parameter/oxy/sample-app/EXTRA_TASK_SECRET"}'
    )
  fi

  if env "${release_environment[@]}" \
    bash "$repository_root/.github/scripts/deploy-ecs-image.sh" \
    >"$output_file" 2>&1; then
    if [[ "$expect_success" != "true" ]]; then
      echo "Expected $case_name to fail." >&2
      return 1
    fi
  elif [[ "$expect_success" == "true" ]]; then
    echo "Expected $case_name to succeed." >&2
    sed -n '1,240p' "$output_file" >&2
    return 1
  fi
}

run_release success true false true
assert_aws_log success \
  metrics:arn \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'run-task:reconcile'

# A hyphen in the parameter path is its own case because it is its own bug: the
# bracket expression validating this name once matched every character EXCEPT a
# hyphen, so an app whose path had none deployed and an app whose path had one
# did not -- and the only repo with a smoke fixture at the time was one of the
# former, which is why nothing here caught it.
#
# KEEP BOTH, and keep the plain one's app segment hyphen-FREE. That asymmetry is
# the entire test: rename them to two spellings that both contain a hyphen and
# this pair silently stops discriminating, while the suite still passes and still
# goes red under a mutation -- just for the wrong case.
DEPLOY_TEST_METRICS_PARAMETER=/oxy/sample-app/INTERNAL_METRICS_TOKEN
run_release hyphenated-metrics-parameter true false true
DEPLOY_TEST_METRICS_PARAMETER=/oxy/sampleapp/INTERNAL_METRICS_TOKEN
assert_aws_log hyphenated-metrics-parameter \
  metrics:arn \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'run-task:reconcile'

run_release explicit-task-secret true false false 0 true
assert_aws_log explicit-task-secret \
  task-secret:arn \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'run-task:reconcile'

run_release reconciliation-failure false false false 1
assert_aws_log reconciliation-failure \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'run-task:reconcile' \
  tasklogs \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1'

run_release migration-failure false true false 1
assert_aws_log migration-failure \
  'run-task:node packages/api/dist/db/migrate.js --target-database=alia --phase=pre' \
  tasklogs

# The migration command itself, asserted verbatim.
#
# `RUN_MIGRATIONS` defaults to false, so a wrong command is INERT until somebody
# turns it on -- which is why this shipped naming `packages/backend` (no such
# package here), `bun` (absent from the node:*-slim runtime stage) and
# `dist/scripts/migrate.js` (a path build.ts never emitted). Four faults, none
# reachable by any test, in a step whose whole job is to run before the rollout
# that needs it.
#
# The flags are part of the assertion: src/db/migrate.ts REQUIRES both and has no
# default for either, so a command missing them is refused at the door.
run_release migration-command true true false
assert_aws_log migration-command \
  'run-task:node packages/api/dist/db/migrate.js --target-database=alia --phase=pre' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'run-task:reconcile'
assert_output_contains migration-failure "[migration] fixture failure"
# A failed migration must never reach the rollout.
assert_aws_log_lacks migration-failure 'service:'

# A service held at desiredCount=0 is a STATE, not an error.
#
# It used to fail the deploy outright, which gave a repository whose service is
# deliberately scaled to zero — during a migration or a cutover — no green path
# at all: every merge reds its deploy, and the only remedy is to scale up, which
# is what the hold exists to prevent.
#
# The release still does everything that does not need a running task, and the
# assertions below are what pin WHICH those are: the migration one-shot runs, the
# post-deploy reconciliation one-shot runs (this is how a `post` migration lands
# while the service is down), and `update-service` is never called. The smoke
# script must NOT run — with no tasks it would measure the hold rather than the
# image — which is why `smoke` is absent from the expected call log.
run_release zero-desired-count true true false 0 false 0
assert_aws_log zero-desired-count \
  'run-task:node packages/api/dist/db/migrate.js --target-database=alia --phase=pre' \
  'run-task:reconcile'
assert_aws_log_lacks zero-desired-count 'service:'
assert_aws_log_lacks zero-desired-count 'smoke'

# ...and it must SAY so. The guard being replaced existed to stop a deploy
# silently doing nothing, and that purpose is not relaxed: the run is green, so
# the log is the only thing standing between "held down deliberately" and
# "shipped to nobody by accident". Each line is asserted separately so a
# reworded message fails on the specific fact it dropped.
assert_output_contains zero-desired-count \
  '::warning::ECS service deploy-test is at desiredCount=0, so NO ROLLOUT was performed'
assert_output_contains zero-desired-count 'desiredCount     : 0'
assert_output_contains zero-desired-count 'DONE             : registered task definition'
assert_output_contains zero-desired-count 'DONE             : migrations (phase=pre, target=alia)'
assert_output_contains zero-desired-count \
  'NOT DONE         : update-service, rollout wait, post-deploy smoke checks'
assert_output_contains zero-desired-count 'To serve this image, scale deploy-test up'
# The old refusal must be gone rather than merely unreached.
assert_output_lacks zero-desired-count 'must have a positive desiredCount'

# The same path with migrations OFF says so rather than implying they ran. A
# deploy that registered a revision and did nothing else is the case this whole
# message exists to keep visible.
run_release zero-desired-count-no-migrations true false false 0 false 0
assert_aws_log zero-desired-count-no-migrations 'run-task:reconcile'
assert_output_contains zero-desired-count-no-migrations \
  'NOT DONE         : migrations — RUN_MIGRATIONS is false'

# An ABSENT count is a different fault and stays a hard error: zero is a
# deliberate hold, while a missing field means ECS did not report capacity at all
# and nothing downstream can reason about it. Collapsing the two would let a
# malformed describe-services response take the "held down, carry on" path.
run_release absent-desired-count false true false 0 false 1 absent-desired-count
assert_output_contains absent-desired-count \
  '::error::ECS did not report a numeric desiredCount for service deploy-test'
assert_aws_log_empty absent-desired-count

run_release transient-zero-deployment true false false 0 false 1 transient-zero-deployment
assert_aws_log transient-zero-deployment \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'run-task:reconcile'
assert_output_contains transient-zero-deployment "has not assigned desired tasks"

run_release zero-service-during-deploy false false false 0 false 1 zero-service-during-deploy
assert_aws_log zero-service-during-deploy \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1'
assert_output_contains zero-service-during-deploy "service deploy-test reached desiredCount=0 during the deployment rollout"

run_release completed-zero-deployment false false false 0 false 1 completed-zero-deployment
assert_aws_log completed-zero-deployment \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1'
assert_output_contains completed-zero-deployment "completed at desiredCount=0; refusing to accept a zero-task steady state"

# A smoke failure the smoke script attributes to the new image rolls the service
# back, and stops the release before the reconciliation task runs.
run_release smoke-hermetic-failure false false false 0 false 1 healthy 1
assert_aws_log smoke-hermetic-failure \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1'
assert_output_contains smoke-hermetic-failure "Post-deploy smoke checks failed."

# A smoke failure the smoke script attributes to something outside the new image
# (exit 75) must NOT roll back: the service stays on the new task definition, the
# release finishes its reconciliation task, and the job still fails so the
# failure is paged rather than swallowed.
run_release smoke-no-rollback-failure false false false 0 false 1 healthy 75
assert_aws_log smoke-no-rollback-failure \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'run-task:reconcile'
assert_aws_log_lacks smoke-no-rollback-failure \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:'
assert_output_contains smoke-no-rollback-failure "stays on arn:aws:ecs:test:task-definition/deploy-test:2"
assert_output_contains smoke-no-rollback-failure "Nothing was rolled back; this release needs a human."

echo "Deployment script transaction tests passed."
