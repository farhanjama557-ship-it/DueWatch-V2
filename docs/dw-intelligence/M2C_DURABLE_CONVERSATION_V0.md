# Ask DW M2C — Durable Conversation Persistence v0

Status: implementation candidate for M2C.

## Goal

Make Ask DW reference/workflow continuity survive refreshes and later sessions
without turning conversation memory into financial truth, policy authority, or
execution permission.

The durable object is the existing M1D case state. M2C does not introduce a
second conversation-memory schema and does not persist answer/tool payloads.

## Core rule

Persist conversation references and workflow continuity. Re-read financial
truth and authority every time they matter.

## What is durable

M2C may persist the already-validated M1D state envelope:

- tenant + conversation identity
- active/recent case references
- client/invoice/dispute/investigation references
- bounded invoice candidates
- bounded evidence/artifact/recommendation references
- open-question references
- reference bindings
- presentation continuity
- offered / awaiting / suspended / confirmed-pending-revalidation action refs
- state version
- timestamps / optional TTL

## What is never durable conversation truth

The M1D validator and M2C database guard reject canonical/live fields such as
amount, balance, amount paid, currency, invoice/due/payment truth, raw tool
output, canonical fact snapshots, authority, authorization, permissions, and
automatic-action permission.

An action may contain `executionAuthorized: false`. M2C explicitly permits only
that false guard value and rejects every other persisted value.

## Storage + write boundary

`public.ask_dw_conversations` is keyed by `(user_id, conversation_id)` and
stores schema version, state version, status, JSON case state, optional expiry,
and timestamps. State is bounded to 256 KiB.

Authenticated users may SELECT only their own rows through RLS. They receive no
direct INSERT/UPDATE/DELETE table grant.

Writes cross only:

`public.persist_ask_dw_conversation_state(...)`

The RPC requires `auth.uid()`, binds tenant + conversation identity, recursively
blocks forbidden keys, verifies fail-closed boundary flags, and uses the
existing M1D `state.version` as an optimistic compare-and-swap version.

Exact network replays are idempotent. A real concurrent advance emits
`40001 / ASK_DW_CONVERSATION_STALE`; the durable runtime withholds the computed
answer and returns `CONVERSATION_STALE_RELOAD_REQUIRED`.

Persistence receipts are outcome-allowlisted; storage cannot invent execution-like
states. Capability-looking fields such as `financialExecutionAuthorized`,
`canonicalMutationAuthorized`, or `writesPerformed` are rejected. The one existing
M1D guard field `executionAuthorized` is persistable only when it is exactly false.

Once created, the conversation TTL and `createdAt` anchor are immutable. An exact
idempotent network replay may still succeed after TTL, but every non-idempotent
update after expiry is rejected and its computed answer is withheld.

## Resume behavior

A resumed row is revalidated through `validateAskDwCaseState`.

- `make it shorter` can preserve presentation continuity.
- `the other invoice` can preserve bounded invoice-reference continuity.
- a confirmed action remains only `CONFIRMED_PENDING_REVALIDATION`.
- expired conversations cannot revive.
- current balance/payment/policy/authority are still fresh-read after resume.

## Runtime composition

durable row
→ M2C load + M1D validation
→ M2B deterministic reference resolver
→ M1E conversation controls
→ M2A fresh controlled activation read
→ DW Intelligence answer
→ persist `result.caseState` only

`createAskDwDurableControlledConversationRuntime({ supabase })` wires the real
M2B resolver, controlled conversation runtime, and M2C persistence adapter.

## Transcript

M2C v0 deliberately does not persist raw chat transcript text. Operational
continuity lives in bounded references/state. Transcript/history is a separate
retention/privacy/UI decision.

## Hosted boundary

The migration is added and verified in the repository in M2C. M2C does not
claim the hosted project has the table/RPC until it is actually applied and
fingerprinted. Hosted schema/capability catch-up remains M2D.

## Acceptance gate

M2C requires focused persistence/runtime tests, M2A/M2B/M1D/M1E regressions,
RLS/RPC contract proof, stale-write rejection, forbidden-field rejection,
resume continuity, expiry protection, full suite, production build,
`git diff --check`, final diff review, and verified PR merge.
