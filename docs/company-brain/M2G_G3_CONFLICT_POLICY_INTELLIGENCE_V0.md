# M2G G3 — Conflict & Policy Intelligence V0

**Status:** Implemented — G3 runtime in `src/lib/companyBrain/policyIntelligence.js`.
Tests in `companyBrainG3Policy.test.mjs` all pass (189 tests, 0 failures, 0 todo).
G2 frozen checkpoint: `5d0dc3b`.
**Branch:** `m2g/company-brain-bootstrap-g3`
**Date:** 2026-08-31

---

## Mission

G2 answers: *What entities, claims, policies, contracts, exceptions, roles, evidence, relationships,
scopes, conflicts, and provenance exist in the Company Graph?*

G3 must answer: *Which rule applies, to whom, at what time, and why — while preserving unresolved
conflict when the evidence is insufficient.*

G3 must **not** invent policy. Where evidence is insufficient, G3 must produce `CONFLICTED` or
`ABSTAIN`, never a fabricated resolution.

---

## Core Doctrine (Non-negotiable Invariants)

These apply at every layer of G3 reasoning. Any G3 output that violates one of these is a bug,
not a design tradeoff.

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

## Real G2 Interfaces G3 Builds On

G3 **must** use these exact G2 APIs as they exist in the frozen checkpoint. Do not design G3
against assumed or future APIs.

### `CompanyBrainDurableStore` (durableStore.js)

- `ingestContent({ actor, tenantId, filename, content, sourceIdentity, idempotencyKey })` — ingests
  raw content, extracts deterministic claims, bumps `knowledgeVersion`, rebuilds conflicts
- `ingestLocalFile({ actor, tenantId, filePath, sourceIdentity, idempotencyKey })` — file variant
- `queryClaims({ actor, tenantId, claimType, semanticScope, clientId, active, sourceVersionId })`
  — filtered claim query
- `revokeSource({ actor, tenantId, sourceId, reason })` — revokes source + all versions; deactivates
  all dependent claims and artifacts; rebuilds conflicts; creates tombstone
- `recordFounderDecision({ actor, tenantId, idempotencyKey, targetId, expectedRevision, ... })` —
  Gap-1/2/4-hardened decision recording; resolves a conflict
- `persistAuthorityProposal({ actor, tenantId, proposal })` / `decideAuthority({ ... })`
- `evaluateAuthority({ actor, tenantId, actionClass, scope, approvalHistory })`
- `createSnapshot({ actor, tenantId })` / `latestSnapshot({ actor, tenantId })`
- `askDw({ actor, tenantId, question })` — delegates to `answerAskDwFromCompanyBrain`
- `dwIntelligenceContext({ actor, tenantId, clientId })` — delegates to `toDwIntelligenceCompanyContext`

### `CompanyGraphStore` (graphStore.js)

- `build({ actor, tenantId })` — builds/caches a `COMPANY_GRAPH_SNAPSHOT_V0` from the current
  brain state; returns immediately if fingerprint matches
- `requireSnapshot(input)` / `activeSnapshot({ actor, tenantId })` — freshness-gated snapshot access
- `getPoliciesApplicable({ actor, tenantId, scope })` — `scope.level = SEMANTIC_SCOPE.COMPANY` or
  `SEMANTIC_SCOPE.CLIENT` with `scope.clientId`; returns POLICY_CANDIDATE and CLIENT_EXCEPTION nodes;
  CLIENT_EXCEPTION nodes never appear for COMPANY scope (R4 structurally enforced in the graph)
- `getEntity({ actor, tenantId, type, identity })` — normalized entity lookup
- `resolveClientAlias({ actor, tenantId, alias })` — returns `{ state, selectedKey, candidateKeys }`
  where `state` ∈ `RESOLUTION_STATE` enum
- `getContractsForClient({ actor, tenantId, clientId })` — active `CONTRACT` nodes for a client
- `getUnresolvedRelationships({ actor, tenantId })` — all resolutions with `state != RESOLVED`
- `getEvidence({ actor, tenantId, stableKey })` — full provenance for any node or edge stableKey
- `getRolesDelegation({ actor, tenantId })` — HAS_ROLE, ROLE_IN_COMPANY, OBSERVED_DELEGATION edges
- `getPrecedents({ actor, tenantId, clientId })` — PRECEDENT nodes for a client
- `askDw({ actor, tenantId, question })` — graph-level Ask DW (different from brain-level)
- `dwIntelligenceContext({ actor, tenantId, clientId })` — returns `DW_INTELLIGENCE_COMPANY_GRAPH_CONTEXT_V0`

### Claim extraction (extractDeterministicClaims)

The real extractor recognizes these patterns:

**CSV with headers `client`, `payment_terms_days`, `late_fee_percent`:**
- → `CLIENT_EXCEPTION` / `late_fee_policy` (one row per client with a `late_fee_percent` column)
- → `PAYMENT_TERMS_CONTEXT` / `payment_terms` (one row per client with `payment_terms_days`)

