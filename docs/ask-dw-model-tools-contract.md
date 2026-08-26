# Ask DW Phase 2D — Model + Read-Only Tool Orchestration

## Goal

Phase 2D adds a real executable orchestration boundary around the already-merged Ask DW deterministic runtime. It does **not** give a model direct financial truth or execution authority.

The controlled flow is:

`question → deterministic DW truth core → model plan → allow-listed read tools → structured hypotheses → model synthesis → fresh-context verifier → truth lock → answer`

## Non-negotiable boundaries

1. Canonical invoice/payment/AR truth remains owned by the existing controlled DW Intelligence state.
2. Models may propose interpretations, hypotheses, retrieval steps and answer language; model output cannot grant authority or mutate canonical state.
3. Phase 2D tools are read-only and tenant-scoped. No send, write, mark-paid, apply-cash, credit, write-off or legal execution tool belongs in this registry.
4. Tool output is attributed evidence/context unless the deterministic core explicitly treats the underlying source as canonical.
5. A model candidate answer is not surfaced as the accepted narrative until the verifier returns `PASS`.
6. Deep verification uses a fresh-context verification input. Raw chain-of-thought is never requested or surfaced.
7. If verification returns `REVISE` or `BLOCK`, the model narrative is withheld and the runtime falls back to the deterministic truth packet.
8. The final truth lock always copies canonical facts, AR state, authority, safety outcome and executive state from the deterministic core.

## Model stages

### PLAN

Produces only bounded structured hypotheses and allow-listed read-tool requests.

### SYNTHESIZE

Produces executive-facing language and citations to actual tool-run IDs. It does not decide authority.

### VERIFY

Checks canonical consistency, unsupported material claims, contradiction handling, authority non-escalation and reconciliation holds. Verdict is `PASS`, `REVISE` or `BLOCK`.

## Current tool vocabulary

- `canonical_state`
- `evidence_search`
- `payment_reconciliation`
- `dispute_context`
- `precedent_search`
- `activity_history`
- `portfolio_summary`

Handlers are injected by app/server adapters so this increment can be tested without provider secrets, database writes, or production side effects.

## What this increment proves

It proves the executable orchestration contract and safety boundary with deterministic fixtures. It does **not** claim that a paid frontier-model provider or production Supabase read adapter has been wired yet. Those are the next adapter increments and must inherit this contract rather than bypass it.
