# M2G G3 — Adversarial Test Plan

**Status:** Implemented — all scenarios below have passing tests in `companyBrainG3Policy.test.mjs`.
**Branch:** `m2g/company-brain-bootstrap-g3`
**Date:** 2026-08-31

---

## Fixture Baseline (Acme/Atlas Scenario)

Two fixture sets are available for G3 tests. Both are confirmed working against the frozen G2 checkpoint.

### Fixture Set A — acme-ar-ops (via `fixtureIngestion.js`)

Use `ingestCompanyBrainFixture({ fixtureDirectory, tenantId })` to load:

| Source file | Claim class | Claim type | Value | Scope |
|-------------|-------------|-----------|-------|-------|
| `collections-sop.md` | `COMPANY_POLICY` | `late_fee_policy` | `{ ratePercent: 5 }` | COMPANY |
| `customer-contract-atlas.md` | `CLIENT_EXCEPTION` | `late_fee_policy` | `{ ratePercent: 2 }` | CLIENT (atlas) |
| `old-ar-rules.csv` | `HISTORICAL_PRECEDENT` | `late_fee_policy` | `{ ratePercent: 10 }` | COMPANY, temporality: HISTORICAL |
| `founder-note.md` | `FOUNDER_INSTRUCTION` | `late_fee_policy` | `{ enabled: false }` | COMPANY |
| `roles.md` | `ROLE`, `DELEGATION` | various | — | COMPANY |
| `atlas-history.md` | `HISTORICAL_PRECEDENT` | `payment_behavior_context` | — | CLIENT (atlas) |
| `account-manager-email.md` | `INTERPRETATION` | `settlement_discount_statement` | `{ discountPercent: 20 }` | CLIENT (atlas) |
| `payment-claim.md` | `INTERPRETATION` | `contextual_payment_statement` | — | INVOICE_CONTEXT |

**Conflicts produced:** `detectConflicts` fires on `late_fee_policy` for claims from `collections-sop.md`,
`customer-contract-atlas.md`, and `founder-note.md` (3 competing COMPANY+CLIENT active claims).

### Fixture Set B — g1-realistic (via `CompanyBrainDurableStore.ingestLocalFile`)

| Source file | Claim class | Claim type | Value | Scope |
|-------------|-------------|-----------|-------|-------|
| `collections-policy.md` | `COMPANY_POLICY` | `late_fee_policy` | `{ ratePercent: 5 }` | COMPANY |
| `atlas-terms.csv` | `CLIENT_EXCEPTION` | `late_fee_policy` | `{ ratePercent: 2 }` | CLIENT (atlas) |
| `founder-instruction.txt` | `FOUNDER_INSTRUCTION` | `late_fee_policy` | `{ enabled: false }` | COMPANY |

### Fixture Set C — g2-graph (via `CompanyBrainDurableStore.ingestLocalFile`)

Carries entity registry, contract records, client exception with contract reference,
historical late-fee policy (10%, 2022–2023, HISTORICAL scope), people/roles CSV,
atlas precedent, orphan Northwind reference, historical aliases CSV,
Acme-US contract, Acme account-manager interaction note, and collections workflow.

**Historical 10% policy is confirmed present** via `historical-late-fee-policy.md`:
- `document_type: policy_candidate`; `scope: HISTORICAL`; `effective_from: 2022-01-01`; `effective_to: 2023-12-31`
- Produces `COMPANY_POLICY` / `policy_candidate_record` with `temporality: 'HISTORICAL'`, `effectiveTime: { from: '2022-01-01', to: '2023-12-31' }`

### Synthetic content helpers (for scenarios not covered by fixture files)

Use `ingestContent` with strings triggering the real extraction patterns:

```js
// COMPANY_POLICY late_fee_policy:
content: 'Charge a 7% late fee.'

// CLIENT_EXCEPTION late_fee_policy (CSV):
content: 'client,payment_terms_days,late_fee_percent\natlas,45,3'

// FOUNDER_INSTRUCTION late_fee_policy:
content: 'We stopped charging late fees until I approve a new policy.'

// INTERPRETATION settlement_discount_statement:
content: 'Sure, give Atlas 20% off.'

// INTERPRETATION contextual_payment_statement (R0 route):
content: 'Invoice 104 was paid yesterday.'

// Frontmatter contract (effectiveTime carried):
content: '---\ndocument_type: contract\ncontract_id: contract-X\nclient_id: atlas\nscope: CLIENT\neffective_from: 2026-01-01\n---\n# Contract body'

// Frontmatter policy_candidate with effective_to (HISTORICAL):
content: '---\ndocument_type: policy_candidate\npolicy_id: policy-old\nscope: HISTORICAL\neffective_from: 2022-01-01\neffective_to: 2023-12-31\n---\n# Old policy'

// Frontmatter client_exception with contract reference:
content: '---\ndocument_type: client_exception\nexception_id: exception-X\nclient_id: atlas\ncontract_id: contract-X\nscope: CLIENT\n---\n# Exception body'
```

