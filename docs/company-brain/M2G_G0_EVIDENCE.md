# M2G-G0 evidence

## Proven loop

The deterministic acceptance test executes:

`fixture files → sources/artifacts → typed claims → root provenance → semantic scope → conflict → roles/delegation → operating-model proposal → authority proposal → explicit founder decision → changed snapshot → Ask DW answers → typed DW Intelligence context → root revocation → invalidated knowledge`

At both ends, `canonicalMoneyWritable=false`; attempts to create or mutate R0 money truth throw.

## Evidence map

| G0 requirement | Implementation evidence | Test evidence |
|---|---|---|
| Tenant/source/artifact/claim model | `src/lib/companyBrain/index.js` | cross-tenant, source-less, unknown-root, active-root tests |
| Controlled deterministic ingestion | `fixtureIngestion.js`; `fixtures/company-brain/acme-ar-ops/` | fixture completeness, stable hash, classification tests |
| Claim classes/scopes | frozen `CLAIM_CLASS`; 15 fixture claims | class, scope, contextual-payment assertions |
| Conflict preservation | `detectConflicts`, `buildBrainSnapshot` | confidence cannot resolve; historical/current/client/founder candidates retained |
| Structured operating proposal | `buildOperatingModel` | category separation before/after decision |
| Founder decision | `createFounderDecision` | explicit scoped snapshot update; conflict remains inspectable |
| Authority proposal/decision | proposal constructors and evaluator | proposal ≠ approval; exact-scope grant; revocation |
| Anti-escalation | approval history is advisory only | 20 approvals still require approval on next case |
| Revocation/tombstone | `revokeRootSource`, snapshot invalidation | root and derived summary excluded; audit lineage retained |
| Ask DW grounding | `answerAskDwFromCompanyBrain` | four required questions |
| DW Intelligence grounding | `toDwIntelligenceCompanyContext` | typed fields, provenance, revocation, authority/money boundaries |
| R0 immutability | claim/mutation guards | canonical claim/write rejection and full-loop assertion |

## Validation commands

```text
npm run test:company-brain-g0
npm test
npm run build
git diff --check
```

Final counts and results are captured in `M2G_G0_VALIDATION.txt`.

## Known unknowns

- Production persistence tables, RLS policies, authenticated founder-decision writes, and concurrency semantics are not selected in G0.
- Root identity/versioning for live Drive, CRM, email, or other providers awaits M2H.
- No nondeterministic extraction, OCR, embeddings, retrieval ranking, or model-evaluation quality claim is made.
- Contract legal applicability is represented as missing context, not decided by the kernel.
- Decision supersession across multiple founders/roles and organizational authorization policy needs a later gate.
- Retention, legal hold, export, privacy deletion, and source-access-loss operations need production design.
- The typed seams are proven directly; wiring them into hosted Ask DW/DW Intelligence data loaders awaits a persistence/authentication gate.

## Must wait

### M2G-G1

- production-grade persistence contract and authenticated decision service;
- richer conflict/source-precedence policy and decision supersession;
- controlled retrieval/indexing and version lifecycle;
- UI only after the kernel contract remains stable.

### M2H

- live Drive/CRM/email/accounting/payment integrations;
- provider backfill, webhook, refresh, deletion, and permission-loss behavior;
- production financial/provider truth joins.

## R0 amendment assessment

No frozen R0 or existing DW Intelligence contract needs amendment. G0 consumes the R0 ownership/provenance doctrine and leaves canonical financial truth untouched. The Company Brain typed context is additive and non-authoritative.
