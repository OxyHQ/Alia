# Published machine-chat SDK adoption

Alia adopts registry core4.4.0 and contracts4.9.1 after the coordinated Oxy backend/migration acceptance. Independent review compared all585core and198contracts files and17SDK dependency edges. Source runtime retains the separate machine principal, caller payer, empty tools and restricted chat endpoints.

API2058tests/195suites pass, with one existing skipped test. API/app types, API build/lint pass. The earlier prefix-census failure is retained: its old list omitted the now-supported Oxy Console prefix; the guard continues to reject any new Alia-owned key type. Historical unpublished-fixture evidence remains dated and unchanged.

Fresh Bun1.3.14 lock resolution is reproducible. Its only new identities are the two SDK versions; a GoogleGenAI optional MCP peer moves between two already-present compatible versions, explicitly recorded in the lock audit. No hand-edited lock or broad override was introduced.

This proof does not substitute for CI, image/deployment acceptance, a real Console owner's key lifecycle, funded machine generation or a personal chat session.
