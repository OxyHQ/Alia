/** Fail closed before Alia listens unless its Oxy inference lane is complete. */

import {
  OXY_API_URL_ENV,
} from './oxy-inference-credential.js';
import {
  oxyInferenceEndpointRefusal,
  resolveOxyDeploymentEnvironment,
  unsetOxyInferenceVariables,
} from './oxy-inference.js';

/** Why this task cannot use Oxy inference, or `null` when it can. */
export function oxyInferenceBootConfigurationFailure(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const unset = [
    ...unsetOxyInferenceVariables(env),
  ];
  const uniqueUnset = [...new Set(unset)].sort();
  if (uniqueUnset.length > 0) {
    return `the Oxy inference client is required but these variables are not set: ${uniqueUnset.join(', ')}`;
  }

  return oxyInferenceEndpointRefusal(
    (env[OXY_API_URL_ENV] ?? '').trim(),
    resolveOxyDeploymentEnvironment(env),
  );
}
