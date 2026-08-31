# M2G G3 — Precedence Model

**Status:** Architecture draft — preparation phase only.
**Branch:** `claude/duewatch-scaffold-auth-j2ef7c`
**Date:** 2026-08-31

---

## Principle

G3 reasons about **explicit precedence evidence only**. It does not assume a universal ordering unless the repository contracts explicitly establish one. Where precedence between two candidates is not documented, the result is `CONFLICTED`, not guessed.

This document defines the G3 precedence model: what types of evidence can establish precedence, how to evaluate them, and what to do when they are absent or contradictory.

---

## Precedence Source Types

Listed roughly from most to least authoritative — but this ordering is **not universal** and **not assumed by G3 at runtime**. G3 applies this ordering only when it can be confirmed by explicit evidence in the knowledge graph for the specific topic. Any deviation from this ordering must produce a conflict.

| Source Type | Description | Escalates to company scope? | Creates standing authority? |
|-------------|-------------|-----------------------------|-----------------------------|
| `FOUNDER_DECISION` | Recorded, attributed, revocable founder decision | Only if explicitly scoped COMPANY | No (R9, R3) |
| `CONTRACT_TERM` | Explicit term in an active, signed contract | Never (R4) | No |
| `APPROVED_COMPANY_POLICY` | Founder-approved policy in the decision log | Yes, if scope is COMPANY | Requires explicit grant |
| `CLIENT_EXCEPTION` | Explicitly stated per-client rule | Never (R4) | No |
| `HISTORICAL_POLICY` | A prior policy no longer marked current | No (R5) | No |
| `OBSERVED_PRECEDENT` | Repeated past behavior | Never (R2) | Never (R2, R3) |
| `COMMUNICATION` | Email, message, or note stating a rule | Depends on scope in evidence | No |
| `UNKNOWN` | Precedence cannot be determined | Never | No |

### Key constraints

**Confidence does not create precedence (R1).** Two candidates with identical scope but different confidence scores remain in conflict. G3 must not resolve by picking the higher-confidence candidate.

**Repeated behavior does not create precedence (R2, R3).** A policy candidate derived from observed behavioral frequency (e.g. "we always charged 5%") has `PrecedenceEvidence.explicit = false`. This candidate is surfaced in `excludedPolicyCandidates` with `exclusionReason: 'OBSERVED_PRECEDENT_NOT_AUTHORITATIVE'`, never in `applicablePolicyCandidates`.

**Client-specific rules never widen to company scope (R4).** A `CONTRACT_TERM` or `CLIENT_EXCEPTION` candidate with `scopeLevel = CLIENT` must never be used to answer a company-scope question. Attempting to widen produces a `SCOPE_ESCALATION` conflict.

**Historical rules never silently become current (R5).** A candidate with `temporalApplicability.state = 'HISTORICAL'` or `'EXPIRED'` is surfaced in `excludedPolicyCandidates` with `exclusionReason: 'HISTORICAL_NOT_CURRENT'`. It must not appear in `applicablePolicyCandidates` unless its continued applicability is explicitly evidenced.

---

## Precedence Evaluation Algorithm

Given two PolicyCandidates A and B with the same topic and overlapping scope:

```
1. Check explicit supersession:
   - If A.precedenceEvidence contains a FOUNDER_DECISION that explicitly supersedes B → A wins, B is SUPERSEDED.
   - If B supersedes A → B wins.
   - Otherwise → continue.

2. Check contract vs policy:
   - If A is CONTRACT_TERM and B is APPROVED_COMPANY_POLICY (or vice versa):
     - If the contract explicitly states it takes precedence → contract candidate wins.
     - If company policy explicitly states it overrides contracts → policy candidate wins.
     - Otherwise → CONFLICT: CONTRACT_VS_COMPANY_POLICY.

3. Check founder instruction:
   - If A is FOUNDER_INSTRUCTION and B is APPROVED_COMPANY_POLICY:
     - Founder instruction is more recent and explicitly scoped → A wins IF temporal applicability is CURRENT.
     - If temporal state of A is UNKNOWN → CONFLICT: FOUNDER_INSTRUCTION_VS_PRIOR_POLICY.

4. Check client exception vs company policy:
   - If A is CLIENT_EXCEPTION (scopeLevel=CLIENT) and B is APPROVED_COMPANY_POLICY (scopeLevel=COMPANY):
     - These are not in conflict for the CLIENT scope — A applies to the client; B applies everywhere else.
     - ONLY if A is being widened to COMPANY scope → CONFLICT: SCOPE_ESCALATION.

5. Check temporal:
   - If A.temporalApplicability.state = EXPIRED and B = CURRENT → B wins (no conflict needed).
   - If A.temporalApplicability.state = UNKNOWN → CONFLICT: OVERLAPPING_EFFECTIVE_PERIODS.

6. Check for confidence-only disagreement:
   - If A and B differ only in confidence, not in any structural precedence → CONFLICT: CONFIDENCE_DISAGREEMENT.
   - Do NOT resolve by confidence (R1).

7. No precedence determined → CONFLICT: MISSING_PRECEDENCE.
```

