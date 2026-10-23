/** Protocol between the Alia API and its integrations process, not end-user authentication. */
import { ALIA_APPLICATION_ID } from './identity.js';
export { ALIA_APPLICATION_ID, ALIA_SERVICE_AUDIENCE } from './identity.js';

/** Registry handles of the deployment's exact AWS task roles. Never API keys. */
export const ALIA_API_WORKLOAD_ID = 'wl_d50a0056191d0448024900b4';
export const ALIA_INTEGRATIONS_WORKLOAD_ID = 'wl_9aa00c7726a03a40d670b0cb';
export const ALIA_ACCOUNT_CONTEXT_HEADER = 'x-alia-account-context';
export const ALIA_CHANNEL_HEADER = 'x-alia-channel';
export const ALIA_PLATFORM_USER_HEADER = 'x-alia-platform-user';

export function isAliaWorkload(
  principal: { authority?: string; applicationId: string; credentialId: string } | undefined,
  expectedWorkloadId: string,
): boolean {
  return (
    principal?.authority === 'first_party' &&
    principal.applicationId === ALIA_APPLICATION_ID &&
    principal.credentialId === expectedWorkloadId
  );
}
export const ALIA_CHANNEL_SESSION_HEADER = 'x-alia-channel-session';

export type AliaChannelIdentity =
  | { kind: 'bot'; platformUserId: string }
  | { kind: 'account'; sessionId: string };