---

## Adversarial Scenarios

### Group A — Conflicting same-scope policies

**A1. Same-scope, same-topic, incompatible values (COMPANY_POLICY, no resolution)**
Two COMPANY-scope late-fee policies with different rates. G2's `detectConflicts` fires.
Expected: conflict has `status = 'CONFLICTED'`, `competingClaimIds` contains both;
`winnerClaimId: null`, `confidenceResolved: false`.

**A2. Founder decision resolves conflict; provenance is explicit**
Founder records a decision resolving the conflict. G2's `recordFounderDecision` succeeds.
Expected: conflict `status = 'RESOLVED'`, `resolutionDecisionId` set; `buildBrainSnapshot` produces
`approvedPolicies`; `answerAskDwFromCompanyBrain` returns `APPROVED` (not `CONFLICTED`).

**A3. Newer ingestion timestamp without supersession → still CONFLICTED (R5)**
Source B ingested after Source A (different `createdAt`). B makes no supersession claim.
Expected: `detectConflicts` still fires; conflict remains `CONFLICTED`; G3 must not resolve by
ingestion order. `policyPrecedenceResolved: false` on the graph snapshot.

**A4. Confidence stored but not used to resolve (R1)**
Two candidates with `confidence: 0.9` vs `confidence: 0.7`.
Expected: `detectConflicts` produces conflict; `confidenceResolved: false`; `winnerClaimId: null`;
higher-confidence claim does NOT win.

---

### Group B — Client exception vs company policy

**B1. CLIENT_EXCEPTION correctly scoped — does not appear for COMPANY-scope queries (R4)**
`getPoliciesApplicable` with `scope: { level: SEMANTIC_SCOPE.COMPANY }` must not include the
CLIENT_EXCEPTION node. `getPoliciesApplicable` with `scope: { level: SEMANTIC_SCOPE.CLIENT, clientId: 'atlas' }`
returns it via `EXCEPTION_FOR` edge. R4 is structurally enforced in the graph.

**B2. CLIENT_EXCEPTION node has EXCEPTION_FOR edge to client, not APPLIES_TO_COMPANY**
Graph snapshot must have no `APPLIES_TO_COMPANY` edge originating from a CLIENT_EXCEPTION node.

**B3. Two client exceptions for the same client, incompatible → conflict**
Two `CLIENT_EXCEPTION` / `late_fee_policy` claims for Atlas with different rates.
Expected: `detectConflicts` fires (both are `late_fee_policy`); conflict includes both claim IDs.

**B4. Revoking the contract source removes the client exception from the graph**
Atlas contract source is revoked. Expected: subsequent `graph.build()` excludes the
`CLIENT_EXCEPTION` node that was derived from that source (EXCEPTION_FOR edge gone);
`graph.getContractsForClient({ clientId: 'atlas' })` returns empty.

---

### Group C — Effective dates and temporal state

**C1. Null effective dates → UNKNOWN; never treated as CURRENT (R5)**
The g1-realistic and acme-ar-ops fixtures have `effectiveTime: null` for most claims.
Expected: G2 graph nodes carry `effectiveTime: null`; G3 must classify these as UNKNOWN
(neither CURRENT nor EXPIRED by default); `policyPrecedenceResolved: false`.

**C2. Frontmatter doc with `effective_from` → carries structured `effectiveTime`**
Ingesting a frontmatter document with `effective_from: 2026-01-01` produces `effectiveTime: { from: '2026-01-01', to: null }`.
Expected: G2 claim and graph node carry the structured date.
G3 classification: CURRENT if `queryDate >= 2026-01-01` and `effectiveTo` null.

**C3. Frontmatter doc with `effective_to` in the past → EXPIRED temporal state**
`historical-late-fee-policy.md` has `effective_to: 2023-12-31`.
Expected: G2 claim carries `effectiveTime: { from: '2022-01-01', to: '2023-12-31' }`;
graph snapshot produces `HISTORICAL_TO` edge (not `APPLIES_TO_COMPANY`).
G3 classification: EXPIRED for queries against any date > 2023-12-31. Must not appear
in active applicability for 2026 queries.

---

### Group D — Overlapping and future effective periods

**D1. Two policies with overlapping effective periods → G3 must surface conflict**
Policy A: `effective_from: 2024-01-01` (no `to`). Policy B: `effective_from: 2025-01-01` (no `to`).
Expected: G3 detects overlapping CURRENT windows; neither can be ruled out;
`canActAutomatically: false`.

