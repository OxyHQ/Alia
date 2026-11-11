# Requester authority, own tools and external MCP

How an action Alia (or an agent) takes inside an Oxy product is authorized. The
decision is [ADR 0022](./adr/0022-first-party-platform-authority.md) and
[Oxy ADR 0049](https://github.com/OxyHQ/oxy/blob/main/docs/adr/0049-first-party-platform-authority.md);
Oxy's wire-level contract (requester proofs, tasks, tickets) is
[first-party-tasks.md](https://github.com/OxyHQ/oxy/blob/main/docs/auth/first-party-tasks.md).
Who the actors are is [Actors](./actors.mdx); how tools are built from catalogues
is [Integrations](./integrations.mdx#oxy-apps).

## Own applications and agents

Oxy-owned applications use registered workload identity and the shared
`OxyServer` SDK. A verified `authority: first_party` principal has no scopes.
Application keys and app-bound OAuth sessions remain external even when issued
for an official app. Branding, a hostname or a raw user-id header confers no own
authority.

Alia acts for the original requester. Every agent has a distinct Oxy bot
account. Own tools need no application grants, ceilings, OAuth back into Oxy or
per-app autonomy settings. A live requester, actor, effective account and
original task identify the work. Account membership, resource ownership,
privacy, tenant boundaries, sensitive-operation policy, monetary limits and
cancellation still apply. Skills supply guidance, never authority.

- **Foreground tool:** create an own execution authorization from the actual
  shared-session proof and the live catalogue pin.
- **Background goals and schedules:** create one root task at the authorized
  start and persist its task ID in the product job or session. Child actors keep
  that root's original requester and effective account. Never infer a human
  requester from the bot's owner, and never persist user bearers or connection
  tokens in jobs.
- **`oxy_<app>__*`** operates the original effective account. **`self_<app>__*`**
  operates only the root's exact bot account, and only while the original
  requester has live `account:act_as` authority over it. A stranger using a
  public agent gains neither the agent owner's data nor bot-self privileges.
- Legacy jobs without verifiable provenance start again through an authorized
  request.

## Tool and service calls

Each app registers its own versioned `AppCapabilityCatalog`. Internal and
external tools share definitions and domain behavior. For own execution the
catalogue describes tools, effects, resources, events and audit; it is not a
permission grant. Operation autonomy derives from the original task and the tool
effect, with sensitive-operation limits preserved.

Own tool tickets bind original requester, actor, account, resource, tool,
limits, run, catalogue digest and expiry. The recipient verifies the signature,
the exact audience and live authority immediately before execution. To continue
into Oxy Files, graph or Safety, use the shared SDK's transient
`capabilityTicket` requester proof; Oxy also checks that the live catalogue
belongs to that recipient. A read tool cannot perform a nested write.

Ordinary service calls need no artificial tool registration. Shared service
middleware verifies the incoming caller JWT and task or session proof centrally,
then hands the receiver a signed `requesterContext`. Forward it with
`withRequester` or `createServiceClient` for the next hop. It lasts at most
sixty seconds, never extends its original expiry, and revalidates the root and
every workload in the chain; it cannot create a shared session or durable task.
Never reuse another service's raw task ID, select an account from a resource ID
or replace the requester with an application owner.

## External applications

External OAuth and MCP clients keep explicit scopes and live grants, and their
authority stays external when they reach own services. Oxy is the central OAuth
authorization server (PKCE S256, exact resource and audience binding, explicit
account selection, refresh rotation, revocation). Each app's MCP stays on its
own product domain; there is no aggregate Oxy MCP.

External Mention media tools use the separate
`assets.withMcpMediaRequester({ connectionToken, tool, accountId })` facade. It
preserves `social.media.create`, the actual client and grants, and the
connection's current account; it grants neither global Files access nor own
authority. External delegation grants, ceilings and user consent remain where
they apply.

## Runtime and storage

Alia discovers the live catalogue, chooses an eligible actor and obtains current
authority immediately before each tool operation. Products apply their domain
rules and record requester, coordinator, actor, account, resource and result.
Events bind publisher, effective account and declared event type, and
`(appId, eventId)` is the idempotency key, so a duplicate delivery cannot create
a second effect.

Oxy owns task roots, external grants, account policy, catalogue registrations,
short-lived proofs and audit. Alia owns goals, sessions, automation definitions,
events, runs and steps. Expiry and revocation deny immediately; task
housekeeping retains audit and product history. Provider credentials live only
in Kaana's credential store; model routing is product, Alia, Oxy, Kaana.

## Changing this surface

Deploy environment bindings and compatible readers before changing issuers and
consumers. Depend on released `@oxy.so/*` packages; a candidate tarball is a
validation artifact, never a committed file dependency. Verify real product
operations, caller and account isolation, nested revocation, external consent,
idempotency, and loading from both published Node ESM and Bun. The retired
grant-based own-app model is not a fallback for an incomplete adoption.
