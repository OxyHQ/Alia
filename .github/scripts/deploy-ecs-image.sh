#!/usr/bin/env bash

set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${CLUSTER:?CLUSTER is required}"
: "${APP:?APP is required}"
: "${IMAGE_URI:?IMAGE_URI is required}"
if [[ ! "$IMAGE_URI" =~ ^.+@sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "::error::IMAGE_URI must pin an immutable OCI digest (repository@sha256:<64 hex characters>)."
  exit 1
fi

CONTAINER_NAME="${CONTAINER_NAME:-$APP}"
MAX_WAIT_SECS="${MAX_WAIT_SECS:-1200}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-false}"
# The database the migration run INTENDS to reach, and which half of the rollout
# it is. Deliberately not derived from anything: the target guard exists to catch
# a DATABASE_URL pointing somewhere unexpected, and deriving the expected name
# from the same connection string would check it against itself.
MIGRATION_TARGET_DATABASE="${MIGRATION_TARGET_DATABASE:-alia}"
# `pre` (additive) runs BEFORE the rollout; `post` (drops, renames, narrows) runs
# after, through POST_DEPLOY_TASK_COMMAND_JSON. `all` is for a from-zero genesis
# run only and is the one value that is wrong against a live database.
MIGRATION_PHASE="${MIGRATION_PHASE:-pre}"
# Which package's migrator this deploy runs. Defaulted rather than required
# because `packages/api` is the caller this script was written for and every
# existing invocation omits it; `packages/integrations` ships its own migrator
# with its own journal and its own database, and hardcoding one package's path
# is what made this script single-tenant.
#
# Not derived from `$APP`: the ECS service is `alia-integrations` and the package
# is `integrations`, so a derivation would need a mapping table that is wrong the
# first time the two names disagree — which is already.
MIGRATION_ENTRYPOINT="${MIGRATION_ENTRYPOINT:-packages/api/dist/db/migrate.js}"
INTERNAL_METRICS_PARAMETER="${INTERNAL_METRICS_PARAMETER:-}"
TASK_SECRET_OVERRIDES_JSON="${TASK_SECRET_OVERRIDES_JSON:-}"
# The environment-variable counterpart of TASK_SECRET_OVERRIDES_JSON, and the
# only way CI can introduce a NEW plain variable to a service that already
# exists.
#
# Without it the sole route is a hand-registered revision plus a repoint, which
# survives exactly until a circuit-breaker rollback moves the service pointer
# back to a revision that never carried the variable — and then the NEXT
# unrelated deploy descends from that one and the variable is gone, silently.
# `docs/runbooks/kaana-cutover.md` names this hook as the durable fix and the
# reason: an override here is re-asserted on every deploy, so a rollback cannot
# lose it.
TASK_ENV_OVERRIDES_JSON="${TASK_ENV_OVERRIDES_JSON:-}"
# Plain environment variables to DROP from the inherited task definition.
#
# ECS revisions are rendered from the running revision, so deleting a variable
# in source or Terraform does not delete the carried-forward `.environment`
# entry. This is the explicit retirement path for obsolete runtime contracts.
TASK_CONFIGURATION_REMOVALS_JSON="${TASK_CONFIGURATION_REMOVALS_JSON:-}"
# Secrets to DROP from the revision, by variable name.
#
# The render carries `.secrets` forward from the running task definition, and an
# override can only REPLACE an entry — so until this existed there was no way to
# stop injecting one. That is not symmetrical with adding: a secret that must go
# away (a credential being retired, an injection that shadows a task role) stays
# on every future revision, because every future revision descends from this one.
#
# Removal happens BEFORE the overrides are appended, so a name in both lists is
# refused rather than resolved — see the validation below.
TASK_SECRET_REMOVALS_JSON="${TASK_SECRET_REMOVALS_JSON:-}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-}"
AWS_PARTITION="${AWS_PARTITION:-aws}"
POST_DEPLOY_SMOKE_SCRIPT="${POST_DEPLOY_SMOKE_SCRIPT:-}"
PRE_DEPLOY_TASK_COMMAND_JSON="${PRE_DEPLOY_TASK_COMMAND_JSON:-}"
POST_DEPLOY_TASK_COMMAND_JSON="${POST_DEPLOY_TASK_COMMAND_JSON:-}"
# Exit code a smoke script uses to say "this failed, and rolling back cannot fix
# it" — a check that crosses a boundary this deploy does not own (a CDN in front
# of the origin, another service the route consults). Reverting the image for one
# of those trades a working deployment for an outage somebody else is already
# fixing, so the release stands and the job goes red instead.
#
# Every OTHER non-zero code still rolls back, so a smoke script that does not opt
# into the protocol keeps the previous all-or-nothing behaviour.
SMOKE_NO_ROLLBACK_EXIT=75
smoke_reported_external_failure=false
DEPLOY_HEAD_GUARD_SCRIPT="${DEPLOY_HEAD_GUARD_SCRIPT:-.github/scripts/require-current-main.sh}"

if ! [[ "$MAX_WAIT_SECS" =~ ^[0-9]+$ ]] || (( MAX_WAIT_SECS < 1 )); then
  echo "::error::MAX_WAIT_SECS must be a positive integer."
  exit 1
fi
if ! [[ "$POLL_INTERVAL" =~ ^[0-9]+$ ]] || (( POLL_INTERVAL < 1 )); then
  echo "::error::POLL_INTERVAL must be a positive integer."
  exit 1
fi
if [[ "$RUN_MIGRATIONS" != "true" && "$RUN_MIGRATIONS" != "false" ]]; then
  echo "::error::RUN_MIGRATIONS must be either 'true' or 'false'."
  exit 1
fi
if [[ -n "$POST_DEPLOY_SMOKE_SCRIPT" && ! -f "$POST_DEPLOY_SMOKE_SCRIPT" ]]; then
  echo "::error::POST_DEPLOY_SMOKE_SCRIPT does not exist: $POST_DEPLOY_SMOKE_SCRIPT"
  exit 1
fi
if [[ -n "${DEPLOY_SHA:-}" && ! -f "$DEPLOY_HEAD_GUARD_SCRIPT" ]]; then
  echo "::error::DEPLOY_HEAD_GUARD_SCRIPT does not exist: $DEPLOY_HEAD_GUARD_SCRIPT"
  exit 1
fi
if [[ -n "$POST_DEPLOY_TASK_COMMAND_JSON" ]] &&
   ! jq -e '
     type == "array" and
     length > 0 and
     all(.[]; type == "string" and length > 0)
   ' <<<"$POST_DEPLOY_TASK_COMMAND_JSON" >/dev/null; then
  echo "::error::POST_DEPLOY_TASK_COMMAND_JSON must be a non-empty JSON string array."
  exit 1
fi
if [[ -n "$PRE_DEPLOY_TASK_COMMAND_JSON" ]] &&
   ! jq -e '
     type == "array" and
     length > 0 and
     all(.[]; type == "string" and length > 0)
   ' <<<"$PRE_DEPLOY_TASK_COMMAND_JSON" >/dev/null; then
  echo "::error::PRE_DEPLOY_TASK_COMMAND_JSON must be a non-empty JSON string array."
  exit 1
fi
if [[ -z "$TASK_SECRET_OVERRIDES_JSON" ]]; then
  TASK_SECRET_OVERRIDES_JSON='{}'
fi
if ! jq -e '
  type == "object" and
  length <= 20 and
  all(
    to_entries[];
    (.key | type == "string" and test("^[A-Z][A-Z0-9_]{0,127}$")) and
    (
      .value
      | type == "string" and
        test("^arn:aws(-[a-z]+)?:ssm:[a-z0-9-]+:[0-9]{12}:parameter/[A-Za-z0-9_./-]+$")
    )
  )
' <<<"$TASK_SECRET_OVERRIDES_JSON" >/dev/null; then
  echo "::error::TASK_SECRET_OVERRIDES_JSON must map environment variable names to complete SSM parameter ARNs."
  exit 1
fi
if [[ -z "$TASK_SECRET_REMOVALS_JSON" ]]; then
  TASK_SECRET_REMOVALS_JSON='[]'
fi
if ! jq -e '
  type == "array" and
  length <= 20 and
  all(.[]; type == "string" and test("^[A-Z][A-Z0-9_]{0,127}$"))
' <<<"$TASK_SECRET_REMOVALS_JSON" >/dev/null; then
  echo "::error::TASK_SECRET_REMOVALS_JSON must be a JSON array of environment variable names."
  exit 1
fi
# A name cannot be both removed and replaced. Refused rather than ordered:
# whichever way it resolved would be a silent answer to a contradiction, and the
# contradiction is what the operator needs to see.
if ! jq -e -n \
  --argjson removals "$TASK_SECRET_REMOVALS_JSON" \
  --argjson overrides "$TASK_SECRET_OVERRIDES_JSON" \
  '[$removals[] | select(. as $n | ($overrides | has($n)))] | length == 0' >/dev/null; then
  echo "::error::TASK_SECRET_REMOVALS_JSON and TASK_SECRET_OVERRIDES_JSON name the same variable."
  exit 1
fi
if [[ -z "$TASK_ENV_OVERRIDES_JSON" ]]; then
  TASK_ENV_OVERRIDES_JSON='{}'
fi
# The EMPTY-STRING rejection is the load-bearing clause, not the name pattern.
#
# This hook exists to arm a variable that is absent until somebody decides it
# should not be, so the natural way to write the caller is "pass whatever the
# repo variable holds". Unset, that is the empty string — and an empty override
# would register a revision declaring the variable as "" rather than leaving it
# absent, which is the one outcome the caller never wants: for INTEGRATIONS_URL
# it reads as configured-and-broken instead of unconfigured, and code branching
# on presence takes the wrong arm. Refuse it here so a caller that meant to send
# nothing has to send `{}`.
if ! jq -e '
  type == "object" and
  length <= 20 and
  all(
    to_entries[];
    (.key | type == "string" and test("^[A-Z][A-Z0-9_]{0,127}$")) and
    (.value | type == "string" and length > 0 and length <= 2048)
  )
' <<<"$TASK_ENV_OVERRIDES_JSON" >/dev/null; then
  echo "::error::TASK_ENV_OVERRIDES_JSON must map environment variable names to non-empty string values."
  exit 1
fi
if [[ -z "$TASK_CONFIGURATION_REMOVALS_JSON" ]]; then
  TASK_CONFIGURATION_REMOVALS_JSON='[]'
fi
if ! jq -e '
  type == "array" and
  length <= 40 and
  all(.[]; type == "string" and test("^[A-Z][A-Z0-9_]{0,127}$"))
' <<<"$TASK_CONFIGURATION_REMOVALS_JSON" >/dev/null; then
  echo "::error::TASK_CONFIGURATION_REMOVALS_JSON must be a JSON array of environment variable names."
  exit 1
fi
if ! jq -e -n \
  --argjson removals "$TASK_CONFIGURATION_REMOVALS_JSON" \
  --argjson overrides "$TASK_ENV_OVERRIDES_JSON" \
  '[$removals[] | select(. as $n | ($overrides | has($n)))] | length == 0' >/dev/null; then
  echo "::error::TASK_CONFIGURATION_REMOVALS_JSON and TASK_ENV_OVERRIDES_JSON name the same variable."
  exit 1
fi

service_json="$(aws ecs describe-services --cluster "$CLUSTER" --services "$APP")"
if [[ "$(jq '.failures | length' <<<"$service_json")" != "0" ||
      "$(jq '.services | length' <<<"$service_json")" != "1" ]]; then
  echo "::error::ECS did not return exactly one service named $APP."
  jq '.failures' <<<"$service_json"
  exit 1
fi
service_status="$(jq -r '.services[0].status // "NONE"' <<<"$service_json")"
if [[ "$service_status" != "ACTIVE" ]]; then
  echo "::error::ECS service $APP is not ACTIVE (status: $service_status)."
  exit 1
fi

current_task_definition="$(jq -r '.services[0].taskDefinition // empty' <<<"$service_json")"
if [[ -z "$current_task_definition" ]]; then
  echo "::error::ECS service $APP has no task definition."
  exit 1
fi

service_desired_count="$(jq -r '.services[0].desiredCount // empty' <<<"$service_json")"
# A NON-NUMERIC desiredCount is ECS declining to tell us the answer, which is not
# the same fact as a zero it reports confidently. Nothing downstream can be
# trusted without it, so that still refuses.
if ! [[ "$service_desired_count" =~ ^[0-9]+$ ]]; then
  echo "::error::ECS service $APP reported a non-numeric desiredCount (${service_desired_count:-missing}); refusing to deploy."
  exit 1
fi

# desiredCount 0 is a STATE, not an error. This service is parked at zero for the
# whole of the Postgres cutover on purpose, and refusing the deploy there is
# self-sealing: the image that would make the service bootable again is the image
# the refusal blocks, so the parked state can never be left.
#
# What this must NOT become is a green deploy that reports a release nobody got.
# So the release still does everything that is real at zero capacity — it runs
# the migration, registers the revision, and POINTS THE SERVICE AT IT — and then
# stops at the one step that is not real, the rollout, and says so loudly.
#
# Pointing the service is the half that is easy to leave out and expensive to
# skip. `register-task-definition` alone does not repoint anything: ECS launches
# whatever revision the SERVICE is configured with, so a later `desiredCount`
# bump would start the OLD image, and this script derives its next render from
# `services[0].taskDefinition` (see `current_task_definition` above), so every
# subsequent deploy would keep building on the stale revision too.
zero_capacity_deploy=false
if (( service_desired_count < 1 )); then
  zero_capacity_deploy=true
fi

task_definition_file="$(mktemp)"
rendered_task_definition_file="$(mktemp)"
active_one_shot_task_arn=""
active_one_shot_task_stopped=true
active_one_shot_label=""

cleanup() {
  if [[ "$active_one_shot_task_stopped" != "true" &&
        -n "$active_one_shot_task_arn" ]]; then
    echo "::warning::Unfinished $active_one_shot_label task $active_one_shot_task_arn may still be running; the deploy role cannot call ecs:StopTask."
  fi
  rm -f "$task_definition_file" "$rendered_task_definition_file"
}
trap cleanup EXIT

wait_for_task_stop() {
  local task_arn="$1"
  local label="$2"
  local max_wait_secs="$3"
  local elapsed=0
  local task_json last_status

  while (( elapsed < max_wait_secs )); do
    task_json="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn")"
    if [[ "$(jq '.failures | length' <<<"$task_json")" != "0" ]]; then
      echo "::error::ECS could not describe $label task $task_arn."
      jq '.failures' <<<"$task_json"
      return 1
    fi
    last_status="$(jq -r '.tasks[0].lastStatus // "MISSING"' <<<"$task_json")"
    echo "($elapsed s) $label task status=$last_status"
    if [[ "$last_status" == "STOPPED" ]]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  echo "::error::$label task did not stop within ${max_wait_secs}s. The deploy role cannot call ecs:StopTask; task $task_arn may still be running."
  return 1
}

wait_for_service_rollout() {
  local task_definition="$1"
  local label="$2"
  local elapsed=0
  local deployment_json="$service_json"
  local deployment_state rollout_state running desired service_desired

  while (( elapsed < MAX_WAIT_SECS )); do
    if ! deployment_json="$(aws ecs describe-services \
      --cluster "$CLUSTER" \
      --services "$APP")"; then
      echo "::warning::Unable to inspect the $label rollout; retrying."
      sleep "$POLL_INTERVAL"
      elapsed=$((elapsed + POLL_INTERVAL))
      continue
    fi
    if [[ "$(jq '.failures | length' <<<"$deployment_json")" != "0" ]]; then
      echo "::warning::ECS returned a failure while inspecting the $label rollout; retrying."
      sleep "$POLL_INTERVAL"
      elapsed=$((elapsed + POLL_INTERVAL))
      continue
    fi
    if ! deployment_state="$(jq -r --arg task "$task_definition" '
      .services[0] as $service
      |
      [
        $service.deployments[]
        | select(.taskDefinition == $task and .status == "PRIMARY")
        | [.rolloutState, .runningCount, .desiredCount, $service.desiredCount]
        | @tsv
      ][0] // empty
    ' <<<"$deployment_json")"; then
      echo "::warning::ECS returned malformed rollout data for $label; retrying."
      sleep "$POLL_INTERVAL"
      elapsed=$((elapsed + POLL_INTERVAL))
      continue
    fi

    if [[ -z "$deployment_state" ]]; then
      echo "($elapsed s) waiting for the $label PRIMARY deployment"
    else
      IFS=$'\t' read -r rollout_state running desired service_desired <<<"$deployment_state"
      echo "($elapsed s) $label rolloutState=$rollout_state running=$running desired=$desired serviceDesired=$service_desired"
      if ! [[ "$running" =~ ^[0-9]+$ &&
              "$desired" =~ ^[0-9]+$ &&
              "$service_desired" =~ ^[0-9]+$ ]]; then
        echo "::warning::ECS returned non-numeric task counts for the $label rollout; retrying."
      elif (( service_desired < 1 )); then
        echo "::error::ECS service $APP reached desiredCount=0 during the $label rollout."
        return 1
      elif [[ "$rollout_state" == "COMPLETED" ]]; then
        if (( desired < 1 )); then
          echo "::error::ECS $label rollout for $APP completed at desiredCount=0; refusing to accept a zero-task steady state."
          return 1
        fi
        if [[ "$running" == "$desired" ]]; then
          return 0
        fi
      elif (( desired < 1 )); then
        echo "::warning::ECS has not assigned desired tasks to the $label PRIMARY deployment yet; waiting."
      fi
      if [[ "$rollout_state" == "FAILED" ]]; then
        echo "::error::ECS $label rollout for $APP failed."
        echo "::group::Recent ECS service events"
        jq -r '
          .services[0].events[:10][]?
          | "\(.createdAt // "unknown") \(.message // "unknown")"
        ' <<<"$deployment_json"
        echo "::endgroup::"
        return 1
      fi
    fi

    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  echo "::error::ECS $label rollout for $APP did not complete within ${MAX_WAIT_SECS}s."
  echo "::group::Recent ECS service events"
  jq -r '
    .services[0].events[:10][]?
    | "\(.createdAt // "unknown") \(.message // "unknown")"
  ' <<<"$deployment_json"
  echo "::endgroup::"
  return 1
}

print_one_shot_logs() {
  local task_arn="$1"
  local label="$2"
  local task_id log_group log_stream_prefix log_stream log_json

  task_id="${task_arn##*/}"
  log_group="$(jq -r --arg name "$CONTAINER_NAME" '
    .containerDefinitions[]
    | select(.name == $name)
    | .logConfiguration.options["awslogs-group"] // empty
  ' "$rendered_task_definition_file")"
  log_stream_prefix="$(jq -r --arg name "$CONTAINER_NAME" '
    .containerDefinitions[]
    | select(.name == $name)
    | .logConfiguration.options["awslogs-stream-prefix"] // empty
  ' "$rendered_task_definition_file")"

  if [[ -z "$task_id" || -z "$log_group" || -z "$log_stream_prefix" ]]; then
    echo "::warning::Unable to derive the CloudWatch log stream for failed $label task $task_arn."
    return 0
  fi

  log_stream="$log_stream_prefix/$CONTAINER_NAME/$task_id"
  if ! log_json="$(aws logs get-log-events \
    --log-group-name "$log_group" \
    --log-stream-name "$log_stream" \
    --limit 200 \
    --start-from-head)"; then
    echo "::warning::Unable to read CloudWatch logs for failed $label task $task_arn."
    return 0
  fi

  echo "::group::$label CloudWatch logs"
  jq -r '.events[]?.message' <<<"$log_json"
  echo "::endgroup::"
}

run_one_shot_command() {
  local label="$1"
  local command_json="$2"
  local overrides run_json task_json exit_code stopped_reason container_reason

  overrides="$(jq -cn \
    --arg name "$CONTAINER_NAME" \
    --argjson command "$command_json" \
    '{
      containerOverrides: [{
        name: $name,
        command: $command
      }]
    }')"

  if ! run_json="$(aws "${one_shot_run_task_args[@]}" --overrides "$overrides")"; then
    echo "::error::ECS failed to start the $label task."
    return 1
  fi
  if [[ "$(jq '.failures | length' <<<"$run_json")" != "0" ]]; then
    echo "::error::ECS refused to start the $label task."
    jq '.failures' <<<"$run_json"
    return 1
  fi

  active_one_shot_task_arn="$(jq -r '.tasks[0].taskArn // empty' <<<"$run_json")"
  if [[ -z "$active_one_shot_task_arn" ]]; then
    echo "::error::ECS returned no task ARN for $label."
    return 1
  fi
  active_one_shot_label="$label"
  active_one_shot_task_stopped=false

  echo "Running $label with $new_task_definition"
  if ! wait_for_task_stop "$active_one_shot_task_arn" "$label" "$MAX_WAIT_SECS"; then
    return 1
  fi
  active_one_shot_task_stopped=true

  task_json="$(aws ecs describe-tasks \
    --cluster "$CLUSTER" \
    --tasks "$active_one_shot_task_arn")"
  exit_code="$(jq -r --arg name "$CONTAINER_NAME" '
    .tasks[0].containers[] | select(.name == $name) | .exitCode // -1
  ' <<<"$task_json")"
  if [[ "$exit_code" != "0" ]]; then
    print_one_shot_logs "$active_one_shot_task_arn" "$label"
    stopped_reason="$(jq -r '.tasks[0].stoppedReason // "unknown"' <<<"$task_json")"
    container_reason="$(jq -r --arg name "$CONTAINER_NAME" '
      .tasks[0].containers[] | select(.name == $name) | .reason // "unknown"
    ' <<<"$task_json")"
    echo "::error::$label task failed (exit=$exit_code, stopped=$stopped_reason, container=$container_reason)."
    return 1
  fi
  echo "$label completed successfully"
}