**D2. Future contract not yet in effect**
A frontmatter contract with `effective_from` three months from query date.
Expected: G2 carries `effectiveTime.from` in the future; G3 must classify as FUTURE;
excluded from current-query applicability; available for planning queries.

**D3. Historical precedent from the graph (g2-graph fixture)**
`atlas-precedent.md` has `scope: HISTORICAL`, `effective_to: 2025-12-31`.
Expected: `PRECEDENT` node with `HISTORICAL_TO` edge (or `PRECEDENT_FOR` to Atlas client);
G3 must not treat it as current; available for retrospective analysis.

---

### Group E — Revoked source

**E1. Revoking a source deactivates its claims and tombstones the source**
A source is ingested, then `revokeSource` is called.
Expected: `source.active = false`, tombstone pushed; all claims from that source
have `active = false`; `rebuildConflicts` removes revoked claims from conflict membership;
`prepareSnapshot` excludes the revoked source version and its claims.

**E2. Revoking the Atlas exception source — exception vanishes from graph (R6)**
After revoking the atlas-exception source, `graph.build()` must produce no `CLIENT_EXCEPTION` node
for the atlas exception and no `EXCEPTION_FOR` edge to Atlas.

**E3. Revoking the founder instruction source — founder claim excluded**
After revoking the founder-note/founder-instruction source, the `FOUNDER_INSTRUCTION` claim
is inactive; conflict re-evaluated without it. Ask DW may still return CONFLICTED if other
competing claims remain.

---

### Group F — Historical evidence and entity identity

**F1. HISTORICAL_PRECEDENT stays historical; never silently becomes current (R5)**
The `old-ar-rules.csv` (fixtureIngestion) produces `HISTORICAL_PRECEDENT` / `late_fee_policy` at
`temporality: 'HISTORICAL'`. The g2-graph `historical-late-fee-policy.md` produces a HISTORICAL
policy candidate with `HISTORICAL_TO` edge.
Expected: neither appears in company-scope current applicability;
no `APPLIES_TO_COMPANY` edge; graph snapshot has `HISTORICAL_TO` edge.

**F2. Ambiguous entity identity → AMBIGUOUS resolution state**
"Acme" is ambiguous between `acme-us` and `acme-eu` in the entity registry.
Expected: `resolveClientAlias({ alias: 'Acme' }).state = RESOLUTION_STATE.AMBIGUOUS`;
`selectedKey = null`; graph Ask DW surfaces ambiguity.

**F3. Orphan reference stays UNRESOLVED**
"Northwind West" appears in `orphan-reference.md` but not in the entity registry.
Expected: `getUnresolvedRelationships` includes a row with `reference: 'Northwind West'`
and `state = RESOLUTION_STATE.UNRESOLVED`.

---

### Group G — Communication and behavioral evidence

**G1. Account-manager email → INTERPRETATION, not policy authority (R2)**
`account-manager-email.md` (fixtureIngestion) or `give Atlas 20% off` content produces
`INTERPRETATION` / `settlement_discount_statement` with `uncertainty: 'COMMUNICATION_NOT_AUTHORITY'`.
Expected: claim class is `INTERPRETATION`; not `COMPANY_POLICY` or `CLIENT_EXCEPTION`;
does NOT trigger `detectConflicts` on `late_fee_policy`.
Ask DW: `REQUIRE_APPROVAL`, not `APPROVED`.

**G2. Repeated approvals do not become standing authority (R3)**
`evaluateAuthority` with 20+ entries in `approvalHistory` for the same `actionClass`.
Expected: result is `REQUIRE_APPROVAL` (never `GRANTED`); `suggestion` populated;
`repeatedApprovalCount >= 20`; no standing authority granted.

**G3. Explicit authority grant → GRANTED**
An authority proposal is persisted and `decideAuthority` approves it.
Expected: subsequent `evaluateAuthority` returns `GRANTED`, `grantId` set.

---

### Group H — Provenance integrity

**H1. Payment claim → INTERPRETATION + R0 refetch required**
`payment-claim.md` (fixtureIngestion) or `"Invoice 104 was paid yesterday"` content produces
`INTERPRETATION` / `contextual_payment_statement` with `confidence: 0.2`,
`uncertainty: 'UNTRUSTED_CONTEXT_ONLY'`.
Expected: claim class is `INTERPRETATION`; `assertCompanyBrainCannotWriteCanonicalMoney` throws for
financial-mutation objects; Ask DW returns `AUTHORITATIVE_FINANCIAL_REFETCH_REQUIRED`.

**H2. Duplicate content hash → `duplicateContent: true`, no spurious conflict**
Ingesting the same content a second time (different idempotency key).
Expected: `ingestContent` returns `{ duplicateContent: true, createdClaimIds: [] }`;
no new claim rows; conflict count unchanged.