---

## Precedence for the Acme/Atlas Late-Fee Scenario

| Candidate | Source | Scope | Value | Status |
|-----------|--------|-------|-------|--------|
| A | `collections-policy.md` | COMPANY | 5% late fee | `APPROVED_COMPANY_POLICY` candidate |
| B | `atlas-terms.csv` | CLIENT (Atlas) | 2% late fee | `CONTRACT_TERM` candidate |
| C | `founder-instruction.txt` | COMPANY | No late fees until approval | `FOUNDER_INSTRUCTION` candidate |

**Company-scope question ("What late fee applies company-wide?"):**
- A (5%) vs C (no fees): `FOUNDER_INSTRUCTION_VS_PRIOR_POLICY` conflict. C is a founder instruction with unknown effective-to date. No explicit supersession evidence. G3 result: `CONFLICTED`. Requires founder decision.
- B (Atlas 2%) is CLIENT scope — must not widen (R4). Not applicable to company-scope question.

**Client-scope question ("What late fee applies to Atlas?"):**
- B (2%) is `CONTRACT_TERM` for Atlas. A (5%) is COMPANY policy.
  - A applies company-wide including Atlas, absent an exception.
  - B is an explicit client exception for Atlas.
  - C (no fees) is COMPANY scope — trumps both if current.
  - C is `FOUNDER_INSTRUCTION`: is it CURRENT? Effective-to is not stated → UNKNOWN temporal state.
  - G3 result for Atlas: C (COMPANY scope, FOUNDER_INSTRUCTION, CURRENT temporal state UNKNOWN) produces `CONFLICTED`. Even if C is resolved to CURRENT, Atlas's 2% contractual exception may still apply — but requires founder decision to confirm whether the "no fees" instruction supersedes existing contract terms.

**Historical question ("Does the old 10% policy still apply?"):**
- The 10% is `HISTORICAL_PRECEDENT` (from fixtures: not in current sources but referenced as a historical AR rule).
- No explicit supersession evidence needed — its `temporalApplicability.state = HISTORICAL`.
- G3 result: surfaced in `excludedPolicyCandidates` with `exclusionReason: 'HISTORICAL_NOT_CURRENT'`. Does not apply unless a founder decision explicitly reinstates it.

---

## What a Resolved Precedence Looks Like

When a founder decision explicitly resolves a conflict between two candidates:

```js
// After founder decision:
resolvedCandidate = {
  ...winnerCandidate,
  candidateStatus: 'ACTIVE',           // elevated from CONFLICTED to ACTIVE
  precedenceEvidence: [{
    sourceType: 'FOUNDER_DECISION',
    claimId: decision.id,
    supersedes: [loserCandidate.claimId],
    supersededBy: [],
    explicit: true,
  }],
}
loserCandidate = {
  ...loserCandidate,
  candidateStatus: 'SUPERSEDED',
}
```

The resolution is revocable (R9). If the decision is revoked, both candidates return to `CONFLICTED` state.

---

## Precedence the Repository Must NOT Assume

G3 must not hard-code any of the following orderings unless they are explicitly in the knowledge graph:

- "Contracts always beat company policy" — may be true in some jurisdictions, must be in evidence.
- "More recent always beats older" — recency ≠ supersession.
- "Founder instruction always beats everything" — a founder instruction has the highest weight only when it is current and explicitly documented.
- "Higher confidence wins" — violates R1 by construction.
- "The most specific scope wins" — a client exception does not automatically win over company policy (the company policy may still apply; the exception is additive, not replacing).
