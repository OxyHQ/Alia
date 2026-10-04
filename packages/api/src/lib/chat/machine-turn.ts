import type { Request } from 'express';
import { getOxyAliaMachineCredentialBearer, type OxyAliaMachinePrincipal } from '@oxy.so/core/server';

const MACHINE_CHAT_FIELDS = new Set([
  'messages', 'input', 'model', 'stream', 'temperature', 'top_p', 'max_tokens',
  'max_completion_tokens', 'reasoning_effort', 'response_format', 'stop', 'seed',
  'presence_penalty', 'frequency_penalty',
]);

/** Validate before model/context/tool work. No product state is inferred from the payer. */
export function admitMachineTurn(req: Request): { bearer: string } | { error: string } | null {
  const principal = (req as Request & { machineCredential?: OxyAliaMachinePrincipal }).machineCredential;
  if (!principal) return null;
  const bearer = getOxyAliaMachineCredentialBearer(req);
  if (!bearer) return { error: 'MACHINE_CREDENTIAL_CONTEXT_INVALID' };
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
    || Object.keys(req.body).some(key => !MACHINE_CHAT_FIELDS.has(key))) {
    return { error: 'MACHINE_PRODUCT_AUTHORITY_UNSUPPORTED' };
  }
  // A local runtime belongs to a signed-in person, never the financial owner
  // of an application. No runtime, memory, agent or connector selectors here.
  if (typeof req.body.model === 'string' && req.body.model.startsWith('local/')) {
    return { error: 'MACHINE_PRODUCT_AUTHORITY_UNSUPPORTED' };
  }
  return { bearer };
}
