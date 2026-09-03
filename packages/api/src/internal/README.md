# Internal modules

This directory contains implementation details and exposes no public module tree.

`internal/providers/lib` retains only Kaana routing-profile catalogue metadata and
generation helpers. It must not store or read an upstream credential, construct a
provider SDK client, choose a provider key, perform provider fallback, track provider
health or expose a provider administration endpoint. Hosted inference crosses the typed
Kaana transport after Oxy supplies the request's authorized routes.

User-connected local runtimes are a separate boundary. They execute on an explicit user
binding and do not make a user provider key available to the hosted Alia or Kaana path.

Provider names may appear in catalogue provenance and immutable migration history, but
product responses use Kaana routing-profile identity. New hosted-provider functionality
belongs in Kaana, not under this directory.
