# @alia-codea/cli

## 3.1.0

Ctrl+C requests authenticated Stop for the current generation and waits for its
acknowledgement before closing the stream. Every tool continuation has its own
turn ID; Stop blocks further tools, including approvals resolved late. Incidental
teardown and broken output pipes only detach. Account changes fence both lanes. Acknowledged Stop retains visible partial text
without incomplete tool calls; account teardown never saves that partial reply.

Uses the shared server SDK 1.3.1 wire parser and removes the unused OpenAI dependency.
Requires Node 22 or newer, matching the shared SDK and current CLI dependencies.

## 3.0.2

Uses core 7.1 linked transports for chat and the public model catalogue.
Refresh, redirect protection and account switching use the shared session;
catalogues no longer persist across accounts. CLI commands and options remain unchanged.