**H3. Dangling provenance → `prepareSnapshot` throws**
A claim inserted with a `provenanceRootIds` entry pointing to a non-existent source version.
Expected: `prepareSnapshot` throws `/root provenance unknown/` (Gap 4 regression, G1 hardening).

---

### Group I — Cross-tenant isolation

**I1. Cross-tenant graph reads blocked**
Actor from tenantB cannot read tenantA entities.
Expected: `graph.getEntity({ actor: founderB, tenantId: tenantA, ... })` throws `/tenant mismatch/`.

**I2. Cross-tenant graph provenance rejected**
A graph node built with claim IDs from tenantB (different tenant's source versions).
Expected: `graph.persistNode` or `graph.build` throws `/dangling or cross-tenant/`.

---

### Group J — Scope and entity edge cases

**J1. COMPANY-scope query excludes CLIENT-scope nodes (R4)**
`getPoliciesApplicable({ scope: { level: SEMANTIC_SCOPE.COMPANY } })` must return only POLICY_CANDIDATE
nodes with `APPLIES_TO_COMPANY` edges; no CLIENT_EXCEPTION nodes.

**J2. Stale graph snapshot after source ingestion → rebuilt automatically**
After `ingestContent` bumps `knowledgeVersion`, `activeSnapshot` returns null.
`requireSnapshot` rebuilds. Expected: `activeSnapshot` returns the fresh snapshot;
old snapshot is preserved as an archived graph version.

**J3. SUPERSEDES edge requires explicit=true**
Attempting to create a `SUPERSEDES` graph edge with `explicit: false` is rejected.
Expected: `createGraphEdge` throws for a SUPERSEDES edge without `explicit: true`.
G3 cannot infer supersession from ingestion order — only an explicit SUPERSEDES edge counts.

---

### Group K — R0/Invariant regression

**K1. R0 — `canonicalMoneyWritable: false` on every G2 output surface**
Both `buildBrainSnapshot` output and `CompanyGraphStore.build()` snapshot must have
`canonicalMoneyWritable: false`. `assertCompanyBrainCannotWriteCanonicalMoney` must throw for
invoice/payment mutation objects.

**K2. R1 — confidence does not resolve conflict**
Two competing claims differing in confidence score. Expected: `winnerClaimId: null`;
`confidenceResolved: false`; neither wins.

**K3. R4 — CLIENT scope never widens to COMPANY in graph queries**
`getPoliciesApplicable` with COMPANY scope never returns a CLIENT_EXCEPTION node.
No `APPLIES_TO_COMPANY` edge from any `CLIENT_EXCEPTION` node in any snapshot.

**K4. R6 — revoked claim rejected as founder decision evidence**
After a source is revoked, its claims are inactive. Attempting to use a revoked claim ID
in `recordFounderDecision.evidenceClaimIds` must throw
`'founder decision provenance unknown or inactive'`.

**K5. R8 — unresolved conflict has no winner**
An unresolved `CONFLICTED` conflict must have `winnerClaimId: null` and `confidenceResolved: false`.
G3 must not select a winner by any means other than an explicit `recordFounderDecision`.

---

## Expected G3 Behaviors — Ask DW Questions

| Question | Expected behavior |
|----------|-------------------|
| `"What is the late-fee policy?"` | `CONFLICTED` until a founder decision resolves it |
| `"Does the Atlas 2% apply to every client?"` | `SCOPED` — no widening (R4) |
| `"Who can approve settlements?"` | `OBSERVED_NOT_AUTHORITY` — delegation observed, not granted |
| `"Why does this rule apply to Atlas?"` | `RESOLVED` (with provenance path) or `UNRESOLVED` after exception revoked |
| `"Who is Acme?"` | `AMBIGUOUS` — two candidate entities |
| `"Which contract applies to Atlas?"` | `RESOLVED` when atlas-contract is present |
| `"Can the account manager waive Atlas's fee?"` | `REQUIRE_APPROVAL` |
| `"Invoice 104 was paid yesterday — is it paid?"` | `AUTHORITATIVE_FINANCIAL_REFETCH_REQUIRED` (R0) |

---

## Exit Gate for Adversarial Coverage

All scenarios above must have test cases in `companyBrainG3Policy.test.mjs`. A scenario is not
coverage until the test:

1. Sets up the specific evidence configuration using real G2 APIs.
2. Calls the relevant G2 method or asserts the G3 classification it will use.
3. Asserts the specific expected conflict state, resolution status, and key context fields.
4. Asserts the specific invariant (R0–R9) that the scenario is regressing.
5. Uses `test.todo()` only for behaviors requiring G3 runtime logic not yet implemented.
   Never uses `assert.ok(true)` or similar fake passes.
