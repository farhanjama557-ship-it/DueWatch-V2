# M2G G3 — Conflict & Policy Intelligence V0

**Status:** Architecture draft — preparation phase only. Implementation blocked on G2 remote checkpoint.
**Branch:** `claude/duewatch-scaffold-auth-j2ef7c`
**Date:** 2026-08-31
**Author:** G3 architecture preparation

---

## Mission

G2 answers: *What entities, claims, policies, contracts, exceptions, roles, evidence, relationships, scopes, conflicts, and provenance exist?*

G3 must answer: *Which rule applies, to whom, at what time, and why — while preserving unresolved conflict when the evidence is insufficient.*

G3 must **not** invent policy. Where evidence is insufficient, G3 must produce `CONFLICTED` or `ABSTAIN`, never a fabricated resolution.

---

## Core Doctrine (Non-negotiable Invariants)

These apply at every layer of G3 reasoning. Any G3 output that violates one of these is a bug, not a design tradeoff.

| # | Invariant |
|---|-----------|
| R0 | Company Brain is not canonical financial truth. |
| R1 | Confidence does not create precedence. |
| R2 | Repeated behavior does not create standing policy or authority. |
| R3 | Repeated founder approvals do not become standing authority. |
| R4 | Client-specific rules never silently widen to company scope. |
| R5 | Historical rules never silently become current. |
| R6 | Revoked/tombstoned evidence cannot remain operational. |
| R7 | Observed delegation is not DW authority. |
| R8 | Missing precedence must produce abstention/conflict, not guessing. |
| R9 | Founder decisions must remain explicit, attributable, and revocable. |

---

## Typed Model

### 1. PolicyCandidate

A rule observed from evidence but not necessarily applicable or authoritative. A `PolicyCandidate` is **never** a binding conclusion — it is the G3 input to the applicability and precedence reasoning layers.

```ts
interface PolicyCandidate {
  id: string                        // stable deterministic ID
  tenantId: string
  claimId: string                   // source G1/G2 claim this is derived from
  claimClass: ClaimClass            // COMPANY_POLICY | CLIENT_EXCEPTION | CONTRACT_TERM | FOUNDER_INSTRUCTION | HISTORICAL_PRECEDENT | …
  topic: string                     // e.g. 'late_fee_policy', 'payment_terms', 'escalation_threshold'
  value: unknown                    // the rule's stated value, uninterpreted
  applicability: PolicyApplicability
  precedenceEvidence: PrecedenceEvidence[]
  temporalApplicability: TemporalApplicability
  provenancePath: ProvenancePath
  confidence: number | null         // null means absent — never used to resolve conflict (R1)
  explicit: boolean                 // true = stated explicitly; false = derived/inferred
  candidateStatus: CandidateStatus  // ACTIVE | SUPERSEDED | REVOKED | EXPIRED | HISTORICAL
}

type CandidateStatus = 'ACTIVE' | 'SUPERSEDED' | 'REVOKED' | 'EXPIRED' | 'HISTORICAL'
```

### 2. PolicyApplicability

Determines the scope within which a candidate may govern. Scope escalation is never implicit (R4).

```ts
interface PolicyApplicability {
  // One of these scope levels — never inferred; unknown = UNKNOWN
  scopeLevel:
    | 'COMPANY'           // applies to all clients / all workflows
    | 'CLIENT'            // applies to a specific named client only
    | 'CONTRACT'          // applies under a specific contract only
    | 'WORKFLOW'          // applies within a specific operational workflow only
    | 'INTERACTION'       // applies to a single logged interaction only
    | 'HISTORICAL'        // applies only in retrospective analysis, not current ops
    | 'UNKNOWN'           // scope is not determinable from evidence

  clientId: string | null           // set only when scopeLevel = CLIENT
  contractId: string | null         // set only when scopeLevel = CONTRACT
  workflowId: string | null         // set only when scopeLevel = WORKFLOW

  // Scope escalation guard: CLIENT/CONTRACT rules must never widen to COMPANY without
  // explicit founder evidence (R4). Any widening attempt produces a SCOPE_ESCALATION conflict.
  widensTo: 'COMPANY' | null        // always null unless explicitly evidenced
}
```

