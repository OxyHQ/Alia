# Alia I04/I05/I10 candidate composition

The reviewed I05 source 8392204 and proof 761254 are composed without conflicts
as 3f5f00b9c and 510a07926 over the I04 package plan d5d02f274 / I10 source.
Only the Mention pilot selects internal MCP. No scopes or grants were added.

Whole API types and build pass. Full API suite: 191 files / 2020 tests pass,
1 existing test/file omitted. The first run had 8 audio-fixture failures because
install --ignore-scripts had not installed ffmpeg-static's binary. Its own
install.js completed; the final full suite passed without a product source change.
Both runs are retained. The suite retains its existing core/server mocks; the
I05 HTTP/MCP fixture is the separately reviewed real transport control. This is
candidate compatibility, not live receiver/registry acceptance.

Local package files include the candidate MCP dependency and all coordinated
SDK inputs. They are preserved here as evidence, not committed as release
manifests. Final registry versions and lock, final combined suite, CI and rollout
remain pending. Candidate source 1b505 predates the newest refresh correction.
