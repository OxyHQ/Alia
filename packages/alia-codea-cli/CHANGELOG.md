# @alia-codea/cli

## 3.3.1

`codea connect` lets the agent edit files in its working directory by default: read-only made Claude
Code and Codex answer "I don't have permission" to almost anything. Start it with `--read-only` to
forbid changes, and the agent then says how to lift that instead of just refusing. Run it from the
folder you want the agent to work in.

## 3.3.0

`codea connect` serves Claude Code, Codex or OpenCode to Alia as one of your agents
([ADR 0028](../../docs/adr/0028-external-agents.md)). Create a code in Alia (Settings → Connect an
external agent), paste the text it gives you into your agent, and it runs
`codea connect --code <code> --cli <claude|codex|opencode>`. The process dials Alia outbound with your
Oxy session and answers the messages Alia sends it by running the CLI you are already signed in to, in
the current directory, read-only unless started with `--write`. Run `codea connect` again to serve the
agents this machine is paired with.

## 3.2.0

`codea login` prints the request's short comparison code (`CE7F-B31F`,
`deviceComparisonCode` from core 7.9) instead of all thirty-two characters of the
authorize code: the same code `auth.oxy.so/device` now prints, so the two can
actually be compared. The full code still travels in the link and the QR and is
the only thing that approves. Uses core 7.9.

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