### 3. PrecedenceEvidence

G3 reasons about explicit precedence evidence only. It does **not** assume a universal ordering (R8). Where precedence is not documented, G3 returns `CONFLICTED`.

```ts
interface PrecedenceEvidence {
  sourceType:
    | 'FOUNDER_DECISION'           // explicit founder decision in the decision log
    | 'CONTRACT_TERM'              // explicit term in a signed/active contract
    | 'APPROVED_COMPANY_POLICY'    // founder-approved company-wide policy
    | 'CLIENT_EXCEPTION'           // explicitly stated per-client exception
    | 'HISTORICAL_POLICY'          // prior policy no longer current (R5)
    | 'OBSERVED_PRECEDENT'         // repeated past behavior — never creates authority (R2, R3)
    | 'COMMUNICATION'              // email/message stating a rule
    | 'UNKNOWN'                    // precedence cannot be determined

  claimId: string                  // the specific claim asserting this precedence
  supersedes: string[]             // claim IDs this source explicitly supersedes (must be documented)
  supersededBy: string[]           // claim IDs that explicitly supersede this source
  explicit: boolean                // false = inferred from repeated behavior → never grants authority (R2)
}
```

### 4. TemporalApplicability

See `M2G_G3_TEMPORAL_APPLICABILITY.md` for full specification.

```ts
interface TemporalApplicability {
  state: 'CURRENT' | 'FUTURE' | 'HISTORICAL' | 'EXPIRED' | 'UNKNOWN'
  effectiveFrom: ISODateString | null    // null = not stated in evidence
  effectiveTo: ISODateString | null      // null = not stated or open-ended
  inferredFrom: string[]                 // claim IDs used if dates were derivable
  // CRITICAL: effective dates must not be inferred when absent (R5).
  // effectiveFrom === null does NOT mean "now"; it means "unknown".
}
```

### 5. ConflictClassification

Every G3 conflict carries an explicit class so the founder decision UI can frame the right question.

```ts
type ConflictClass =
  | 'SAME_SCOPE_INCOMPATIBLE_VALUES'      // e.g. two company-wide late-fee policies with different rates
  | 'COMPANY_VS_CLIENT_EXCEPTION'         // company policy conflicts with a stated client exception
  | 'CONTRACT_VS_COMPANY_POLICY'          // contract term contradicts approved company policy
  | 'FOUNDER_INSTRUCTION_VS_PRIOR_POLICY' // founder instruction contradicts standing policy
  | 'CURRENT_VS_HISTORICAL'               // current claim contradicts historical precedent
  | 'OVERLAPPING_EFFECTIVE_PERIODS'       // two claims with overlapping effective-date windows
  | 'AMBIGUOUS_ENTITY_IDENTITY'           // same subject named differently across sources
  | 'REVOKED_EVIDENCE_STILL_REFERENCED'   // a revoked source is referenced by a live claim
  | 'MISSING_PRECEDENCE'                  // two claims, neither has documented precedence
  | 'CONTRADICTORY_EXPLICIT_INSTRUCTIONS' // two explicit founder/policy instructions disagree
  | 'SCOPE_ESCALATION'                    // a CLIENT rule is referenced as if COMPANY-wide
  | 'CONFIDENCE_DISAGREEMENT'             // claims agree on topic but disagree on value via confidence only
  | 'DANGLING_PROVENANCE'                 // claim references non-existent or revoked provenance root
  | 'DUPLICATE_EVIDENCE'                  // same claim appears via multiple evidence paths with no reconciliation

interface G3Conflict {
  id: string
  tenantId: string
  topic: string
  conflictClass: ConflictClass
  competingCandidateIds: string[]         // PolicyCandidate IDs in conflict
  status: ConflictResolutionStatus
  resolutionDecisionId: string | null
  winnerCandidateId: string | null        // null unless RESOLVED with explicit winner
  explanation: string                     // human-readable statement of why this is a conflict
  founderDecisionRequired: boolean        // true = cannot resolve without founder
  revision: number
}

type ConflictResolutionStatus = 'RESOLVED' | 'CONFLICTED' | 'AMBIGUOUS' | 'UNRESOLVED' | 'NOT_APPLICABLE'
```

