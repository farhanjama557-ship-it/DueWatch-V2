# Phase 2B — DW Intelligence Research Hardening

Status: patch-on-top-of `phase2b/dw-intelligence-local`. This does **not** authorize production execution.

## Why this increment exists

Research review across multiple independent AI research reports converged on several useful upgrades to the existing Phase 2B proof:

1. financial truth needs explicit **claim/state/authority separation**, not just "LLM vs deterministic code";
2. AR needs a first-class **operational state/reconciliation layer**;
3. precedent retrieval should be **semantic candidate generation + structural applicability checks**, not similarity alone;
4. sparse-data learning should stay transparent and simple unless a more complex model proves value;
5. uncertainty must notice **drift**, not only nominal confidence/coverage;
6. execution planning should be **constraint-aware**;
7. action attempts need an **idempotency + server revalidation contract**;
8. intelligence should perform the **minimum sufficient analysis** for routine cases and automatically guard conflicting/high-risk cases.

## Added control objects

### Attributed claims

Evidence is projected into typed claims:

- `CANONICAL_RECORD`
- `ATTRIBUTED_ASSERTION`
- `POLICY_INPUT`
- `INFERENCE_ONLY`

Every projected claim carries provenance and has `canonicalEffect: NONE`.

A customer saying "we paid" therefore becomes an attributed assertion, not a payment mutation.

### AR control state

The engine now projects separate operational state for:

- invoice
- payment
- dispute
- promise
- collection
- reconciliation

Important payment states include:

- `OPEN`
- `CLAIMED_UNVERIFIED`
- `PENDING_CLEARANCE`
- `SETTLEMENT_EVIDENCE_CONFLICT`
- `REVERSED_OR_FAILED`
- `SETTLED`

Important dispute states include:

- `NONE`
- `SUSPECTED`
- `CUSTOMER_ASSERTED`
- `CANONICAL_DISPUTE`

A customer payment claim or dispute assertion can place collections into a hold/investigation state without changing canonical money.

## Structural precedent applicability

Precedent applicability now checks, when present:

- dispute compatibility
- action compatibility
- client compatibility
- promise status
- payment state
- collection stage
- staleness
- outcome quality

Similarity remains a ranking signal **after** applicability. It cannot establish applicability.

## Partial pooling

The existing lightweight pool is explicitly labeled `EMPIRICAL_PARTIAL_POOL`.

This keeps the useful shrinkage behavior without pretending Phase 2B implements a full hierarchical Bayesian model.

## Drift-aware uncertainty

`assessPrediction` now accepts optional `driftScore`.

A prediction can have:

- adequate sample size,
- a narrow interval,
- fresh data,

and still be blocked if current behavior is drifting materially.

## Constraint-aware action plan

Each recommendation is projected through an AR action profile.

Current profiles include:

- `send_reminder`
- `pause_dunning`
- `resume_dunning`
- `mark_paid`
- `apply_cash`
- `issue_credit`
- `write_off`
- `legal_escalation`

The plan identifies:

- risk class
- reversibility
- accounting-control boundary
- reconciliation blockers
- prediction-quality blockers
- policy/authority blockers
- whether server revalidation is required

Phase 2B remains a sandbox proof. Accounting-controlled and reputation-sensitive actions are not made automatically.

## Idempotency intent

Every staged action now carries a deterministic `idempotencyKey` plus:

- `requiresServerRevalidation: true`
- risk class
- reversibility
- accounting-control flag
- compensation mode

This is an **execution contract**, not a claim that production idempotency has already been implemented end-to-end.

## Minimum-sufficient analysis

The new analysis planner avoids running optional modules when there is no input that can use them.

Routine cases remain `STANDARD`.

Cases with conflicting payment/dispute evidence, rejected staged actions, accounting-controlled actions, or reputation-sensitive actions become `GUARDED`.

This is the beginning of adaptive intelligence **inside DW Intelligence**, not only Ask DW.

## Existing invariants preserved

The locked H01-H10 hard-gate set is not renumbered or weakened.

The changes continue to preserve:

- no learned/semantic mutation of canonical money;
- no self-granted authority;
- tenant isolation;
- tombstone non-rederivation;
- no production side effects in Phase 2B.

## Local verification performed for this patch

The reconstructed existing 17 Phase 2B regression scenarios plus the canonical-money regression test all still pass.

New research-hardening tests cover:

1. typed attributed claims;
2. payment-claim reconciliation;
3. dispute assertion hold;
4. structural precedent mismatch;
5. transparent empirical pooling;
6. drift-aware uncertainty;
7. minimum-sufficient analysis;
8. guarded escalation on conflict;
9. idempotency/server-revalidation intent;
10. accounting-control boundary;
11. routine path compatibility;
12. canonical immutability under settlement-looking evidence.

Result in the isolated Node test harness: **30/30 passed**.

A full repository `npm test` and `npm run build` must still be run after applying the patch in the actual DueWatch-V2 checkout.
