Cloudflare's production Cache API can return decoded binary bytes while retaining `Content-Encoding: gzip`. Fresh misses downloaded correctly, but repeated requests failed decompression. The public wire canary caught this despite passing local workerd tests.

Cache gzip payloads as opaque bytes with an internal encoding marker, then restore the public encoding only at delivery. The marker never leaves the Worker. A new internal binary cache key avoids previous entries; public URLs, runtime revision, assets, ETags and nonbinary compression remain unchanged.

Validation: 21 Worker/uploader/real-workerd HTTP tests pass, including an adversarial cache that decodes encoded bodies while retaining headers, GET/HEAD/304, both URL families, exact SHA, q=0 and repeated hits. Public browser/native and repeated wire canaries will be rerun after deployment.