### 6. ProvenancePath

Every material G3 conclusion must expose its evidence chain, fully traceable to root sources.

```ts
interface ProvenancePath {
  claimId: string
  artifactIds: string[]
  rootSourceIds: string[]            // G1 source IDs; all must be active (R6)
  depth: number                      // hops from claim to root
  complete: boolean                  // false if any link in the chain is missing/revoked
  tombstonedSourceIds: string[]      // root sources that have been revoked/tombstoned
}
```

---

## Ask DW Contract (G3)

G3 Ask DW answers must structurally separate:

```
FACT         — what the evidence directly states
POLICY       — what rule is observed or approved
SCOPE        — who/what the rule applies to
TEMPORAL     — when the rule applies (or UNKNOWN)
CONFLICT     — what is in conflict and why
FOUNDER_DECISION — what explicit founder decision exists, if any
DW_AUTHORITY — whether DW has authority to act automatically
```

Every material conclusion must expose evidence/provenance (claim IDs, source IDs).

**Reference answer for "What late fee applies to Atlas?":**

```
FACT: Atlas has an active contract term stating 2% late fee (claim: atlas-terms-claim-1, source: atlas-terms-csv).
POLICY: Company-wide late-fee policy is currently CONFLICTED:
  - Claim A: 5% (collections-policy.md, scope: COMPANY)
  - Claim C: late fees stopped until founder approval (founder-instruction.txt, scope: COMPANY)
  - No founder decision has resolved this conflict.
SCOPE: The 2% Atlas term is CLIENT scope. It cannot widen to COMPANY scope (R4).
TEMPORAL: Atlas term has no explicit effective-from/to — UNKNOWN whether it is current.
CONFLICT: FOUNDER_INSTRUCTION_VS_PRIOR_POLICY — company-wide policy is unresolved.
FOUNDER_DECISION: None recorded for late_fee_policy resolution.
DW_AUTHORITY: DW has no authority to apply any late fee automatically.
  Reason: company-wide policy is CONFLICTED; no founder decision has resolved it.
  The Atlas 2% cannot be applied company-wide (R4).
  The founder instruction (fees stopped) is COMPANY scope and unresolved (R9).
```

G3 must never produce an answer that resolves a CONFLICTED policy by selecting the highest-confidence or most-recent value.

---

## DW Intelligence Context (G3)

The G3 context payload passed to DW Intelligence consumers:

```ts
interface G3DwIntelligenceContext {
  tenantId: string
  snapshotId: string
  knowledgeVersion: number
  generatedAt: ISOTimestamp

  // All observed policy candidates for the requested topic/scope
  applicablePolicyCandidates: PolicyCandidate[]

  // Candidates excluded from consideration (revoked, out-of-scope, superseded)
  // Included for audit/explainability — must not influence active reasoning
  excludedPolicyCandidates: Array<PolicyCandidate & { exclusionReason: string }>

  // Active conflicts with class, status, and explanation
  unresolvedConflicts: G3Conflict[]

  // Explicit precedence evidence available
  precedenceEvidence: PrecedenceEvidence[]

  // Temporal applicability for each active candidate
  temporalApplicability: TemporalApplicability[]

  // Client-specific exceptions (all, not filtered)
  clientExceptions: PolicyCandidate[]

  // Recorded founder decisions relevant to the topic
  founderDecisions: Array<{
    decisionId: string
    decidedAt: ISOTimestamp
    target: string
    newState: unknown
    evidenceClaimIds: string[]
    reason: string
    revocable: boolean
  }>

  // Full provenance paths for every active candidate
  provenancePaths: ProvenancePath[]

  // Uncertainty characterization
  uncertainty: {
    hasUnresolvableConflicts: boolean
    hasMissingEffectiveDates: boolean
    hasMissingPrecedence: boolean
    hasDanglingProvenance: boolean
    hasRevokedEvidence: boolean
  }

  // DW authority boundary — always enforced, never overridden
  authorityBoundary: {
    canonicalMoneyWritable: false        // R0 — structural invariant
    canActAutomatically: boolean         // false whenever any relevant conflict is CONFLICTED/UNRESOLVED
    blockedBy: string[]                  // conflict IDs or reasons blocking automatic action
    requiresFounderDecision: boolean
  }
}
```

