# M2G G3 — Adversarial Test Plan

**Status:** Architecture draft — preparation phase only. Tests in `companyBrainG3Policy.test.mjs` are stubbed/skipped until G2 interfaces are available.
**Branch:** `claude/duewatch-scaffold-auth-j2ef7c`
**Date:** 2026-08-31

---

## Fixture baseline (Acme/Atlas late-fee scenario)

All adversarial scenarios build on or extend this baseline:

| Source | Content | Claim class | Scope |
|--------|---------|-------------|-------|
| `g1-realistic/collections-policy.md` | 5% late fee | `COMPANY_POLICY` | COMPANY |
| `g1-realistic/atlas-terms.csv` | Atlas: 2% late fee, 45-day terms | `CLIENT_EXCEPTION` / `CONTRACT_TERM` | CLIENT (Atlas) |
| `g1-realistic/founder-instruction.txt` | Late fees stopped until approval | `FOUNDER_INSTRUCTION` | COMPANY |
| (synthetic) historical AR policy | 10% late fee (prior) | `HISTORICAL_PRECEDENT` | COMPANY |

---

## Adversarial Scenarios

### Group A — Conflicting same-scope policies

**A1. Same-scope, same-topic, incompatible values**  
Two company-policy sources both state a late-fee rate (5% and 7%).  
Expected: `SAME_SCOPE_INCOMPATIBLE_VALUES` conflict; both candidates in `unresolvedConflicts`; `canActAutomatically: false`.

**A2. Same-scope, same-topic, one supersedes the other (explicit)**  
Source B explicitly states "supersedes the 5% policy from [date]."  
Expected: B wins; A status = `SUPERSEDED`; no conflict; `canActAutomatically` depends on B's authority grant.

**A3. Same-scope, same-topic, one appears newer (no explicit supersession)**  
Source B has a later ingestion timestamp but no supersession language.  
Expected: `SAME_SCOPE_INCOMPATIBLE_VALUES` conflict (R5 — recency ≠ supersession); G3 must not resolve by timestamp.

**A4. Confidence disagreement — both sources agree on topic, differ on value by confidence only**  
Source A: 5% (confidence 0.9). Source B: 7% (confidence 0.7).  
Expected: `CONFIDENCE_DISAGREEMENT` conflict; G3 must not pick A (R1).

---

### Group B — Client exception vs company policy

**B1. Explicit client exception, company policy exists**  
Collections SOP: 5%. Atlas contract: 2%.  
Expected: For company-scope query → 5% COMPANY policy applies (but conflicted with founder instruction). For Atlas-scope query → both candidates surface; Atlas exception is CLIENT scope; no scope widening.

**B2. Client exception attempted as company rule**  
A subsequent ingestion claims "the Atlas rate (2%) is now company policy" without founder evidence.  
Expected: `SCOPE_ESCALATION` conflict; the 2% candidate flagged `candidateStatus: 'ACTIVE'` in CLIENT scope only; company-scope query still returns the 5% candidate (and CONFLICTED with founder instruction).

**B3. Two client exceptions for the same client, incompatible**  
Atlas has two sources stating different late-fee rates.  
Expected: `SAME_SCOPE_INCOMPATIBLE_VALUES` conflict within CLIENT (Atlas) scope.

**B4. Client exception references a revoked contract**  
Atlas exception exists, but the contract source has been tombstoned.  
Expected: Atlas exception moves to `excludedPolicyCandidates` with `exclusionReason: 'REVOKED_EVIDENCE'`; conflict dissolves for that candidate; remaining conflict state re-evaluated.

---

### Group C — Missing effective dates

**C1. All candidates have null effective dates**  
All three Acme/Atlas sources have no `effectiveFrom`/`effectiveTo`.  
Expected: All candidates have `temporalApplicability.state: 'UNKNOWN'`; company query returns `CONFLICTED`; `hasMissingEffectiveDates: true`.

**C2. One candidate has effectiveFrom, others do not**  
Collections SOP explicitly states "effective 2024-01-01."  
Expected: SOP candidate gets `state: 'CURRENT'` if `effectiveFrom <= queryDate`; others remain `UNKNOWN`; still CONFLICTED because UNKNOWN candidates cannot be ruled out.

**C3. Candidate has effectiveTo in the past**  
An old policy explicitly states "expires 2023-12-31."  
Expected: That candidate gets `state: 'EXPIRED'`; excluded from `applicablePolicyCandidates`; surfaced in `excludedPolicyCandidates` with `exclusionReason: 'EXPIRED'`.

---

### Group D — Overlapping temporal rules

**D1. Two policies with overlapping effective periods**  
Policy A: 2023-01-01 to 2025-12-31. Policy B: 2024-06-01 to open-ended.  
Expected: `OVERLAPPING_EFFECTIVE_PERIODS` conflict for the 2024-06-01 to 2025-12-31 window; both candidates in `unresolvedConflicts`.

