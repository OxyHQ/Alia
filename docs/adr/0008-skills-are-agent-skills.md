# 8. A skill is an Agent Skill, not a prompt fragment

**Status:** Accepted

**Date:** 2026-08-26

## Context

Alia shipped a feature called Skills. What it stored was a row: a title, a tagline, a description, an emoji, a colour, five string arrays, and one `system_prompt`. Only the last field did anything. `triggers` — presented in the product as *"example phrases that would activate this skill"* — had zero readers in the codebase; so did `includes`, `goodAt`, `notGoodAt` and `useCase`. The Spanish and English copy promised *"modular capabilities … load skills on demand"*, and what happened on activation was one string prepended to the system prompt for the rest of the conversation.

Three consequences followed from the shape rather than from any bug:

- **A skill could not carry anything.** No reference documents, no templates, no scripts. `includes` was a list of sentences a person typed about what the skill included.
- **Selection was global and invisible.** `activeSkillId` was set by opening a skill's page, applied to every conversation, and was never cleared by anything — no chip, no switch, no request field. Reloading the page was the only way to stop using a skill.
- **Nothing could come from outside.** The fifteen built-ins were TypeScript template literals; adding one needed a deploy, and importing somebody else's was not a concept the model could express.

Meanwhile the ecosystem settled on a format for exactly this. **Agent Skills** (<https://agentskills.io>) was released by Anthropic as an open standard and is now read by Claude Code, claude.ai, the Claude API, Cursor, GitHub Copilot and VS Code, OpenAI's Codex, Gemini CLI, Goose, OpenCode and others. A skill is a directory: `SKILL.md` with YAML frontmatter, plus optional `references/`, `assets/` and `scripts/`. Agents load it in three stages — metadata always, instructions when the task matches, bundled files only if the instructions reach for them.

## Decision

### Alia's Skills feature IS that format

A skill is a directory conforming to the Agent Skills specification, stored as `skills` (identity and provenance), `skill_versions` (an immutable `SKILL.md` body) and `skill_files` (the bundle). `name` and `description` are the spec's fields with the spec's limits, enforced by CHECK constraints rendered from the same constants the validator uses.

Alia adds no field to the frontmatter and reads none of its own. `metadata` is stored verbatim and never interpreted, because acting on another client's keys turns a convention into a contract nobody agreed to.

### Progressive disclosure is implemented as three different moments in a turn

1. **The index.** Every enabled installed skill contributes `name: description` — roughly a hundred tokens — to the system prompt, capped at sixty entries and six thousand characters, ordered by recency of use.
2. **Activation.** Either the person selected the skill for this message, in which case its body is prepended as instructions, or the model calls `loadSkill` after matching the index against the request.
3. **Resources.** `readSkillFile` returns one bundled file; `runSkillScript` executes one in a sandbox and returns only its output, so a script's source never costs tokens.

The three-level split is the feature, not an optimisation: it is what lets an account keep fifty skills without paying for fifty prompts.

### Reachability is an install, resolved once per turn

The candidate set — enabled installs, plus the skills linked to the agent a conversation runs — is computed at the request boundary, and the tools close over it. A name outside that set resolves to nothing, whoever asked and however the name was spelled. There is no second authorization path, which is what the previous design lacked: `GET /skills/:skillId/prompt` returned any skill's prompt, including another account's unpublished draft, to any authenticated caller.

### A skill's body is untrusted content that becomes instructions

That is inherent to the format and is the sharpest thing about it. Alia's containment is: nothing is installed without an explicit act; a synced upstream skill lands in the catalogue and on nobody's shelf; bundled scripts run with no network and no credentials; and what a skill declares under `allowed-tools` is shown before installing rather than silently granted.

### The catalogue is filled by syncing repositories, under a licence check

The shared catalogue is redistribution, so a skill enters it only if the bundle carries a licence that permits hosting. The check reads the licence the bundle actually contains: `anthropics/skills` holds Apache-2.0 skills and all-rights-reserved ones under one path with identical-looking frontmatter, so trusting the repository, or the frontmatter, or a hardcoded list of names would get it wrong silently. A person importing a skill into their own account is not redistribution and is not gated by it.

### The compatibility surface is `/skills`, not `/v1`

Uploads accept both shapes Anthropic's Skills API takes — one zip, or path-qualified `files[]` — so a skill packaged for that API uploads here unchanged. This lives on the product surface because ADR 0004 freezes `api.alia.onl/v1/*` as a bounded compatibility window that gains no new route and no new capability.

## Consequences

**The old model is gone, and its data survives.** `0030` adds the new shape and backfills it — every skill's `system_prompt` becomes version 1, and its owner keeps it on their shelf — and `0031` drops the old columns after the new image is live. The three UI shelves (`featured`, `community`, `recent`) survive as tags rather than as a closed set the new model has no use for.

**Old clients break at the seam, deliberately.** A skill has no `title`, `tagline` or `systemPrompt` any more, and the chat request carries `skillIds` rather than `skillId`. This is a clean cut rather than a compatibility layer, because the old fields describe a feature that no longer exists.

**Skills now cost tokens on every turn.** Sixty names and descriptions is real context, spent whether or not a skill is used. The cap and the recency ordering are the price control; the alternative — loading nothing until asked — is the design the format exists to replace.

**Alia hosts other people's instructions.** The licence check, the content scan on import, the explicit install, and the networkless sandbox are the answer to that, and each of them is a place a mistake would be quiet. Nothing here makes a malicious skill impossible; what they do is make installing one a decision somebody made.