---

## G3 Interfaces Required from G2

G3 depends on G2 providing the following. These are **architectural requirements**, not implementation details for this document:

| Interface | Required form | Reason |
|-----------|---------------|--------|
| `Claim.semanticScope` enriched | Must include `scopeLevel` matching `PolicyApplicability.scopeLevel` (COMPANY/CLIENT/CONTRACT/WORKFLOW/INTERACTION/HISTORICAL/UNKNOWN) | Scope applicability cannot be derived from raw text |
| `Claim.effectiveTime` enriched | Must carry structured `{ from, to }` or explicit `UNKNOWN` markers, not a free string | Temporal reasoning requires machine-readable dates |
| `Claim.claimClass` coverage | Must cover `CONTRACT_TERM` as a first-class class (currently absent from G1's `CLAIM_CLASS`) | Distinguishing CONTRACT_TERM from CLIENT_EXCEPTION is central to conflict classification |
| Entity identity normalization | G2 must provide canonical entity IDs so G3 can detect ambiguous entity identity conflicts | "Atlas" and "Atlas Global Ltd" must resolve to one canonical ID |
| Supersession evidence | When a claim supersedes another, G2 must encode the `supersedes` relationship explicitly | G3 cannot infer supersession from dates or confidence alone |
| Conflict detection | G1's `detectConflicts` hardcodes `late_fee_policy`. G2 must generalize to any topic | G3 conflict classification requires topic-agnostic conflict detection |
| Provenance completeness | `ProvenancePath.complete` requires G2 to flag claims with broken artifact chains | G3 rejects incomplete provenance (R6) |

---

## G3 Exit Gate

G3 is complete when:

1. All 30+ adversarial scenarios in `M2G_G3_ADVERSARIAL_PLAN.md` are covered by passing tests.
2. Ask DW answers structurally separate FACT/POLICY/SCOPE/TEMPORAL/CONFLICT/FOUNDER_DECISION/DW_AUTHORITY.
3. No G3 path resolves a CONFLICTED policy by confidence, recency, or behavioral frequency.
4. R0–R9 invariants each have at least one dedicated regression test.
5. `canonicalMoneyWritable: false` is structurally enforced on every G3 output path.
6. `DwIntelligenceContext.authorityBoundary.canActAutomatically` is `false` whenever any relevant conflict is in `CONFLICTED` or `UNRESOLVED` state.
7. G2's generalized conflict detection has replaced G1's `late_fee_policy` hardcode.

---

## Architectural Questions G2 Must Resolve First

1. **Entity identity**: How does G2 canonicalize named entities (client names, person names, role titles) across sources? G3's `AMBIGUOUS_ENTITY_IDENTITY` conflict class requires a canonical entity ID that G2 provides.

2. **`CONTRACT_TERM` class**: Is `CONTRACT_TERM` a new `CLAIM_CLASS` enum value, or a `CLIENT_EXCEPTION` with a `contractId` subtype? G3 handles these differently (contract terms have contractual precedence; client exceptions do not).

3. **Effective-date structure**: Does G2 parse `effectiveTime` into a structured `{ from: ISO | null, to: ISO | null }` or does it remain free text? G3's temporal layer needs machine-readable dates.

4. **Supersession encoding**: When one source supersedes another (e.g. a new policy replaces an old one), does G2 encode this as a claim relationship, a source tombstone, or a separate `SUPERSESSION` artifact? G3 conflict classification treats explicit supersession very differently from version collision.

5. **Conflict detection scope**: G1's `detectConflicts` only covers `late_fee_policy`. Does G2 generalize topic detection, or does G3 own the topic taxonomy? The answer determines where topic detection logic lives.