rollback_service() {
  echo "::warning::Rolling $APP back to $current_task_definition."
  if ! aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$APP" \
    --task-definition "$current_task_definition" \
    --desired-count "$service_desired_count" \
    --deployment-configuration '{
      "deploymentCircuitBreaker": {"enable": true, "rollback": true},
      "minimumHealthyPercent": 100,
      "maximumPercent": 200
    }' \
    >/dev/null; then
    echo "::error::ECS rejected the rollback to $current_task_definition."
    return 1
  fi
  wait_for_service_rollout "$current_task_definition" "rollback"
}

internal_metrics_secret_arn=""
if [[ -n "$INTERNAL_METRICS_PARAMETER" ]]; then
  if [[ "$INTERNAL_METRICS_PARAMETER" == arn:* ]]; then
    internal_metrics_secret_arn="$INTERNAL_METRICS_PARAMETER"
  else
    if [[ ! "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
      echo "::error::AWS_ACCOUNT_ID must be a 12-digit account id when INTERNAL_METRICS_PARAMETER is a parameter name."
      exit 1
    fi
    # The hyphen is LAST on purpose. This is a POSIX bracket expression, where a
    # backslash is an ordinary character rather than an escape, so the `\-/` that
    # reads as an escaped hyphen in PCRE is really a reversed `\`-to-`/` range and
    # the class then matches no hyphen at all. Every `/oxy/<app>/...` parameter
    # path whose app name contains one was silently rejected.
    if [[ ! "$AWS_PARTITION" =~ ^aws(-[a-z]+)?$ ||
          ! "$INTERNAL_METRICS_PARAMETER" =~ ^/[A-Za-z0-9_./-]+$ ]]; then
      echo "::error::AWS partition or INTERNAL_METRICS_PARAMETER name is invalid."
      exit 1
    fi
    internal_metrics_secret_arn="arn:${AWS_PARTITION}:ssm:${AWS_REGION}:${AWS_ACCOUNT_ID}:parameter/${INTERNAL_METRICS_PARAMETER#/}"
  fi
  if [[ ! "$internal_metrics_secret_arn" =~ ^arn:aws(-[a-z]+)?:ssm:[a-z0-9-]+:[0-9]{12}:parameter/.+$ ]]; then
    echo "::error::Unable to construct a valid SSM parameter ARN for the task definition."
    exit 1
  fi
fi

task_secret_overrides="$(jq -c '
  [
    to_entries[]
    | {name: .key, valueFrom: .value}
  ]
' <<<"$TASK_SECRET_OVERRIDES_JSON")"

task_env_overrides="$(jq -c '
  [
    to_entries[]
    | {name: .key, value: .value}
  ]
' <<<"$TASK_ENV_OVERRIDES_JSON")"

aws ecs describe-task-definition \
  --task-definition "$current_task_definition" \
  --query taskDefinition \
  >"$task_definition_file"

container_matches="$(jq --arg name "$CONTAINER_NAME" '[.containerDefinitions[] | select(.name == $name)] | length' "$task_definition_file")"
if [[ "$container_matches" != "1" ]]; then
  available_containers="$(jq -r '[.containerDefinitions[].name] | join(", ")' "$task_definition_file")"
  echo "::error::Expected exactly one container named $CONTAINER_NAME; found $container_matches. Available: $available_containers"
  exit 1
fi

jq \
  --arg name "$CONTAINER_NAME" \
  --arg image "$IMAGE_URI" \
  --arg internalMetricsSecretArn "$internal_metrics_secret_arn" \
  --argjson taskSecretOverrides "$task_secret_overrides" \
  --argjson taskSecretRemovals "$TASK_SECRET_REMOVALS_JSON" \
  --argjson taskEnvOverrides "$task_env_overrides" \
  --argjson taskConfigurationRemovals "$TASK_CONFIGURATION_REMOVALS_JSON" \
  '
    del(
      .taskDefinitionArn,
      .revision,
      .status,
      .requiresAttributes,
      .compatibilities,
      .registeredAt,
      .registeredBy
    )
    | ($taskSecretOverrides | map(.name)) as $taskSecretNames
    | ($taskEnvOverrides | map(.name)) as $taskEnvNames
    | .containerDefinitions |= map(
        if .name == $name then
          .image = $image
          | if $internalMetricsSecretArn != "" then
              .secrets = (
                (.secrets // [])
                | map(select(.name != "INTERNAL_METRICS_TOKEN"))
                + [{
                    name: "INTERNAL_METRICS_TOKEN",
                    valueFrom: $internalMetricsSecretArn
                  }]
              )
              | .environment = (
                  (.environment // [])
                  | map(select(.name != "INTERNAL_METRICS_ENABLED"))
                  + [{name: "INTERNAL_METRICS_ENABLED", value: "true"}]
                )
            else .
            end
          | .secrets = (
              ((.secrets // [])
                | map(
                    select(
                      .name as $existingName
                      | ($taskSecretNames | index($existingName)) == null
                        and ($taskSecretRemovals | index($existingName)) == null
                    )
                  ))
              + $taskSecretOverrides
            )
          # AFTER the INTERNAL_METRICS_ENABLED branch above, so an override
          # naming that variable wins rather than racing it. Ordering matters
          # only for that one name — it is the sole entry this script otherwise
          # writes into `.environment` — and "the explicit override wins" is the
          # answer that stays true if a second special case is ever added.
          | .environment = (
              ((.environment // [])
                | map(
                    select(
                      .name as $existingName
                      | ($taskEnvNames | index($existingName)) == null
                        and ($taskConfigurationRemovals | index($existingName)) == null
                    )
                  ))
              + $taskEnvOverrides
            )
        else . end
      )
  ' \
  "$task_definition_file" >"$rendered_task_definition_file"

new_task_definition="$(aws ecs register-task-definition \
  --cli-input-json "file://$rendered_task_definition_file" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)"

one_shot_run_task_args=()
if [[ "$RUN_MIGRATIONS" == "true" || -n "$PRE_DEPLOY_TASK_COMMAND_JSON" || -n "$POST_DEPLOY_TASK_COMMAND_JSON" ]]; then
  network_configuration="$(jq -c '.services[0].networkConfiguration' <<<"$service_json")"
  if [[ -z "$network_configuration" || "$network_configuration" == "null" ]]; then
    echo "::error::ECS service $APP has no network configuration for the migration task."
    exit 1
  fi

  one_shot_run_task_args=(
    ecs run-task
    --cluster "$CLUSTER"
    --task-definition "$new_task_definition"
    --count 1
    --network-configuration "$network_configuration"
  )

  capacity_provider_strategy="$(jq -c '.services[0].capacityProviderStrategy // []' <<<"$service_json")"
  if [[ "$capacity_provider_strategy" != "[]" ]]; then
    one_shot_run_task_args+=(--capacity-provider-strategy "$capacity_provider_strategy")
  else
    launch_type="$(jq -r '.services[0].launchType // "FARGATE"' <<<"$service_json")"
    one_shot_run_task_args+=(--launch-type "$launch_type")
    platform_version="$(jq -r '.services[0].platformVersion // empty' <<<"$service_json")"
    if [[ -n "$platform_version" ]]; then
      one_shot_run_task_args+=(--platform-version "$platform_version")
    fi
  fi
fi

if [[ "$RUN_MIGRATIONS" == "true" ]]; then
  # `node`, not `bun`: the runtime stage is node:*-slim and carries no bun.
  # `packages/api`, not `packages/backend`: this repo has no backend package.
  # `dist/db/migrate.js`: an entrypoint of build.ts, so it exists in the image.
  # Both flags are REQUIRED by the migrator and have no defaults — a run that
  # does not state its target cannot be checked against the connection string
  # it was handed, and a migration aimed at the wrong database does not fail,
  # it reports success over an untouched one.
  #
  # The PATH is now `MIGRATION_ENTRYPOINT` rather than a literal, because two
  # packages in this repository ship a migrator against two different databases.
  # Everything else about the invocation is unchanged and stays asserted verbatim
  # by test-deploy-ecs-image.sh.
  if ! run_one_shot_command \
    "Migration (phase=$MIGRATION_PHASE, target=$MIGRATION_TARGET_DATABASE)" \
    "$(jq -cn \
      --arg entrypoint "$MIGRATION_ENTRYPOINT" \
      --arg target "--target-database=$MIGRATION_TARGET_DATABASE" \
      --arg phase "--phase=$MIGRATION_PHASE" \
      '["node",$entrypoint,$target,$phase]')"; then
    exit 1
  fi
fi

# This runs on the newly registered image after its additive migration, but
# before ECS is updated. A failure leaves the old service revision untouched.
if [[ -n "$PRE_DEPLOY_TASK_COMMAND_JSON" ]]; then
  if ! run_one_shot_command "Pre-deploy readiness" "$PRE_DEPLOY_TASK_COMMAND_JSON"; then
    exit 1
  fi
fi

if [[ -n "${DEPLOY_SHA:-}" ]]; then
  echo "Re-verifying origin/main immediately before the ECS service update."
  bash "$DEPLOY_HEAD_GUARD_SCRIPT"
fi

if ! aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$APP" \
  --task-definition "$new_task_definition" \
  --desired-count "$service_desired_count" \
  --deployment-configuration '{
    "deploymentCircuitBreaker": {"enable": true, "rollback": true},
    "minimumHealthyPercent": 100,
    "maximumPercent": 200
  }' \
  >/dev/null; then
  echo "::error::ECS rejected the service update; restoring the previous task definition defensively."
  # At zero capacity there is nothing to restore TO: no task is running, so the
  # "previous image" is not serving either, and rollback_service would sit in
  # wait_for_service_rollout until MAX_WAIT_SECS waiting for a steady state that
  # cannot arrive. Say that instead of spending twenty minutes proving it.
  if [[ "$zero_capacity_deploy" == "true" ]]; then
    echo "::error::$APP is at desiredCount=0, so no rollback was attempted: nothing is running to roll back from, and the service is still pointed at $current_task_definition."
    exit 1
  fi
  if ! rollback_service; then
    echo "::error::The defensive rollback also failed; manual intervention is required."
  fi
  exit 1
fi

# The ROLLOUT is the only thing here that would be a lie, so it is the only
# thing skipped: a rollout at desiredCount 0 reaches "COMPLETED" with zero
# running tasks, which is exactly the plausible-looking green this estate keeps
# getting caught by. The post-deploy one-shot is neither a lie nor optional.
#
# It runs as its OWN ECS task — run_one_shot_command calls `ecs run-task`, not
# the service — so the service's capacity has nothing to do with it. The `pre`
# run above is the positive control: it launches and succeeds at this same
# desiredCount=0, by the same mechanism, on the same revision.
#
# And zero capacity is the one condition under which `post` is unconditionally
# SAFE. A `post` statement is defined as one that breaks a write the previous
# image performs; with zero tasks running there is no previous image, and no
# such write. The rule that defers it has no subject here.
#
# Deferring it anyway is what caused the incident this block was rewritten for.
# @oxyhq/db records migration progress as a high-water mark and cannot skip a
# hole (see planMigrationRun in its migrate/phases), so the NEXT release's `pre`
# run is BLOCKED behind the unapplied `post` one and that deploy fails at its
# migration step — before ever reaching the post-deploy task that was supposed
# to catch up. So "it applies on the first deploy after the service is scaled
# up" is FALSE: every deploy in between fails, and a human has to clear it with
# a `--phase=all` one-shot. Measured in alia: four consecutive merges deployed
# red behind an unapplied 0016 while every one of their PRs was green.
if [[ "$zero_capacity_deploy" == "true" ]]; then
  if [[ -n "$POST_DEPLOY_SMOKE_SCRIPT" ]]; then
    # Skipped, and named rather than silently omitted. Every smoke script in
    # this estate asserts HTTP against the service's own public origin, so with
    # zero running tasks it can only fail on a target group with no healthy
    # member, or "pass" against something in front that is not this image.
    # Neither outcome measures the release, and a rollback over either is
    # meaningless when nothing is serving.
    echo "::warning::NO ROLLOUT PERFORMED: post-deploy smoke checks were SKIPPED ($POST_DEPLOY_SMOKE_SCRIPT). With zero running tasks they cannot reach this image, so they could only fail or mislead."
  fi

  if [[ -n "$POST_DEPLOY_TASK_COMMAND_JSON" ]]; then
    if ! run_one_shot_command \
      "Post-deploy reconciliation" \
      "$POST_DEPLOY_TASK_COMMAND_JSON"; then
      # No rollback, for the same reason update-service does not roll back here:
      # nothing is running to roll back FROM, and rollback_service would sit in
      # wait_for_service_rollout until MAX_WAIT_SECS waiting for a steady state
      # that cannot arrive.
      echo "::error::Post-deploy reconciliation failed at desiredCount=0. $APP is left pointed at $new_task_definition with the post phase UNAPPLIED, and no rollback was attempted because nothing is running to roll back from. Resolve it before the next deploy: a later pre-phase migration queued behind an unapplied post one is refused, which fails that deploy at its migration step."
      exit 1
    fi
  fi

  echo "::warning::NO ROLLOUT PERFORMED: ECS service $APP is at desiredCount=0 and is running ZERO tasks."
  echo "::warning::NO ROLLOUT PERFORMED: the task definition WAS registered and the service now points at it: $new_task_definition"
  echo "::warning::NO ROLLOUT PERFORMED: image $IMAGE_URI is NOT live and $APP is serving NOTHING. This deploy released nothing to users."
  # Which phases ran, stated rather than implied. A reader of this log has to be
  # able to tell a schema that is fully migrated from one that is half migrated,
  # and "NO ROLLOUT PERFORMED" is silent about both.
  if [[ "$RUN_MIGRATIONS" == "true" && -n "$POST_DEPLOY_TASK_COMMAND_JSON" ]]; then
    echo "::warning::NO ROLLOUT PERFORMED: MIGRATIONS DID RUN — phase=$MIGRATION_PHASE before the repoint and the post-deploy one-shot after it. The schema is fully migrated; only the rollout was skipped."
  elif [[ "$RUN_MIGRATIONS" == "true" ]]; then
    echo "::warning::NO ROLLOUT PERFORMED: MIGRATIONS DID RUN — phase=$MIGRATION_PHASE before the repoint. This release carries no post-deploy one-shot."
  fi
  echo "::warning::NO ROLLOUT PERFORMED: to run this image, raise desired_count in oxy-infra terraform and deploy again."
  exit 0
fi

echo "Deploying immutable image $IMAGE_URI with task definition $new_task_definition"

if ! wait_for_service_rollout "$new_task_definition" "deployment"; then
  if ! rollback_service; then
    echo "::error::Deployment and explicit rollback both failed; manual intervention is required."
  fi
  exit 1
fi
echo "ECS rollout reached a healthy steady state at $new_task_definition"

if [[ -n "$POST_DEPLOY_SMOKE_SCRIPT" ]]; then
  echo "Running post-deploy smoke checks with $POST_DEPLOY_SMOKE_SCRIPT"
  smoke_exit=0
  bash "$POST_DEPLOY_SMOKE_SCRIPT" || smoke_exit=$?
  if (( smoke_exit == SMOKE_NO_ROLLBACK_EXIT )); then
    # The smoke script attributed every failure to something outside the image.
    # The release keeps going — including the reconciliation task below, which
    # would otherwise be skipped over a fault it has nothing to do with — and the
    # job fails at the end so the failure is still paged rather than swallowed.
    echo "::error::Post-deploy smoke checks failed only checks that a rollback cannot repair. $APP stays on $new_task_definition; investigate the dependency named above."
    smoke_reported_external_failure=true
  elif (( smoke_exit != 0 )); then
    echo "::error::Post-deploy smoke checks failed."
    if rollback_service; then
      echo "::warning::Rollback completed after smoke failure."
    else
      echo "::error::Rollback also failed; manual intervention is required."
    fi
    exit 1
  fi
fi

if [[ -n "$POST_DEPLOY_TASK_COMMAND_JSON" ]]; then
  if ! run_one_shot_command \
    "Post-deploy reconciliation" \
    "$POST_DEPLOY_TASK_COMMAND_JSON"; then
    echo "::error::Post-deploy reconciliation failed."
    if ! rollback_service; then
      echo "::error::Reconciliation and rollback both failed; manual intervention is required."
    fi
    exit 1
  fi
fi

if [[ "$smoke_reported_external_failure" == "true" ]]; then
  echo "::error::$APP is deployed and live at $new_task_definition, but its post-deploy smoke checks are still failing on a dependency. Nothing was rolled back; this release needs a human."
  exit 1
fi

echo "Deployed $APP at $new_task_definition"
