# M2G G3 — Temporal Applicability

**Status:** Implemented — `classifyTemporalState` in `src/lib/companyBrain/policyIntelligence.js`
**Branch:** `m2g/company-brain-bootstrap-g3`
**Date:** 2026-08-31

---

## Core Principle

Null effective dates mean **"not stated in evidence"**, never **"now"** or **"forever"**.
Source ingestion timestamps are **not** a substitute for explicit `effective_from`/`effective_to` dates.

---

## TemporalState Values

| State | Trigger |
|-------|---------|
| `HISTORICAL` | `claimClass === CLAIM_CLASS.HISTORICAL_PRECEDENT` (always, regardless of dates) |
| `HISTORICAL` | `temporality === 'HISTORICAL'` (from semanticScope or frontmatter `scope: HISTORICAL`) |
| `UNKNOWN` | `effectiveTime` is null, or `{ from: null, to: null }` |
| `EXPIRED` | `effectiveTime.to` is set and `to <= queryDate` |
| `FUTURE` | `effectiveTime.from` is set and `from > queryDate` |
| `CURRENT` | `effectiveTime.from <= queryDate` AND (`to` is null OR `to > queryDate`) |
| `UNKNOWN` | `effectiveTime.from` is null but `to` is set and `to > queryDate` (start not stated) |

---

## Classification Priority

The rules are checked in this exact order (first match wins):

1. HISTORICAL_PRECEDENT claim class → `HISTORICAL`
2. `temporality === 'HISTORICAL'` → `HISTORICAL`
3. `effectiveTime == null` → `UNKNOWN`
4. `{ from: null, to: null }` → `UNKNOWN`
5. `to <= queryDate` → `EXPIRED`
6. `from > queryDate` → `FUTURE`
7. `from <= queryDate` → `CURRENT`
8. Fallback → `UNKNOWN`

---

## Treatment of UNKNOWN, HISTORICAL, EXPIRED, FUTURE in Resolution (R5)

| State | Included in "active" resolution set? |
|-------|--------------------------------------|
| `CURRENT` | Yes |
| `UNKNOWN` | Yes — but surfaces as `hasUnknownTemporal: true`; blocks `authorityBoundary.canActAutomatically` |
| `HISTORICAL` | `candidateStatus = HISTORICAL` → excluded from active resolution |
| `EXPIRED` | `candidateStatus = HISTORICAL` → excluded from active resolution |
| `FUTURE` | Excluded from pairwise conflict classification and from the "active" set in `resolvePolicy` |

UNKNOWN is **not** silently promoted to CURRENT. It surfaces through `hasUnknownTemporal` and through
the `OVERLAPPING_EFFECTIVE_PERIODS` conflict class so that ambiguity is visible to the founder.

---

## Baseline Temporal States for the Acme/Atlas Fixture

| Evidence | Source file | TemporalState |
|----------|-------------|---------------|
| 5% SOP | g1-realistic/collections-policy.md | `UNKNOWN` (effectiveTime null) |
| Atlas 2% exception | g1-realistic/atlas-terms.csv | `UNKNOWN` (effectiveTime null) |
| Founder "stopped fees" | g1-realistic/founder-instruction.txt | `UNKNOWN` (effectiveTime null) |
| Historical 10% policy | g2-graph/historical-late-fee-policy.md | `HISTORICAL` (scope: HISTORICAL + effective_to: 2023-12-31 → also EXPIRED) |
| Historical rule from fixture | acme-ar-ops/old-ar-rules.csv | `HISTORICAL` (HISTORICAL_PRECEDENT claim class) |
