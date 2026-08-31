# M2G G3 — Evidence Model

**Status:** Implemented
**Branch:** `m2g/company-brain-bootstrap-g3`
**Date:** 2026-08-31

---

## Provenance Chain

Every G3 policy candidate traces its evidence through two layers:

```
Source (file/text)
  → SourceVersion (versioned, status: ACTIVE | INVALIDATED | FAILED)
    → Claim (claimClass, claimType, value, provenanceRootIds)
      → GraphNode (POLICY_CANDIDATE or CLIENT_EXCEPTION, stableKey)
        → G3 PolicyCandidate (with candidateStatus, temporalState)
```

G3 reads this chain via:
- `brain.claims.find(c => c.id === node.data.claimId)` — claim linked to graph node
- `brain.sourceVersions.filter(sv => sv.status === 'ACTIVE')` — active source versions
- `claim.provenanceRootIds` — source version ids backing the claim

---

## Dangling Provenance (R6)

A claim is **dangling** if any of its `provenanceRootIds` does not appear in the set of ACTIVE source
versions. This can happen when:
- The backing source is revoked via `revokeSource`
- The source version was INVALIDATED by a re-ingest
- The claim root was manually injected without a matching source version

`detectDanglingProvenance(brain, { tenantId })` surfaces all such claims.

`buildPolicyCandidates` checks each candidate's claim against the active source version set and sets
`candidateStatus = CANDIDATE_STATUS.DANGLING` for any with broken provenance.

`classifyConflicts` then emits a `DANGLING_PROVENANCE` finding for each such candidate.

**Dangling candidates are excluded from the active resolution set in `resolvePolicy`** — they cannot
be winners regardless of their temporal state. This is the structural enforcement of R6.

---

## Provenance on G3 Outputs

Every `G3_POLICY_RESOLUTION_V0` output includes:
```js
provenance: {
  rootSourceVersionIds: [...new Set(topicCandidates.flatMap(c => c.provenance.rootSourceVersionIds))]
}
```
This aggregates all source version IDs across every candidate considered (not just the winner), enabling
full auditability of which evidence was evaluated.

---

## Independent vs Derived Evidence

`provenance.independent: boolean` on each PolicyCandidate reflects whether the underlying claim was
derived from another claim (`claim.derived === true` → independent: false) or directly extracted from a
source. Two candidates backed by the same single source version have `independentRootCount: 1`; two
backed by different independent sources have `independentRootCount: 2`.

**Independent root count does not influence conflict resolution** — it is metadata for audit only (R1, R2).

---

## What G3 Does NOT Write

G3 is a pure reasoning layer. It:
- Makes no storage writes
- Makes no financial mutations
- Makes no provider or API calls
- Does not modify `brain.claims`, `brain.sources`, `brain.conflicts`, or any graph data
- Does not call `supabase`, `database.rpc`, or any external service

All outputs are in-memory value objects annotated with `canonicalMoneyWritable: false` (R0).
