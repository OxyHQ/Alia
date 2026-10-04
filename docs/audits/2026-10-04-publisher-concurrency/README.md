# Reviewed publisher concurrency

CI37155268642 stopped at the exact concurrency-workflow census because the new
publisher had not been classified. Add it as serialised: immutable ECR tag
publication must not cancel an in-flight publication or run concurrently in the
same repository. The existing checks enforce false cancellation and a stable
group. No roles, source/image guards, runtime, registry or deployment changes.

The canonical check passes. Four controls run against temporary YAML copies:
current source, cancellation enabled, group changed to per-SHA, and an unknown
workflow. All negative mutations are rejected and temporary copies removed.
