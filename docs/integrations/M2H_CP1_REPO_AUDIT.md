# M2H-CP1 — repository audit (read-only, performed before any code)

Base: `236a9dee0c5a4a6bb417db466e562ae3e3c4f950` (G8 freeze candidate).

## What already existed

| Existing primitive | Verdict | Reason |
|---|---|---|
| `MONEY_TRUTH_CLASSES` (`src/lib/companyBrain/index.js`) — the six canonical money-truth classes | **REUSE** | These are exactly T1–T6. `providerTruthModel.js` uses the same six strings and the suite proves identity *behaviourally*: the Company Brain must still refuse `createClaim` for each one. |
| `createSource` / `createArtifact` / `createClaim` (G1) | **REUSE (later)** | Company Brain ingestion of provider sources/artifacts/claims belongs to CP7, not CP1. No parallel ingestion model was created. |
| `assertCompanyBrainCannotWriteCanonicalMoney` | **REUSE** | Asserted directly in the M2H hostile suite (H24). M2H adds the mirrored `assertProviderCannotWriteCanonicalMoney`. |
| `detectConflicts` (G3/G4 conflict + precedence model) | **REUSE (later)** | CP1 only needs to *classify* whether a disagreement exists at all. Resolution stays with the existing conflict/precedence machinery. |
| G5 authority + delegation | **REUSE, reference only** | No G8/M2H module interprets grant status. Capability records name `authorityOwner: 'G5'` and refuse to store a verdict. |
| G8 governance / attention / grounding / execution presentation | **REUSE, frozen** | Untouched. H25 asserts the receipt source-provenance contract still stands. |
| `EVIDENCE_STATUS` (`phase2bEngine.js`) | **KEEP SEPARATE** | Different concept: it is *admission status of evidence into the engine* (ADMITTED / CONTEXT_ONLY / QUARANTINED…), not *how we came to believe something about a provider*. Merging them would overload one word. Documented so nobody "unifies" them later. |
| `src/lib/importPersistence/eligibility.js` | **REJECT for reuse** | Despite the name it is **CSV import** eligibility (row-level import blocking), a different domain from collection eligibility. Reusing it would couple invoice ingestion to collections. New `COLLECTION_ELIGIBILITY` vocabulary created deliberately, and the name collision is recorded here. |
| Seeded-PRNG fixture pattern (`tests/dwG8Fixtures.mjs`) | **REUSE** | Same mulberry32 approach and the same "print the seed" discipline. |
| `tests/importPersistence/` nested test directory | **REUSE (convention)** | Confirms nested test dirs are discovered by root `node --test`; `tests/providerLab/` follows it. |
| Docs convention `M2G_G<n>_REPO_AUDIT / _EVIDENCE / _VALIDATION` | **REUSE** | `docs/integrations/M2H_CP1_*` mirrors it. |

## What did NOT exist (created by CP1)

No integration or provider directory existed at all. Absent, and therefore created:
claim-level source ownership, evidence classes E0–E8, generalization levels G0–G5,
architecture decision status, contradiction markers, freshness states, invalidation →
refetch scope, the provider capability registry, the observation/interpretation split,
the provider claim contract, and derived collection eligibility.

## Persistence

**None added.** No migration, no schema, no table. The whole kernel is pure and local,
per the CP1 persistence policy: provider tables written before their lifecycle is
understood are the ones that get migrated three times. CP6 owns the lifecycle.