**D2. Future contract not yet in effect**  
Atlas signs a new contract with effectiveFrom 3 months from now.  
Expected: New contract candidate gets `state: 'FUTURE'`; excluded from `applicablePolicyCandidates` for current queries; surfaced as a FUTURE candidate in context for planning queries.

**D3. Expired contract, no replacement**  
Atlas's 2% contract expired 6 months ago. No new contract ingested.  
Expected: Atlas exception gets `state: 'EXPIRED'`; no exception applies to Atlas; company policy (conflicted) is the only applicable candidate; founder decision required.

---

### Group E — Revoked source

**E1. Company policy source revoked mid-session**  
Collections SOP source is revoked after a snapshot is built.  
Expected: Snapshot marked `STALE` (G1 Gap 3 behavior); fresh G3 context excludes SOP candidate; `hasRevokedEvidence: true` in uncertainty; company query result changes.

**E2. Contract source revoked — client exception vanishes**  
Atlas contract source revoked.  
Expected: Atlas exception moves to `excludedPolicyCandidates`; Atlas-scope query returns company policy (still CONFLICTED with founder instruction).

**E3. Founder instruction source revoked**  
The "no late fees" instruction source is revoked.  
Expected: Founder instruction candidate excluded; company query now conflicts only between collections SOP (5%) and any other surviving policies.

---

### Group F — Historical alias and ambiguous entity identity

**F1. Historical AR rule referenced as current**  
A new source ingests: "We charge a 10% late fee like we always have."  
Expected: `HISTORICAL_PRECEDENT` candidate remains `HISTORICAL`; `CURRENT_VS_HISTORICAL` conflict with current candidates; G3 must not elevate the 10% to CURRENT status.

**F2. Ambiguous client identity**  
Two sources reference "Atlas" and "Atlas Global" with different terms.  
Expected: `AMBIGUOUS_ENTITY_IDENTITY` conflict; both candidates surface; G3 cannot assume they are the same entity without canonical entity ID from G2.

**F3. Client with two simultaneous contracts**  
Atlas has two active contracts with different late-fee terms, both with overlapping effective periods.  
Expected: `OVERLAPPING_EFFECTIVE_PERIODS` + `SAME_SCOPE_INCOMPATIBLE_VALUES` conflict; both candidates in `unresolvedConflicts`; requires founder decision to designate governing contract.

---

### Group G — Communication and behavioral evidence

**G1. Repeated emails suggest a rule (no founder decision)**  
10 emails from an account manager say "we give clients 30 days before charging fees."  
Expected: `OBSERVED_PRECEDENT` candidate with `explicit: false`; excluded from `applicablePolicyCandidates` (R2); `exclusionReason: 'OBSERVED_PRECEDENT_NOT_AUTHORITATIVE'`; does NOT create standing policy.

**G2. Repeated founder approvals for the same action**  
Founder has approved "waive Atlas late fee" 25 times.  
Expected: Authority evaluation returns `REQUIRE_APPROVAL` with a suggestion (G1 behavior); does NOT upgrade to standing authority (R3); `repeatedApprovalCount: 25`; no `GRANTED` result.

**G3. Staff member claims a new policy exists**  
An ingested email from a non-founder employee states "policy is now 3% late fees."  
Expected: `COMMUNICATION` candidate with `explicit: false` (not a founder decision); very low trust zone; surfaces in context but cannot override `COMPANY_POLICY` or `FOUNDER_INSTRUCTION` without founder decision.

---

### Group H — Confidence and provenance

**H1. Derived summary contradicts root evidence**  
An AI-derived artifact states "late fee policy is 5%" but the root source (collections-policy.md) was revoked.  
Expected: Derived claim fails provenance validation (all root source IDs must be active, R6); claim moves to `excludedPolicyCandidates` with `exclusionReason: 'REVOKED_EVIDENCE'`.

**H2. Duplicate evidence — same claim via two paths**  
The collections SOP is ingested twice (two source versions). Both produce the same claim value.  
Expected: `DUPLICATE_EVIDENCE` detected; only one candidate is surfaced in `applicablePolicyCandidates` (deduplication by content hash or canonical claim ID); the other surfaces in `excludedPolicyCandidates` with `exclusionReason: 'DUPLICATE'`.

**H3. Dangling provenance reference**  
A claim references an artifact ID that does not exist in the knowledge graph.  
Expected: Claim excluded with `exclusionReason: 'DANGLING_PROVENANCE'`; `hasDanglingProvenance: true` in uncertainty; the claim does not influence any G3 conclusion.

---

### Group I — Cross-tenant and isolation

**I1. Cross-tenant evidence reference**  
Tenant A's G3 context is built using a claim ID from Tenant B's knowledge graph.  
Expected: G3 rejects the cross-tenant reference; the claim is not included; `DANGLING_PROVENANCE` conflict if the reference appeared in evidence; tenant isolation preserved.

**I2. Cross-tenant authority proposal evidence**  
An authority proposal for Tenant A references claim IDs from Tenant B.  
Expected: Proposal rejected at persist time (G1 Gap 4 behavior); no G3 context is built from cross-tenant evidence.

