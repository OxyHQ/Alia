Conditional avatar GET/HEAD requests used strict string equality in both the R2 and Cache API paths. A client sending `If-None-Match: W/"same"` received200 even when the selected representation had `ETag: "same"`. Tag lists and `*` also failed. This was our protocol bug, not solely an edge transformation.

Apply the weak comparison required by [RFC9110§13.1.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2). Parse quoted entity tags without splitting commas inside their opaque values, support lists and existing-resource wildcards, and keep distinct validators separate. Malformed conditions never produce a false304; missing resources remain404.

No runtime, assets, public URLs, storage writes, cache keys or package versions change.

Validation: all23 existing/expanded Worker, publication and real-workerd HTTP tests pass. The new checks cover GET/HEAD, strong/weak/list/wildcard/nonmatching conditions, both URL families, R2 misses and cache hits, byte identity, no leaked internal cache marker and no extra R2 reads on cache hits. A direct before/after comparison using current main confirms200→304 for the same weak validator on both owned paths. Public edge behavior will be rechecked after normal deployment; the earlier q=0 conditional200 evidence remains historical evidence, not an accepted protocol exemption.
