# Oxy organizations and Alia workspaces

Oxy owns organization identity and authority. Alia keeps a workspace reference (`organizations.oxy_account_id`), its historical ID and slug, product settings, credits, Stripe reference and shared-agent relationships. Name and avatar come from the canonical directory, deduplicated across each result set and fetched in batches of at most 100. Missing/suppressed identities are withheld; directory failures return an unavailable response rather than an archived name.

This change does not migrate or modify the financial ledger. Existing workspace credit/customer fields retain their values. `_id`, `id`, nested `credits.paid` and settings remain in the response for callers authorized to see them. Workspace deletion is refused after the canonical permission check because billing and sharing history must be retained. An organization rename or ownership change in Oxy never rewrites a historical Alia record.

## Authority

Every request uses a disposable canonical SDK client with the original verified human bearer and caching disabled. The shared authentication client never receives a person's token. Machines do not inherit human membership. Public directory requests omit authorization.

| Alia operation | Required active Oxy organization permission |
| --- | --- |
| Read workspace or list it | `account:read` |
| Register workspace | `account:update`, owner/admin role, active claimed organization |
| Read financial fields | `billing:read` |
| Change billing contact | `billing:manage` |
| Change API call limit | `account:update` |
| List members | `members:read` |
| List invitations | `members:read` |
| Invite / resend invitation | `members:invite` |
| Cancel invitation | `members:remove` |
| Update / remove member | `members:update` / `members:remove` |
| List shared agents | `apps:read` |
| Share / unshare agent | `apps:update` |

Effective permissions come from Oxy, including explicit grants, revocations and inherited memberships. Mere membership never grants an edit. Viewer/developer baseline roles cannot change workspace settings, members or agent sharing. Billing may change the billing contact, but not the API limit. An admin's baseline does not imply `billing:manage`.

Sharing an agent additionally requires a fresh Oxy bot-operator check and the requesting person to be its recorded owner. It creates only the Alia sharing relationship; it does not delegate the owner's Oxy app data. Existing actor/present-owner checks and immutable financial receipts are unchanged.

The member endpoints operate on the **whole Oxy organization**, not an Alia-only roster. Responses explicitly carry `membershipScope: "organization"`; a future management UI must label that scope. Oxy enforces mutation scope, inherited-member restrictions and ownership protection. Nobody is added directly: `POST /organization/:id/invitations` (email and role) creates an Oxy invitation, and the person joins only after accepting it at accounts.oxy.so/invitation. `GET`, `POST …/:invitationId/resend` and `DELETE …/:invitationId` list, resend and cancel pending invitations. The former direct-add `POST /organization/:id/members` answers 410. Alia cannot invite an owner or transfer legacy members implicitly. No current organization-management UI exists in the app; the old invitation URL now shows plain guidance to ask an administrator for access in Oxy.

## Legacy evidence

`organization_identity_archives` preserves the former name, description, image and local owner ID as immutable source evidence. `organization_members` and `organization_invites` become frozen historical metadata, with no runtime authorization or invitation read/write path. They are removed from the expiry writer. The post migration destroys the reusable invitation token column without copying it into another archive. Former `pending` values describe historical state only; old links always return 410.

A local owner or membership record does not prove Oxy authority. Backfill links a workspace to an existing Oxy organization only through reviewed source evidence. It does not create organizations, match names, transfer members, assert ownership or transfer verification. Stable workspace slugs are domain URL keys, not a second company username.

## Rollout and guarded backfill

The read-only live inventory on 2026-10-15 found zero organizations, members, invitations and shared agents, with 94 applied migrations. This is evidence for this deployment, not a permanent zero-row assumption.

1. Deploy Oxy's organization APIs and publish the canonical contracts/core SDK first; adopt registry versions with their lockfile. Local SDK archives are only isolated verification artifacts and must not enter dependency manifests.
2. The normal deploy executor applies `0096_central_organization_references` in `pre`. One transaction archives existing identity, freezes old authority/identity writers and makes old required identity columns nullable. Reference-only inserts from the new image work before post. The rolling interval deliberately blocks old organization writes; schedule a short organization-write maintenance window.
3. Roll the new image and drain old tasks. The existing pipeline then runs `0097_retire_local_organization_identity` in `post`. It locks/checks every canonical mapping and exact archived identity before dropping local identity/owner fields and invitation secrets. New reference rows need no fabricated legacy name. All IDs, slugs, foreign relationships, credits and customer/settings fields remain untouched.
4. If unexpected legacy rows exist, post refuses before dropping anything. Complete the reviewed mapping procedure below before retrying post. Keep the reference-aware image during this window; the old image cannot safely resume frozen identity writes. The pipeline may roll back a failing deployment, so inventory and complete any nonempty mapping plan before allowing the rollout to reach post. No post success is claimed merely from the observed zero-row inventory.
5. Verify counts and relationships and retain the reviewed plan/evidence. After post, roll forward or restore a reviewed database backup; do not recreate an editable local identity registry. Financial reconciliation is outside this identity change and remains subject to ADR 0005.

Use the existing ECS one-shot executor with the live service networking and role. No tunnel or new ingress is needed. The CLI checks the database against both the configured URL and the connected database. It is dry-run by default:

```sh
bun packages/api/dist/scripts/backfill-workspace-organizations.js \
  --target-database=alia --reviewed-mappings=/secure/mappings.json \
  --plan-output=/secure/workspace-plan.json

bun packages/api/dist/scripts/backfill-workspace-organizations.js \
  --target-database=alia --reviewed-mappings=/secure/mappings.json \
  --apply --plan-sha256=<reviewed-sha256>
```

Mappings are `{ "workspaceId": "historical-id", "accountId": "canonical-oxy-id", "evidenceReference": "reviewed-source-record" }`. Review source ownership/application evidence, never just matching names. The private plan (0600, refuses overwrite) includes source identity, retained credit/customer values, relationship counts and exact mappings, without invitation tokens or auth credentials. The operation's authorized staff session is supplied through `OXY_ADMIN_ACCESS_TOKEN`, never stored or logged. Source namespace is `alia`, external ID is the historical workspace ID.

Apply requires the exact reviewed hash. Duplicate/conflicting mappings are rejected. Oxy's source mapping is idempotent and cannot overwrite canonical facts; each successful remote mapping is followed by a local null-or-same compare-and-set outside a network-spanning transaction. Retry after partial completion requires a fresh plan/hash. Multiple old workspaces cannot be silently folded into one account: the unique reference gate requires a separate reviewed domain-data consolidation.

The populated PostgreSQL replay exercises old records, pre freeze, reference-only inserts, refusal before mapping, actual CLI dry-run/stale-hash/apply, post, preserved financial/shared-agent records, immutable evidence and destroyed invite secrets. HTTP tests use the real canonical SDK and local Oxy protocol fixture to verify bearer isolation, permissions, bounded hydration and unavailable behavior. No production mutation is part of those tests.
