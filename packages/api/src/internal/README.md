# Internal modules

This directory contains implementation details and exposes no public module tree.

`internal/providers/lib` retains only billing seeds (features, credit packages) and
the operator-name list the error sanitiser reads. The model catalogue is Oxy's
(`lib/models/catalogue.ts`, ADR 0012). It must not store or read an upstream credential, construct a
provider SDK client, choose a provider key, perform provider fallback, track provider
health or expose a provider administration endpoint. Hosted inference crosses the typed
Kaana transport after Oxy supplies the request's authorized routes.

User-connected local runtimes are a separate boundary. They execute on an explicit user
binding and do not make a user provider key available to the hosted Alia or Kaana path.

Model and publisher names are shown on the product surface; the serving operator and
deployment ids are not. New hosted-provider functionality
belongs in Kaana, not under this directory.