---

### Group J — Scope and precedence edge cases

**J1. Policy without explicit scope**  
A source states "late fees are 4%" with no indication of whether this is company-wide or client-specific.  
Expected: Candidate gets `scopeLevel: 'UNKNOWN'`; surfaces in `applicablePolicyCandidates` with uncertainty; does not resolve company-scope or client-scope questions; requires founder decision to establish scope.

**J2. Precedence not documented — two explicit policies, neither references the other**  
Collections SOP (5%) and a separately-approved exception policy (3%) both exist at COMPANY scope with no supersession language.  
Expected: `MISSING_PRECEDENCE` conflict; both candidates in `unresolvedConflicts`; `canActAutomatically: false`.

**J3. Stale graph version — snapshot built before a revocation**  
G3 context is built from a `STALE` snapshot.  
Expected: G3 refuses to use the stale snapshot; rebuilds context from current revocation state (G1 Gap 3 behavior); stale snapshot surfaced in `excludedPolicyCandidates` with `exclusionReason: 'STALE_SNAPSHOT'`.

**J4. Policy supersession without explicit supersession evidence**  
Policy B is ingested after Policy A. Policy B makes no reference to A. No tombstone for A.  
Expected: Both remain as ACTIVE candidates; `SAME_SCOPE_INCOMPATIBLE_VALUES` conflict; G3 does not infer B supersedes A from ingestion order.

---

### Group K — R0/Invariant regression

**K1. R0 — no G3 output may write or imply canonical financial truth**  
G3 conflict reasoning for "late fee policy" must not produce any output implying DW can modify invoice AR state, payment state, or any other financial ledger entry.  
Expected: `canonicalMoneyWritable: false` on all G3 outputs; `canActAutomatically: false` unless an approved, scoped authority grant exists.

**K2. R1 — confidence-based resolution attempt**  
A test directly calls the G3 precedence evaluator with two candidates differing only in confidence.  
Expected: Result is `CONFLICTED: CONFIDENCE_DISAGREEMENT`; the higher-confidence candidate is NOT designated winner.

**K3. R4 — scope escalation attempt**  
A test directly calls G3 with a CLIENT-scope candidate flagged as a COMPANY answer.  
Expected: `SCOPE_ESCALATION` conflict; the CLIENT candidate does not appear in the COMPANY-scope resolution.

**K4. R6 — revoked evidence remains excluded**  
After a source revocation, G3 is called to build context. The revoked source produced the only candidate that could resolve a conflict.  
Expected: Conflict remains `CONFLICTED`; revoked candidate is in `excludedPolicyCandidates`; `hasRevokedEvidence: true`; no automatic resolution.

**K5. R8 — abstention on missing precedence**  
G3 evaluator is called with two candidates, neither has any precedence evidence.  
Expected: Result is `CONFLICTED: MISSING_PRECEDENCE`; no winner designated; `founderDecisionRequired: true`.

---

## Expected G3 Behaviors — Ask DW Questions

| Question | Expected G3 behavior |
|----------|----------------------|
| "What late fee applies company-wide?" | CONFLICTED: FOUNDER_INSTRUCTION_VS_PRIOR_POLICY; no automatic answer; list all candidates with provenance; state founder decision required. |
| "What late fee applies to Atlas?" | Atlas has CONTRACT_TERM (2%); company CONFLICTED; C (no fees) may apply if CURRENT; temporal state UNKNOWN for all candidates; CONFLICTED overall. |
| "Does Atlas's 2% apply to every client?" | No — CLIENT scope; widening to COMPANY would be SCOPE_ESCALATION; current company policy is CONFLICTED. |
| "Does the old 10% policy still apply?" | HISTORICAL state; excluded from current applicability; available for retrospective analysis only. |
| "Can DW charge the 5% late fee automatically?" | No — company policy CONFLICTED with founder instruction; no authority grant; canActAutomatically: false. |
| "Why does this policy apply?" | Expose full provenance path: claim → artifact → source; all root source IDs; founder decision ID if resolved. |
| "What evidence conflicts?" | Surface all unresolvedConflicts with conflictClass, competingCandidateIds, and explanation. |
| "What changed over time?" | List candidates by temporalApplicability state; surface HISTORICAL and EXPIRED candidates from excludedPolicyCandidates. |
| "What decision is required from the founder?" | List all founderDecisionRequired = true conflicts; surface the question G3 cannot resolve autonomously. |

---

## Exit Gate for Adversarial Coverage

All 30+ scenarios above must have test cases in `companyBrainG3Policy.test.mjs`. Tests may be `test.skip()` while awaiting G2 interfaces. A scenario is not coverage until the test:
1. Sets up the specific evidence configuration.
2. Calls the G3 evaluator.
3. Asserts the specific expected conflict class, resolution status, and key context fields.
4. Asserts the specific invariant (R0–R9) that the scenario is regressing.
