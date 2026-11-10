import { useUserByUsername } from '@oxy.so/services/ui/client';

/**
 * Who `/@username` names when it is not an agent: the public Oxy account of that username, as long
 * as it is not a bot (`kind: 'bot'` is what an agent IS in Oxy). One lookup of Oxy's, the same one
 * its own apps use; Alia keeps no copy of a person.
 *
 * `person` is the account when there is one to show, and `undefined` otherwise (still loading, no
 * such account, or an agent's): the page tells those apart by `isPending`.
 */
export function usePersonProfile(username: string) {
  const query = useUserByUsername(username === '' ? null : username);
  const account = query.data;
  const person = account && account.kind !== 'bot' ? account : undefined;
  return { person, isPending: query.isPending && username !== '', isError: query.isError };
}
