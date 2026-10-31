# Independent fixture startup correction

This commit is independent of the pending document restoration API. It keeps
fixture modules synchronous when the development router disables async routes.
The original reproduction was `EXPO_PUBLIC_ALIA_FIXTURES=1` (use the repository's fixture
entry configuration) with the lazy require.context in fixtures/entry.tsx; Metro
reported: `Route "./(app)/__fixtures/[id].tsx" cannot be a promise when async routes are disabled.`

The archived patch SHA256 is `237fca5a742fedfa3358848ff558d8cc3ea94885dd286cec30b9d100a8349dd5`.
Changing fixtureContext to sync allowed the existing restoration scenarios to
start. This is a fixture startup fix, not evidence that the dependent production
boundary compiles against published Bloom 15.78.0. No router mode or production
entry was changed. Revalidate the fixture entry on current main before merging.
