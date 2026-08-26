# DW Intelligence Phase 2B — Increment 1

**Status:** local/repo-targeted proof package; not merged; not deployed.
**Selected workflow:** Overdue Invoice Triage + Bounded Friendly Reminder.
**Execution:** sandbox/stub only.
**Model/API runtime:** zero.

## What this increment proves

The increment implements a deterministic Phase 2B proof kernel for the 17 locked scenarios. It deliberately reuses the existing Duewatch authority seam rather than inventing policy inside DW Intelligence.

The integration shape is:

`existing invoice/client truth`
→ evidence admission
→ memory / tombstone resolution
→ precedent applicability
→ partial pooling
→ selective uncertainty
→ bounded founder-question decision
→ **existing evaluateNextActionAuthority**
→ deterministic Phase 2B verifier
→ sandbox-only action outcome
→ proof trace

Production communication is not authorized here. Future real execution must continue through Duewatch's existing shared `autopilotExecutionCore`; Phase 2B may substitute a sandbox/stub transport at the IO boundary, not create a second provider-send path.

## Locked invariants carried forward

- Learning cannot create canonical money truth.
- Learning cannot create authority.
- Cross-tenant evidence is rejected.
- External instructions are quarantined and cannot grant policy/authority.
- Memory is scoped and must retain evidence lineage.
- Tombstones block direct and derivative reuse.
- Similarity alone cannot establish precedent applicability.
- Partial pooling exposes local/prior contribution and cannot silently swamp strong local evidence.
- Uncertainty/abstention is distinct from authority.
- Founder questions are bounded by value of information and burden.
- System-caused exposure is excluded from preference evidence.
- Rejected/staged actions cannot leak into execution.
- LOW/UNTRUSTED irrelevant sources cannot inflate independent strong-root count.

## Existing repo seams reused

- `src/lib/nextActionAuthority.js` remains the deterministic authority contract.
- `supabase/functions/_shared/nextActionAuthority.js` remains its server-side mirrored authority core.
- `supabase/functions/_shared/autopilotExecutionCore.js` remains the production execution boundary.
- `awaiting_signature` remains the founder-approval queue concept.
- existing invoice/client/payment truth remains canonical; this increment creates no alternate money ledger.

## New files targeted for the repo

- `src/lib/dwIntelligence/phase2bEngine.js`
- `src/lib/dwIntelligence/phase2bDuewatchAdapter.js`
- `tests/dwIntelligencePhase2b.test.mjs`
- `supabase/migrations/20260824234500_dw_intelligence_phase2b_proof.sql`
- `docs/phase2b-dw-intelligence-proof.md`

## Not proven yet

This increment is not Phase 2B completion. It does not yet prove:

- hosted Supabase application of the candidate migration;
- server-side persistence/retrieval under real RLS/service-role paths;
- sandbox execution through the exact production `autopilotExecutionCore` IO boundary;
- UI integration into Pulse/Invoices/Activity;
- live semantic parser/model integration;
- production communication.

Those are later checkpoints. The north-star Night Shift / Full Control / •LIVE / DW Check concepts remain product direction, not scope added to this proof.
