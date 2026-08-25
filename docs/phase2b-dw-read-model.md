# DW Intelligence — Phase 2B Application Read Model v0.4

**Status:** LOCAL PROOF / UI CONTRACT — NOT DEPLOYED

## Purpose

This read model is the one-way projection from proven DW Intelligence state into founder-facing Duewatch UI.

It powers the data contract for:

- Pulse
- Invoice Detail
- Activity / What's Done
- Needs You
- Evidence / Why
- future `• LIVE`

It is deliberately incapable of granting authority or executing work.

## Locked boundary

`proof state -> read model -> UI`

Never:

`UI -> inferred authority -> execution`

Any founder action surfaced by the read model carries:

`REQUEST_BACKEND_REVALIDATION`

and:

`directlyExecutable = false`

The future Approve/Send boundary must call the existing server-side deterministic authority/revalidation/execution path.

## Operational state vocabulary

- `HANDLED`
- `READY`
- `APPROVAL`
- `WATCH`
- `INVESTIGATING`
- `UNCERTAIN`
- `BLOCKED`

Unknown states fail closed to `BLOCKED`.

## Work-presence vocabulary

- `analyzing`
- `verifying`
- `preparing`
- `waiting`
- `handled`
- `blocked`

### No-fake-LIVE rule

The read model distinguishes **current work phase** from **next likely work phase**.

A completed `INVESTIGATING` result does **not** claim DW is actively verifying right now. It projects:

- current work phase: `waiting`
- next work phase: `verifying`

A real `analyzing` LIVE state appears only when a persisted `dw_intelligence_runs` row is actually `status='running'` and remains Phase-2B-safe (`transport` sandbox/stub/none, production execution false).

Detailed step animation is not claimed until detailed active step events are explicitly persisted in a future increment.

## Run scope hardening

Increment 4 strengthens the undeployed Phase 2B candidate migration so every run now carries:

- `user_id`
- `client_id`
- `invoice_id`

with a structural composite foreign key to:

`invoices(user_id, id, client_id)`

This is necessary so future `• LIVE` can truthfully say which invoice/client a running DW job belongs to before its final proof event exists.

## Evidence lineage hardening

Source evidence identifiers are not assumed to be database UUIDs.

Each persisted evidence row now has a run-scoped text `evidence_key`, and derivation uses `derived_from_key` with a structural self-FK:

`(user_id, run_id, derived_from_key)`
→ `(user_id, run_id, evidence_key)`

This preserves source-root lineage without inventing database identity.

## Rejected evidence redaction

Evidence rejected for tenant or object-scope mismatch is proof that the admission boundary worked, not content the current tenant is entitled to inspect.

Rejected evidence therefore persists only as redacted audit metadata:

- opaque local `evidence_key`
- `source_type='redacted_rejected'`
- source ref removed
- trust removed
- claim type removed
- content digest removed
- source provenance removed
- original external identifier removed from browser-readable proof

This prevents the evidence-rejection path from becoming a cross-tenant information leak.

## Pulse projection

Pulse can read:

- cases under management
- cash under management
- handled
- ready
- approval
- watching
- investigating
- uncertain
- blocked
- Needs You count
- actual running LIVE job count

A run-only LIVE entry may exist before a final case proof exists, but it exposes only proven run scope and a generic `analyzing` state.

## Invoice Detail projection

Invoice Detail receives:

- canonical amount/balance/status
- operational state
- evidence summary
- authority summary
- recommendation
- staged action
- execution outcome
- uncertainty
- identification status
- Why items
- proof-derived timeline
- founder action request, if any

Timeline entries currently share the final proof-event timestamp and are marked:

`timestampKind='proof_event_time'`

They must not be rendered as if Duewatch has exact per-step timestamps that were never persisted.

## Needs You projection

A case appears in Needs You only when:

- operational state is `APPROVAL`; or
- state is `UNCERTAIN` and a founder question was actually selected.

A stray historical `founderQuestion.asked=true` on a handled case does not create a new founder task.

## Integrity fail-closed behavior

The Phase 2B read model blocks display actionability when it sees:

- a hard-gate violation in run summary;
- production execution authorization set true;
- non-sandbox/stub/none transport;
- a real side effect in the proof row;
- a real side effect in the proof JSON;
- an unknown operational state;
- tenant/client/invoice/run scope mismatch.

In those cases the projected operational state becomes `BLOCKED` and no founder action can be directly executed.

## Read-only guarantee

The read-model module contains:

- no Supabase client;
- no fetch/network call;
- no email/provider call;
- no invoice/payment database mutation;
- no canonical-money mutation;
- no authority evaluator;
- no execution boundary.

Its outputs are deeply frozen to prevent in-place UI mutation of proof-derived state.

## Current limitation

This is not yet wired into React pages.

It is the proven application-facing data contract that the next increment can wire into Pulse and Invoice Detail locally.
