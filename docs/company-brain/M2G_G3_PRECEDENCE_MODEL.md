# M2G G3 — Precedence Model

**Status:** Implemented — runtime live in `src/lib/companyBrain/policyIntelligence.js`
**Branch:** `m2g/company-brain-bootstrap-g3`
**Date:** 2026-08-31

---

## What "precedence" means in G3

Precedence is the documented, evidence-backed reason one policy candidate outranks another for the same
topic and scope. G3 never infers precedence from:
- confidence scores (R1)
- ingestion order / recency
- behavioral frequency or past approvals (R2, R3)
- scope width (CLIENT ≠ COMPANY — R4)

The only mechanism that explicitly resolves precedence between two active candidates is a
**`SUPERSEDES` edge with `explicit: true`**.

---

## Precedence Resolution Algorithm

1. `buildPolicyCandidates` reads all POLICY_CANDIDATE and CLIENT_EXCEPTION nodes from the G2 graph
   for the requested scope.
2. Live `graph.edges` (not just the frozen snapshot) are scanned for SUPERSEDES edges. Any candidate
   whose `stableKey` appears as the `toKey` of an active SUPERSEDES edge is reclassified to
   `CANDIDATE_STATUS.SUPERSEDED`.
3. `classifyConflicts` runs on the remaining ACTIVE candidates.
4. `resolvePolicy` determines the final status:
   - `NO_POLICY` — no candidates for this topic/scope
   - `ABSTAIN` — candidates exist but all are HISTORICAL/EXPIRED/SUPERSEDED/REVOKED/DANGLING
   - `RESOLVED` — exactly one ACTIVE candidate, zero blocking conflicts
   - `CONFLICTED` — two or more ACTIVE candidates, or any blocking conflict

---

## Conflict Classification Priority (pairwise, ACTIVE candidates only)

| Priority | Class | Trigger |
|----------|-------|---------|
| 1 | `SCOPE_ESCALATION` | CLIENT-scoped candidate in a COMPANY-scope request (R4) |
| 2 | `DANGLING_PROVENANCE` | Candidate has no active source version backing (R6) |
| 3 | `CONFIDENCE_DISAGREEMENT` | Same value, different confidence scores (R1 — cannot resolve) |
| 4 | `FOUNDER_INSTRUCTION_VS_PRIOR_POLICY` | FOUNDER_INSTRUCTION vs COMPANY_POLICY |
| 5 | `COMPANY_VS_CLIENT_EXCEPTION` | Company-policy vs client-exception in same scope |
| 6 | `CURRENT_VS_HISTORICAL` | One HISTORICAL, one not HISTORICAL |
| 7 | `OVERLAPPING_EFFECTIVE_PERIODS` | Both UNKNOWN temporal (open-ended windows) |
| 8 | `MISSING_PRECEDENCE` | Both CURRENT, no SUPERSEDES edge between them (R8) |
| 9 | `SAME_SCOPE_INCOMPATIBLE_VALUES` | General incompatible-value fallback |

---

## Invariants That Cannot Be Bypassed

- **R1** — Confidence never picks a winner. A CONFIDENCE_DISAGREEMENT finding blocks resolution.
- **R4** — CLIENT-scoped rules never silently widen. `getPoliciesApplicable` is structural; SCOPE_ESCALATION
  is an additional G3-layer safety net.
- **R8** — Missing precedence must produce CONFLICTED, never a fabricated winner.
- **R9** — `canActAutomatically: false` on every G3 output, regardless of resolution status.

---

## How to Establish Precedence Without Amending Evidence

1. A founder or authorised actor calls `graph.persistEdge` with a SUPERSEDES edge:
   ```js
   graph.persistEdge({
     actor: founderA,
     tenantId,
     edge: createGraphEdge({
       stableKey: `edge:${newKey}:supersedes:${oldKey}`,
       fromKey: newKey,   // the winning candidate
       toKey: oldKey,     // the candidate being superseded
       type: GRAPH_EDGE_TYPE.SUPERSEDES,
       tenantId,
       explicit: true,   // required — createGraphEdge throws without it
       claimIds: winnerNode.provenance.claimIds,
       rootSourceVersionIds: winnerNode.provenance.rootSourceVersionIds,
     }),
   })
   ```
2. The next `resolvePolicy` call reads the live `graph.edges` (not the frozen snapshot), detects the
   SUPERSEDES edge, and reclassifies the old candidate to SUPERSEDED.
3. If only one ACTIVE candidate remains, status becomes RESOLVED.

This mechanism is fully reversible: revoking or deactivating the SUPERSEDES edge restores the conflict.
