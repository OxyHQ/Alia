# Group participation acceptance

The room decides who should act before starting any agent. Deterministic tests verify that a valid
selection controls execution, attribution and delivery. They cannot establish that a model
understands who “Eusebio” addresses. The latter requires the same production selector running
against real Oxy inference, followed by a staging room test for the complete experience.

## Evaluation boundaries

Use synthetic participant identities and text for selector evaluation. Do not run a live user's
agents or their tools. Use an authenticated **Alia development workload** through the ordinary Oxy
SDK path; never use another product's profile, customer API keys or direct provider credentials.
The evaluation replaces only credit reservation/settlement with an in-memory test adapter. The
production selector, prompt, schema and validator all run unchanged. No database balance is
modified, but Oxy still meters real inference; this is an explicit opt-in evaluation, outside the
default unit suite.

For database tests, use `TEST_DATABASE_URL` pointing to the disposable server described in
`packages/api/docker-compose.postgres.yml`. The API harness creates and drops its own test database.
Do not borrow the app's `DATABASE_URL` to make an evaluation run.

## Run the real-inference selector evaluation

Use the approved Alia workload credential chain. Locally, `AWS_PROFILE` may select its development
role; an approved runtime can instead use its temporary task-role credentials. Start with a smoke run:

```bash
RUN_ROOM_SELECTION_EVAL=1 OXY_API_URL=https://api.oxy.so bun run --filter @alia/api test --config vitest.room-eval.config.ts
```

The default is **one repetition per case**, a smoke run rather than release acceptance. Add
`ROOM_EVAL_REPETITIONS=10` for the repeated acceptance run; it makes 260 real selector calls and
can take tens of minutes. The runner fails early if workload authentication fails, never prints token values or raw SDK
errors, and reports case outcomes, latencies, resolved model references and token counts. It calls
`selectRoomDecision`; it does not mock inference, duplicate the selection prompt or execute an
agent. Local credit mutations are disabled; token counts describe real inference usage, not a
claim that a production payer was charged.

## Synthetic fixture

Use two agents, with IDs distinct from their display names:

- Salella: owns campaign copy and editorial review.
- Eusebio: owns campaign research and measurement.

Also repeat the direct-address cases with both descriptions set to the same general-assistant
remit. Different specialties must not be the only reason Eusebio wins an explicit address.
Reverse roster order for every direct-address case. Include two agents sharing a first name for
ambiguity checks. Keep original message IDs and actor IDs throughout follow-up cases.

| Case | Input/context | Required outcome |
|---|---|---|
| Reported incident | `Hola! Eusebio que puedes hacer?` | Select Eusebio only. |
| Explicit handle | `Hola, @eusebio, ¿qué puedes hacer?` | Select Eusebio only. |
| Formatting variations | `EUSEBIO ¿qué puedes hacer?`, `¡Hola! Eusébio, ¿qué puedes hacer?` | Select Eusebio only. |
| Follow-up | Eusebio has answered; person: `¿Y tú, Salella?` | Select Salella only. |
| Incidental name | `Salella, resume lo que acaba de decir Eusebio.` | Select Salella; do not activate Eusebio for being mentioned. |
| Quoted mention | `Salella, revisa esta frase: "@Eusebio prepara un informe".` | Select Salella; quoted text does not trigger a handoff. |
| Ambiguous name | Two members named Alex; `Alex, ¿qué puedes hacer?` | One clarification, no guessed execution. |
| Open question | `¿Cómo planteamos esta campaña?` | Select a relevant first contribution; no compulsory full-roster round. |
| Complementary work | Person assigns research to Eusebio and copy to Salella; research reply is stored | Select Salella for the still-pending contribution. |
| Answer already sufficient | A participant has answered the person's simple question completely | End without a duplicate answer. |
| Deliberate silence | `Gracias, era eso.` after a completed exchange | End without an agent turn. |
| Unavailable addressee | Explicitly addressed member is unavailable; another remains reachable | Report unavailability; do not substitute the other agent. |
| Requester limits | Person says not to involve other agents; reply refers to a peer | Do not initiate a handoff. |

Run each direct-address, follow-up, ambiguity and silence case at least ten times. Every repetition
must satisfy its expected actor/action. Report the total, failures, latency and inference token
usage; do not turn mixed results into a passing average. The open-question cases admit more than
one valid first speaker; evaluate relevance, subsequent complementary work and termination instead
of asserting a permanent coordinator. Keep the tested commit and Oxy-resolved model reference in
the evaluation record, without pinning that model in product code.

## Runtime and staging acceptance

After deterministic API/SDK tests and selector evaluation:

1. In a staging group with Salella and Eusebio, send the exact incident text. Observe only Eusebio's
   activity and answer. Confirm the same result after reload and with the roster order reversed.
2. Repeat the follow-up, quotation and final-thanks cases. A silent close retains the person's
   message and leaves no empty assistant bubble, error/retry UI or lingering typing indicator.
3. Give the room work with a real dependency between two agents. Confirm each response adds its
   assigned work, then the room ends. Naming a colleague in explanatory prose must not start it.
4. Use distinct agent memories and identical display names in an attribution fixture. Inspect the
   assembled inputs: own messages alone use `assistant`; peers are attributed observations and
   neither Alia's memory nor another agent's memory is passed to the selected actor.
5. Interrupt the selector with a new person message. No stale selected actor may begin afterward.
   Repeat with a queued speaking job waiting for the room lock on a second worker instance.
6. Retry a speaking job after its reply has stored. Confirm the stored reply ID is reused and no
   second agent execution occurs. Verify selection and speaking job IDs cannot collide.
7. Disconnect the SSE stream, allow work to continue, reconnect through Socket.IO and reload.
   Confirm the same reply appears once, with the correct actor, and all activity settles.
8. Exercise selector timeout, invalid schema/roster ID, agent failure, no credits and inaccessible
   addressee. Repeat a selector failure after the first actor has answered: preserve that answer
   but report the chain as failed. Failures must never become quiet success or a fallback to all
   members. Check that returned generations settle measured usage even when their selected actor
   ID is rejected; throwing inference calls release their reservations.
9. Exercise reply, operation (selection plus execution), handoff and room-rate bounds, then verify task authority is revoked on
   normal end, quiet end, supersession and exhausted failure retries.
10. During rollout, verify legacy `group-rooms` work drains under the old policy while new chains
    go exclusively to `group-rooms-v2`. Test cross-instance locking, not only in-memory locking.

## Prerequisites observed on 2026-11-12

The local documented Postgres test service on port 5440 accepted a read-only connection as the
configured test user to its maintenance database (PostgreSQL 17). Docker access was unavailable,
but starting a new database service was unnecessary.

The Oxy workload-authentication probe stopped before the exchange: the AWS default identity was
valid, but the SDK rejected its credentials because an Oxy workload requires temporary AWS role
credentials with a session token and expiration. No Alia development assume-role/SSO profile was
configured. Real selector inference and staging acceptance are therefore **not verified** by this
probe. Supply an authenticated Alia development workload profile with a live Oxy binding to run
them. No production credentials, account data or workload bindings were changed.
