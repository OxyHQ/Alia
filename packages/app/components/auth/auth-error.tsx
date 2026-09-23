import { Admonition } from '@oxy.so/bloom/admonition';

export interface AuthErrorProps {
  message: string;
}

/** A form's error, as Bloom's error callout; nothing when there is none. */
export function AuthError({ message }: AuthErrorProps) {
  if (!message) return null;
  return <Admonition type="error">{message}</Admonition>;
}