**CSV with `entity_type`, `entity_id`, `name`:** → `INTERPRETATION` / `entity_record`
**CSV with `person_id`, `role_id`, `company_id`:** → `ROLE` / `role_record` + optionally `DELEGATION`
**CSV with `alias`, `entity_id`:** → `INTERPRETATION` / `alias_record`

**Text / Markdown — regex patterns (no frontmatter):**
- `"charge a N% late fee"` or `"N% late fee"` → `COMPANY_POLICY` / `late_fee_policy`
- `"stopped charging late fees until I approve"` → `FOUNDER_INSTRUCTION` / `late_fee_policy`
- `"give Atlas 20% off"` → `INTERPRETATION` / `settlement_discount_statement` (uncertainty: `COMMUNICATION_NOT_AUTHORITY`)
- `"Invoice 104 was paid yesterday"` → `INTERPRETATION` / `contextual_payment_statement` (R0 route)

**Markdown with frontmatter `document_type` key:**
- `contract` → `PAYMENT_TERMS_CONTEXT` / `contract_record` (carries `effectiveTime: { from, to }`)
- `policy_candidate` → `COMPANY_POLICY` / `policy_candidate_record`
- `client_exception` → `CLIENT_EXCEPTION` / `client_exception_record`
- `workflow` → `COLLECTION_WORKFLOW` / `workflow_record`
- `precedent` → `HISTORICAL_PRECEDENT` / `precedent_record`
- `interaction` → `INTERPRETATION` / `interaction_record`
- `orphan_reference` → `INTERPRETATION` / `orphan_reference_record`

All frontmatter docs carry `effectiveTime: { from: meta.effective_from | null, to: meta.effective_to | null }`.
A `scope: HISTORICAL` or a non-null `effective_to` sets `temporality: 'HISTORICAL'`.

### CLAIM_CLASS enum (index.js)

```
COMPANY_POLICY | CLIENT_EXCEPTION | ROLE | DELEGATION | AUTHORITY |
COMMUNICATION_PREFERENCE | COLLECTION_WORKFLOW | DISPUTE_PROCESS |
PAYMENT_TERMS_CONTEXT | HISTORICAL_PRECEDENT | FOUNDER_INSTRUCTION | INTERPRETATION
```

**`CONTRACT_TERM` does NOT exist** as a `CLAIM_CLASS`. Contract data is carried via
`PAYMENT_TERMS_CONTEXT` / `contract_record` claims and surfaces as `CONTRACT` graph nodes.

### GRAPH_NODE_TYPE and GRAPH_EDGE_TYPE (graphStore.js)

```
GRAPH_NODE_TYPE: COMPANY | CLIENT | PERSON | ROLE | CONTRACT | POLICY_CANDIDATE |
                 WORKFLOW | CLIENT_EXCEPTION | PRECEDENT | SOURCE | ARTIFACT | CLAIM | CONFLICT

GRAPH_EDGE_TYPE: BELONGS_TO_COMPANY | CLIENT_OF | HAS_CONTRACT | APPLIES_TO_CLIENT |
                 APPLIES_TO_COMPANY | HAS_ROLE | ROLE_IN_COMPANY | OBSERVED_DELEGATION |
                 REFERENCES_POLICY | EXCEPTION_FOR | SUPPORTED_BY | DERIVED_FROM |
                 CONFLICTS_WITH | PRECEDENT_FOR | HISTORICAL_TO | ALIAS_OF | SUPERSEDES
```

**`SUPERSEDES` edge requires `explicit: true`** — the store enforces this on `createGraphEdge`.
Any supersession G3 detects must be backed by an explicit edge with this constraint.

### SEMANTIC_SCOPE (graphStore.js)

```
INTERACTION | DOCUMENT | CLIENT | ROLE | WORKFLOW | COMPANY | HISTORICAL
```

### RESOLUTION_STATE (graphStore.js)

```
RESOLVED | AMBIGUOUS | UNRESOLVED | CONFLICTED
```

### `effectiveTime` (real structure)

`effectiveTime: { from: ISODate | null, to: ISODate | null }` — present on graph nodes and
frontmatter-sourced claims. Null fields mean "not stated in evidence" (UNKNOWN temporal state).
Source ingestion timestamps are NOT a substitute for explicit effective dates.

---

## G3 Typed Model

G3 classifies G2 evidence into these shapes. These are G3-layer types, not G2 API types.

### PolicyCandidate (G3 classification of a G2 graph node or claim)

```ts
interface PolicyCandidate {
  graphNodeKey: string             // POLICY_CANDIDATE or CLIENT_EXCEPTION node stableKey
  claimId: string                  // underlying G2 claim id
  claimClass: CLAIM_CLASS          // from G2 claim
  topic: string                    // claim.claimType (e.g. 'late_fee_policy')
  value: unknown                   // claim.value
  scopeLevel: SEMANTIC_SCOPE       // from G2 semanticScope.level
  clientId: string | null          // from G2 semanticScope.clientId
  temporalState: TemporalState     // derived by G3 from effectiveTime + temporality
  effectiveTime: { from: string | null, to: string | null } | null
  provenance: {
    rootSourceVersionIds: string[]
    independent: boolean
    independentRootCount: number
  }
  candidateStatus: 'ACTIVE' | 'SUPERSEDED' | 'REVOKED' | 'HISTORICAL'
  confidence: number | null        // from G2 claim; never used to resolve conflict (R1)
  explicit: boolean
}
```

