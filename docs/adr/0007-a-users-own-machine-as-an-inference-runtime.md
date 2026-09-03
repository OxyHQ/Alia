# 7. A user's own machine as an inference runtime

**Status:** Accepted

**Date:** 2026-08-24

## Context

ADR 0001 assigns inference to Kaana, and `AGENTS.md` states the consequence as a rule: *"An app never ships its own provider adapter, key pool or routing"*. Every model Alia can answer from is a model Kaana can dial.

A model running on the person's own machine is not such a model. Ollama, LM Studio, llama.cpp's server and vLLM all listen on an address reachable from exactly one place — that machine — and no server in `us-west-2` can reach it. The boundary ADR 0001 draws does not exclude this case on principle; it simply cannot contain it, because Kaana has no route to `127.0.0.1` on someone's laptop.

Two things people asked for at once, and they are not the same request:

1. use a local model from Alia, with the product behaving as it always does — tools, memory, skills, persistence, titles;
2. use it from a phone, where the model is on a laptop across the room.

The second forecloses the obvious design. If the browser ran the conversation itself and merely saved the transcript afterwards, none of the product's behaviour would apply, and a phone would have no way to reach the laptop at all.

## Decision

### The user's device is a transport, not an orchestrator

`POST /v1/chat/completions` assembles the turn exactly as it does for any hosted model. At the point where a provider would be dialled, the request is emitted to a socket that one of the person's devices holds open; that device performs an ordinary `fetch` against its own endpoint and returns the bytes unread. The AI SDK is handed a `fetch` of ours (`lib/inference/user-runtime-bridge.ts`), so it does its own OpenAI parsing and there is no second stream parser to keep in step with the first.

Everything above the provider hop is untouched. Persistence in particular needed no new code: `POST /conversations` already stores a client-supplied conversation.

### This is a user runtime, and it is not a provider

It holds no credential, has no key pool, no rate table, no health record, and no entry in the Kaana routing-profile catalogue. It is never a fallback candidate and never resolves through a hosted-provider selector. The rule in `AGENTS.md` stands unamended: nothing here routes between operators, because there is only ever one destination and the person chose it.

The `AGENTS.md` model-identity rules apply unchanged. A local model is named truthfully in the picker and the operator surfaces; `local/<runtimeId>/<model>` is a reserved namespace, not a publisher claim, and the resolved `publisher` is recorded as `unknown` rather than guessed.

### A local turn reserves no credits, and therefore may reach nothing that costs money

No inference of Alia's is spent, so no credit is reserved — not reserved-and-refunded, because a reservation debits and any path that neither charges nor refunds silently costs the person a credit.

That saving is only honest while the turn stays on the person's hardware, and two paths take it straight back off:

- `deepResearch` runs `lib/research/research-engine.ts`, which resolves `kaana-lite` and `kaana-v1` **by name** and calls them several times per turn, while `deep-research-handler.ts` finalizes credits under `if (creditReservation)`;
- `agentMode` adds `delegateToAgent`, and `lib/tools/agent-delegate.ts` resolves a hosted model the same way.

Both request flags are refused for a local turn (`local_runtime_capability_unavailable`), and the `deepResearch` **tool** is withheld from the tool set — a flag check cannot see a tool call. The web tools stay: they reach DuckDuckGo's free endpoint and cost nothing.

### A local turn never falls back to a hosted model

There is nowhere honest to fall back to. Substituting a hosted provider would send the conversation to an operator the person deliberately avoided by choosing a local model, and bill it against a reservation that was never taken. A dead runtime ends the turn.

### Presence is a socket's lifetime, and the endpoint never leaves the browser

A runtime announces `{ id, label, models }` when it joins, kept on the socket rather than in a table: a runtime exists exactly as long as the tab serving it, and a stored list would advertise models nothing can answer. `GET /local-runtimes` reads that presence back, which is how a phone learns what a laptop can run.

The endpoint URL is not part of the announcement and is never sent. A server that accepted a URL and fetched it would be a server-side-request-forgery primitive with a settings screen in front of it.

A run may only be answered by the user it was issued to, re-checked on every frame: the run id is unguessable, but an id is not an authorisation.

## Consequences

**The tab has to be alive.** Local models are unavailable to background agents, triggers, bots and scheduled runs, because those have no browser. Presence is checked before the SSE stream opens, so a closed tab greys the model out rather than killing a turn in flight.

**Deep research and agent mode are unavailable on local models.** That is a real product limitation, and it is the price of the turn being free. A person who wants either picks a Kaana routing profile.

**One residual cost stays, deliberately, and is bounded.** Title generation calls `kaana-lite` by name (`lib/conversation-saver.ts:192`) and a local turn therefore produces one hosted call Alia pays for. It is kept because a chat with no title in the sidebar is a worse product than a rounding error is a cost, and the bound is what makes that acceptable rather than a guess: `lib/chat-lifecycle.ts:145` returns early once the conversation has messages, so it is **once per conversation, not per turn**, capped at `maxOutputTokens: 30`, behind authentication and the per-user rate limit. Nothing useful can be generated inside that budget, which is why it is listed as a cost rather than closed as a hole. If it ever stops being once-per-conversation, this stops being true.

**One new hostname is frozen into the egress allowlist.** `user-runtime.invalid` is a placeholder base a provider factory needs to build a URL from; RFC 2606 guarantees it never resolves, and the fetch is intercepted before anything is dialled. It is listed in `architectureGates.test.ts` rather than exempted, because a new host string in `chat-core.ts` is precisely the diff that should be read in review.

**Replies cross tasks through Redis.** The task serving the HTTP request is not necessarily the task holding the socket. Requests travel by socket.io room, which the Redis adapter already fans out; replies travel back over one channel, delivered locally when the receiving task owns the run. Without Redis there is one task and the local path is the only path.

**A future local bridge changes nothing here.** The browser is one implementation of a runtime. A CLI daemon or the native app registers in the same room, announces the same shape, and answers the same frames — which is what makes the browser's limitations (Safari refusing `localhost`, Chrome's local-network preflight) a client problem rather than an architectural one.
