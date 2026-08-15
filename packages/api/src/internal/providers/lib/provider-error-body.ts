/**
 * The one way an upstream provider's error body becomes a string this process
 * keeps.
 *
 * ## Why this is a chokepoint and not a fix at the log sites
 *
 * An upstream error body is attacker-influenced text that Alia forwards
 * verbatim, and a provider's 401 echoes the credential it just rejected —
 * OpenAI's begins `{"error":{"message":"Incorrect API key provided: sk-…"}}`.
 * Once that text exists as a plain string it reaches CloudWatch through any of
 * the 500-odd log sites that pass an error object, and
 * `provider_keys.last_failure_reason` besides. Redacting at each of those is a
 * fix that decays; redacting where the string is BORN means the unredacted body
 * never exists as a variable at all.
 *
 * Every `.text()` on a provider response in `internal/providers/` goes through
 * here, and `architectureGates.test.ts` gate 4 asserts that — the census fails
 * on a new `.text()` in the provider tree outside this file.
 *
 * ## Two redactions, because they fail differently
 *
 * 1. **The credential we sent**, matched EXACTLY. Shape-independent by
 *    construction: it catches the key bare, inside a URL, inside a JSON error
 *    object, and TRUNCATED to any run of {@link MIN_CREDENTIAL_RUN} characters
 *    or more, because it matches the value rather than a spelling of it. This
 *    is the only thing that can cover a provider whose keys have no
 *    distinctive prefix at all (Mistral, Cohere, Together, SambaNova and
 *    others are opaque strings), where no pattern can help.
 * 2. **{@link redactSecrets}**, for credentials this call did NOT send: a key
 *    for another account, a token the provider quotes back from the request, a
 *    connection string in a stack trace.
 *
 * The pattern pass runs FIRST and the exact pass second, and the order is
 * load-bearing. Reversed, an exact run of eight characters — `sk-proj-`, which
 * every OpenAI project key starts with — would consume the prefix of somebody
 * ELSE's key, leaving a tail the pattern pass can no longer recognise. Running
 * patterns first consumes whole well-formed tokens before any prefix is eaten.
 *
 * ## What it does not cover, stated rather than implied
 *
 * A credential belonging to another account, from a provider with no
 * distinctive prefix, echoed by a provider we did not send it to. Nothing here
 * or in {@link redactSecrets} can see that, and neither can a reviewer. A
 * base64 or Basic-auth encoding of our own credential is also not matched; no
 * Alia adapter sends one, which is what makes that acceptable rather than
 * ignored.
 */

import { redactSecrets } from '../../../lib/agent/secret-scanner.js';

/**
 * Bound on the text kept from an upstream body.
 *
 * Truncation happens AFTER redaction, so a credential cannot survive by
 * straddling the cut — the cut only ever falls inside already-scrubbed text.
 */
const MAX_BODY_CHARS = 1000;

/**
 * Shortest run of the credential that is redacted where it appears.
 *
 * Eight is short enough to catch a truncated echo — a provider that rejects a
 * key often quotes only its first characters back (`sk-proj-AAAAAA…`) — and
 * long enough that it is not matching ordinary prose.
 *
 * The example above is deliberately synthetic. A real key prefix does not
 * belong in this repository: it is public, and naming one identifies which
 * credential leaked to anyone reading.
 */
const MIN_CREDENTIAL_RUN = 8;

const CENSOR = '[REDACTED]';

/**
 * Replace every run of `credential` at least {@link MIN_CREDENTIAL_RUN} long.
 *
 * One left-to-right scan: find the leading run, extend it as far as the
 * credential continues, and drop what matched. A partial echo is therefore
 * removed as a partial echo, not missed for not being the whole value.
 */
function stripCredentialRuns(text: string, credential: string): string {
  if (credential.length < MIN_CREDENTIAL_RUN) return text;

  const marker = credential.slice(0, MIN_CREDENTIAL_RUN);
  let out = '';
  let from = 0;

  for (;;) {
    const at = text.indexOf(marker, from);
    if (at === -1) return out + text.slice(from);

    let run = MIN_CREDENTIAL_RUN;
    while (run < credential.length && text[at + run] === credential[run]) run += 1;

    out += text.slice(from, at) + CENSOR;
    from = at + run;
  }
}

/**
 * Scrub text that came back from a provider, given the credential it was sent
 * with. Safe to call with an empty credential — the pattern pass still runs.
 */
export function redactProviderText(text: string, credential: string): string {
  const scrubbed = stripCredentialRuns(redactSecrets(text).redacted, credential);
  const encoded = encodeURIComponent(credential);
  const full = encoded === credential ? scrubbed : stripCredentialRuns(scrubbed, encoded);

  return full.length > MAX_BODY_CHARS ? `${full.slice(0, MAX_BODY_CHARS)}…` : full;
}

/**
 * Read a failed provider response's body, redacted and bounded.
 *
 * Never throws: a body that cannot be read becomes the status line, which is
 * what the three hand-rolled versions of this did — inconsistently, one of
 * them without the guard at all.
 */
export async function readProviderErrorBody(response: Response, credential: string): Promise<string> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    body = `HTTP ${response.status} (body unreadable)`;
  }
  return redactProviderText(body, credential);
}