### TemporalState (G3 classification)

```
CURRENT   — effectiveFrom <= queryDate AND (effectiveTo null OR effectiveTo > queryDate)
FUTURE    — effectiveFrom > queryDate
HISTORICAL — temporality = 'HISTORICAL' OR claim class is HISTORICAL_PRECEDENT
EXPIRED   — effectiveTo <= queryDate
UNKNOWN   — effectiveFrom null and no other signal; null dates do NOT mean "now" or "forever"
```

For the Acme/Atlas baseline:
- 5% SOP (g1-realistic): effectiveTime null → **UNKNOWN**
- Atlas 2% client exception (g1-realistic): effectiveTime null → **UNKNOWN**
- Founder "stopped fees" instruction (g1-realistic): effectiveTime null → **UNKNOWN**
- Historical 10% policy (old-ar-rules.csv via fixtureIngestion): HISTORICAL_PRECEDENT class → **HISTORICAL**
- Historical 10% policy (g2-graph/historical-late-fee-policy.md): `scope: HISTORICAL`, `effective_to: 2023-12-31` → **HISTORICAL** (EXPIRED by date)

### ConflictClass (G3 classification)

```ts
type ConflictClass =
  | 'SAME_SCOPE_INCOMPATIBLE_VALUES'       // two COMPANY-scope late-fee policies with different rates
  | 'COMPANY_VS_CLIENT_EXCEPTION'          // company policy + client exception in scope overlap
  | 'CONTRACT_VS_COMPANY_POLICY'           // contract term contradicts approved company policy
  | 'FOUNDER_INSTRUCTION_VS_PRIOR_POLICY'  // founder instruction contradicts standing company policy
  | 'CURRENT_VS_HISTORICAL'               // current candidate contradicts HISTORICAL candidate
  | 'OVERLAPPING_EFFECTIVE_PERIODS'        // two candidates with overlapping effectiveTime windows
  | 'AMBIGUOUS_ENTITY_IDENTITY'            // entity referenced ambiguously (RESOLUTION_STATE.AMBIGUOUS)
  | 'MISSING_PRECEDENCE'                   // two candidates, neither has documented precedence
  | 'SCOPE_ESCALATION'                     // a CLIENT-scoped policy referenced as COMPANY answer
  | 'CONFIDENCE_DISAGREEMENT'              // candidates differ only in confidence score
  | 'DANGLING_PROVENANCE'                  // claim references missing or revoked provenance root
  | 'DUPLICATE_EVIDENCE'                   // same claim content via multiple evidence paths
```

---

## G3 Interfaces Required from G2 (Verification Checklist)

These items are CONFIRMED present in the frozen G2 checkpoint (`5d0dc3b`):

| Interface | G2 status | Notes |
|-----------|-----------|-------|
| `semanticScope.level` (SEMANTIC_SCOPE enum) | ✓ confirmed | Used in all graph nodes/edges |
| `effectiveTime: { from, to }` | ✓ confirmed | On frontmatter claims and graph nodes |
| `CONTRACT` node type | ✓ confirmed | `GRAPH_NODE_TYPE.CONTRACT` |
| `HAS_CONTRACT` edge type | ✓ confirmed | `GRAPH_EDGE_TYPE.HAS_CONTRACT` |
| `SUPERSEDES` edge type (explicit-only) | ✓ confirmed | `createGraphEdge` enforces `explicit: true` |
| Deterministic entity resolution | ✓ confirmed | `resolve()` + `resolveClientAlias()` |
| `HISTORICAL_PRECEDENT` claim class | ✓ confirmed | Via `old-ar-rules.csv` fixture + `historical-late-fee-policy.md` |
| `HISTORICAL_TO` edge type | ✓ confirmed | Used for `scope: HISTORICAL` policy candidates |
| `RESOLUTION_STATE.AMBIGUOUS` | ✓ confirmed | e.g. "Acme" ambiguous between acme-us and acme-eu |
| `RESOLUTION_STATE.UNRESOLVED` | ✓ confirmed | e.g. "Northwind West" not in entity registry |
| `canonicalMoneyWritable: false` structural | ✓ confirmed | On all G2 snapshots |
| `policyPrecedenceResolved: false` structural | ✓ confirmed | On all G2 graph snapshots |

---

## G3 Exit Gate

G3 is complete when:

1. All adversarial scenarios in `M2G_G3_ADVERSARIAL_PLAN.md` have passing tests against real G2 APIs.
2. No G3 path resolves a CONFLICTED policy by confidence, recency, or behavioral frequency.
3. R0–R9 invariants each have at least one dedicated regression test.
4. `canonicalMoneyWritable: false` is structurally enforced on every G3 output path.
5. `authorityBoundary.canActAutomatically` is `false` whenever any relevant conflict is unresolved.
6. G3 temporal classification correctly handles null effective dates as UNKNOWN (not CURRENT).
7. CLIENT-scoped rules never appear in COMPANY-scope G3 resolution results (R4).
