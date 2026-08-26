# Ask DW Phase 2F — Controlled Activation

Phase 2F deliberately avoids replaying the missing payment/DW migrations into the hosted database.

The hosted project currently has legacy invoice aggregates that do not satisfy the hardened payment-foundation invariants. The first controlled activation therefore makes **no canonical-money migration** and introduces **no database write path**.

## CANONICAL_READ_ONLY_V1

The first live runtime is invoice-scoped and Normal-mode only.

It allows:
- canonical invoice/client reads from the already-hosted schema;
- bounded durable activity-history reads;
- a real provider-backed SYNTHESIZE call;
- a separate provider-backed fresh-context VERIFY call.

It deliberately disables:
- model-driven PLAN routing during the first activation;
- payment/payment-allocation reads;
- payment reconciliation;
- DW evidence/memory/precedent reads;
- prediction;
- complete execution-history claims;
- ACT and PREDICT requests;
- production financial execution;
- canonical mutation.

PLAN is deterministic for this checkpoint and requests exactly:
1. `canonical_state`
2. `activity_history`

This is not represented as full Ask DW capability. The returned activation receipt states which sources were unavailable.

## Why execution history is `null`, not `[]`

The hosted database does not currently contain `autopilot_execution_claims`.

The controlled loader passes execution history to the existing authority evaluator as unavailable (`null`) rather than inventing an empty set. This preserves the existing fail-closed authority contract: missing history can never become permission.

## Currency

The hosted `invoices` table does not currently have the repo's later `currency` column. Controlled activation reads the existing invoice columns only and returns currency as unknown (`null`). It never defaults to USD.

## First live question

Use a consistent, open invoice and an EXPLAIN-style question such as:

`What is the current balance on this invoice?`

Do not use ACT/PREDICT/DECIDE requests during this checkpoint.

## Exit criteria

Do not unlock model-driven PLAN or payment reconciliation until:
1. the hosted schema catch-up path is separately reviewed;
2. legacy invalid payment aggregates are explicitly resolved rather than silently normalized;
3. payment and execution-history ledgers are available;
4. DW evidence/memory/proof persistence is available or explicitly capability-gated;
5. the controlled live request passes synthesis + independent verification with no writes or financial execution.
