# Pending Bloom document-owner adoption — archive only

This branch preserves the dependent consumer patch, not a release-ready
migration. It imports DocumentScrollRestorationBoundary, which is absent from
this consumer's published Bloom 15.78.0 pin. The manifest and lockfile remain
unchanged. Do not merge this branch or treat it as a passing published build.

Archive base: `a09dd1587c6bddc785e4ccd6e3c4e9b0dbdc77c4`, the original
runtime baseline. Original patch SHA256:
`84e89991cab9a437b946f403783fdf84f962971bec3f7eaf4d6c6875f29a087b`.
The three touched files match the original patch's preimages; the patch applies
without adaptation. The original runtime baseline, confirmed from the task record, was
`a09dd1587c6bddc785e4ccd6e3c4e9b0dbdc77c4` with published Bloom 15.78.0.
This branch preserves that exact base. The companion branch
`archive/bloom-document-owner-pending-release` applies the same patch onto
`09d13ace5bb882976f594c1e27f8bb05fe04fc36`; no new runtime or avatar validation
is claimed for that newer base.

The experiment used an uncommitted Bloom boundary snapshot on top of
`b21e86ec73d08dd0c1ca090c48ab6617e413e847`, package version 15.79.1, with
source-tree SHA256 `0bb72ed678e0f0de2b2182474a7539c9b1c227e12f0f3b56f2269b6abde599c4`.
See the adjacent fingerprint for the dirty-file census and boundary source/build
hashes. Calling this the clean commit's build would be incorrect. The boundary
was subsequently reviewed in OxyHQ/Bloom#559; that is a dependency reference,
not an assertion that its API is in the consumer's installed version.

Scope: connect the Expo router adapter at BloomProvider; retain FocusedPage's
route-specific document restoration; declare that ownership around AiChatShell;
remove the duplicate StatusBar because the installed provider owns the bar.

Historical browser sequence: scroll static route A to 420, leave its app group,
then open a previously unseen static route C. Baseline opened C at 0; adapter-only
opened it at 420; adapter plus boundary opened it at 0. The correction prevents
an app-group owner from applying A's offset to C. It does not fix the separate
store-lifetime limitation: leaving the group still loses A's saved offset in
both baseline and boundary configurations. Chat's special restoration remains.

The local mirror was formally restored; the original worktree's published
15.78.0 typecheck passed after removing this dependent patch. No native device
validation is claimed. The fixture startup synchronization is a separate commit,
not part of the ownership proof. Before integration, select a real published
release with the API, rebase and repeat consumer/browser/type checks. No release
or deployment was performed while archiving; the checkout returns to the clean
archive base once pushed.
