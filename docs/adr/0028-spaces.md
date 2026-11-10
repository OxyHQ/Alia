# 28. A Space groups a person's agents: one room, one brief, one computer, and nobody from outside

Status: Accepted (2026-11-10, the owner's request: "carpetas" in the sidebar that group agents, where
the agents inside talk to each other, share context and can do everything among themselves, and talk
only to each other or to Alia; Alia always stays outside, as the generic chat of the app).
Date: 2026-11-10.

## Context

A group chat (ADR 0025) puts several agents in one conversation, but it is a conversation: members are
fixed when it is created (2 to 6, no add or remove), there is nothing above it that says "these agents
belong together", and the other agents of the person are still reachable from every one of them
(`consultAgent`, `searchAgents`). The sidebar groups Alia's chats in client-side Projects and Folders
(`features/projects`), which hold chats only and live in the browser. `agent_teams` is a server-side
grouping with an API and no UI or consumer; it is not reused here (see Alternatives).

## Decision

1. **The name is Spaces (Espacios).** "Project" and "Folder" are the sidebar's collections of Alia's
   chats, "Room" is the group-chat engine, "Team" is the dormant `agent_teams`. "Space" collides with
   nothing and says what it is: a shared place.
2. **A space is a server entity** (`spaces`): the person, a name, a **brief** (`instructions`, shared by
   every member) and its **room** (`conversation_id`). It is not client-only: it follows the person
   across devices and the API enforces its rules.
3. **Membership is a column on the agent** (`agents.space_id`, `ON DELETE SET NULL`), so an agent is in
   at most ONE space, deleting a space frees its agents, and everything that already has the agent
   record (the sidebar's agent list, the computer resolver, the tool assembler) knows its space without
   a join. Only the person's OWN agents can be members (checked with `loadAgentForActor`, as every agent
   write is), at most `GROUP_MAX_MEMBERS` (6, the room's bound). **Alia is never a member**: members are
   agent rows and she has none; she stays the generic chat outside every space.
4. **The room is the place they talk.** Creating a space creates its room, an ordinary group
   conversation (ADR 0025) titled with the space; its `conversation_members` are kept equal to the
   space's members whenever they change (`syncSpaceRoom`). The engine, the queue, the lock, the bus and
   the mention rules are untouched: the room's roster is simply the space's agents, so adding an agent
   makes it part of the conversation and removing one takes it out. An empty space has no room to open.
5. **Shared context** is three things, in this order of arrival:
   - the **room transcript**, which every member reads whole (ADR 0025);
   - the **brief and the member list**, put in every member's room prompt (`roomPrompt`, carried in the
     room job as `space`) so they act as one team with one purpose;
   - the **computer**: a member on the default (`computer_source = 'alia'`) works on the space's own
     workspace (`space:<spaceId>:user:<userId>`), the same machine for all of them, when the person is
     the owner (`resolveComputerActor`). A member whose owner chose `own` keeps its own machine; for
     anyone else it is the agent's own per-person machine. A shared notes memory is a later step.
6. **"Only each other, or Alia."** A member's reach is cut to its space, server-side, where the tools
   are assembled (`ToolPipeline`, `consultSelection`), not asked of the model:
   - `consultAgent` allows exactly the OTHER members of its space. Being a member IS the permission: it
     needs no `agent` grant, and neither a bare grant nor named agents outside the space widen it;
   - `searchAgents`, `createAgent`, `updateAgent`, `listMyAgents` and runtime delegation, which find,
     manage or start agents outside, are not built for a member;
   - a member's room roster is the space's members.
   Alia is outside, so she can consult any agent including a member, and the person talks to a member
   directly as before. A member asking Alia is not modelled by `consultAgent` (she is not an agent id)
   and is a later step.
7. **The sidebar shows a Space as a collapsible folder** (Bloom `SidebarTreeFolder`) in a "Spaces"
   section: the folder's name, its room ("General") and its member agents. An agent in a space no longer
   appears in the flat Agents list. Create from the create menu, rename, edit the brief, add agents,
   "Move to space…" on an agent row, delete (agents go back to the flat list). No drag-and-drop in the
   first version: the sidebar has none today.

## Phases

1. Model, API and the room (`spaces`, `agents.space_id`, `/spaces`, `syncSpaceRoom`) — with the
   enforcement and the context (peers-only reach, the brief in the room prompt, the space computer),
   because a space without them is just a list. **Done.**
3. The sidebar: the Spaces section, create/edit/move/delete, es/en.
4. Later, each its own decision: a shared notes memory (`space_memory_documents`), a member addressing
   Alia, a space-wide budget for autonomous activity, more than six members.

## Consequences

- An agent can only be in one space: moving it is one request, and it leaves the old one.
- Deleting a space deletes its room (history included) and frees its agents with their own conversations
  intact.
- The room's bounds (12 replies, 24 turns, 3 hand-offs, 60 replies per 10 minutes) are per person
  message, so a space does not talk by itself unless the person (or Alia's task) speaks first. Letting
  members work on their own is the heartbeat (ADR 0026) pointed at a space, which is a later step.
- A space with an app-confined agent (ADR 0021) is reachable per surface exactly as the group chat is:
  members the surface cannot open are reported failed, never queued.

## Alternatives considered

- **Reuse `agent_teams`.** It has names, ordered members and "channels", and an API with no consumer or
  UI (the screen was removed). Its coordinator/member roles and channel responder policies are a design
  nobody built on; reusing it would adopt that design to avoid one table. It stays as it is.
- **A `space_members` table.** Membership is one-to-many by decision 3, so a column carries it with
  `SET NULL` cleanup and no join for the readers that matter. A table would also need the "one space per
  agent" rule as a unique index and a join in the sidebar, the computer resolver and the assembler.
- **Make the room's members dynamic in the engine.** The engine reads `conversation_members`; keeping
  them in step is a few lines in one place, while teaching the engine a second source of members touches
  the code another change (ADR 0025) just finished.
- **Folders in the client store like Projects.** They would not be shared across devices and could not
  enforce "only each other": the rule has to live where the tools are assembled.
- **Let Alia join a space.** She is the person's generic assistant; a space is for the agents they made.

## Enforcement

- `db/__tests__/spaces.pgdb.test.ts`: membership is unique per agent (moving leaves the old space), the
  room's members equal the space's agents after every change, six at most with the last seat given to
  exactly one of several concurrent requests, another person's space and agent are refused, and deleting
  a space frees its agents and removes its room.
- `routes/__tests__/spaces.test.ts`: shape, standing over every agent before anything is written, the
  rollback of a space that cannot be filled, and the same 404 for a space that is not the caller's.
- `lib/__tests__/capability-grants.test.ts` ("an agent in a space"): the real assembler gives a member
  `consultAgent` for exactly its peers whatever its grants, builds none of the tools that reach outside,
  and leaves an agent in no space exactly as it was.
- `lib/computer/__tests__/computer-actor.test.ts` and `lib/chat/room/__tests__/policy.test.ts`: the space
  workspace and its owner-only rule, and the brief in the room prompt.
