# Ask DW M2A — Grounded Conversation v0

Status: implementation candidate for M2A.

## Goal

Compose the already-proven M1D/M1E reference-only conversation state with the
current hosted **DW Intelligence read-only controlled activation**.

This milestone does **not** create a new truth engine, authority engine, model
provider, client-name resolver, or execution path.

## Locked runtime

Founder turn
→ M1D case state
→ M1E deterministic conversation controls
→ resolved invoice reference
→ controlled activation fresh authenticated tenant read
→ canonical invoice/client + bounded activity + policy
→ deterministic DW Intelligence truth / fail-closed authority
→ deterministic answer + verification
→ reference-only conversation state

## M2A invariants

1. Durable case state stores references and presentation continuity only.
2. Financial truth is fresh-read for substantive invoice turns.
3. Controlled activation proves zero writes.
4. `activationReceipt` is adapted into the M1E `liveReadReceipt` interface
   without losing the zero-write or capability-limit evidence.
5. Complete execution history remains unavailable; authority stays fail-closed.
6. Financial state and action authority are separate.
7. ACT remains blocked.
8. PREDICT remains blocked while prediction capability is unavailable.
9. Currency remains unknown when the hosted activation schema does not expose it.
10. Activity history remains bounded; absence claims cannot exceed the returned window.
11. Never sum or infer a client/portfolio total from invoice-scoped truth.
12. "the other invoice" may change an already-resolved reference only when there
    is exactly one alternate candidate.
13. "make it shorter" changes presentation only.
14. Cross-tenant turns fail before live reads.
15. Models/providers are not required for M2A.
16. 100% model accuracy is not claimed. Material answers are released only
    inside deterministic truth/evidence/verification boundaries.

## Explicitly deferred to M2B+

### M2B
Real authenticated client/name/invoice resolution with deterministic ambiguity
handling.

### M2C
Durable conversation persistence across browser/session boundaries.

### M2D
Hosted payment ledger, reconciliation, execution history and DW evidence/schema
catch-up.

### M2E
Founder-facing Ask DW activation, claim citations and Evidence Brief surfaces.

### M2F
Production golden scenario.

## Provider rule

A future fast model may help with language, intent, synthesis or tone only behind
the existing provider boundary. It does not own financial truth or authority.

## Acceptance

M2A is not complete until focused tests, the full test suite, production build,
and `git diff --check` all pass on the actual DueWatch repository.

## Capability honesty

Missing capability stays explicit. Unavailable data or infrastructure remains unavailable and must never be inferred as present.