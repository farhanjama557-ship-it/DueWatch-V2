# M2G G3 — Temporal Applicability

**Status:** Architecture draft — preparation phase only.
**Branch:** `claude/duewatch-scaffold-auth-j2ef7c`
**Date:** 2026-08-31

---

## Principle

Effective dates must not be inferred when absent. A missing `effectiveFrom` does **not** mean "from the beginning of time" or "from now." A missing `effectiveTo` does **not** mean "forever." Both mean `UNKNOWN`.

Historical rules must not silently become current (R5). A rule's temporal state must be derived from explicit evidence, not from the absence of a conflicting rule.

---

## Temporal State Taxonomy

```ts
type TemporalState =
  | 'CURRENT'      // explicitly evidenced as in effect at the time of query
  | 'FUTURE'       // explicitly evidenced as not yet in effect
  | 'HISTORICAL'   // explicitly evidenced as no longer current
  | 'EXPIRED'      // explicitly evidenced as past its stated end date
  | 'UNKNOWN'      // insufficient evidence to determine temporal state
```

### Decision rules for each state

**CURRENT:**  
`effectiveFrom` is set AND `effectiveFrom <= queryDate` AND (`effectiveTo` is null OR `effectiveTo > queryDate`).  
Or: an explicit founder decision or approved policy states the rule is "in effect" without an end date, and no subsequent revocation exists.

**FUTURE:**  
`effectiveFrom` is set AND `effectiveFrom > queryDate`.  
A rule cannot be CURRENT before its stated start date, regardless of confidence or source trust.

**HISTORICAL:**  
The source is explicitly marked as historical (via `claimClass: HISTORICAL_PRECEDENT`), or a tombstone/revocation record explicitly marks the rule as no longer current, or an explicit supersession record names this rule as superseded.

**EXPIRED:**  
`effectiveTo` is set AND `effectiveTo <= queryDate`.  
Distinct from HISTORICAL: EXPIRED means the end date was explicitly stated and has passed. HISTORICAL means the rule was ended but the end date may not be known.

**UNKNOWN:**  
Any of these conditions:
- `effectiveFrom` is absent and no other temporal signal exists.
- `effectiveTo` is absent and the rule has no explicit "still current" signal.
- The source's timestamp (ingestion, modification) does not reliably represent the rule's effective date.
- Two or more temporal signals conflict.

---

## What UNKNOWN Means for G3

A candidate with `temporalApplicability.state = 'UNKNOWN'` is **not** treated as CURRENT. It is treated as temporally unresolved.

Consequences:
- The candidate appears in `applicablePolicyCandidates` with its `temporalApplicability.state = 'UNKNOWN'`.
- If the candidate would otherwise resolve a conflict but its temporal state is UNKNOWN, the conflict remains `CONFLICTED`.
- The Ask DW answer must surface the UNKNOWN temporal state as a reason for abstention.
- DW Intelligence `authorityBoundary.canActAutomatically = false` when any relevant candidate has UNKNOWN temporal state and is the only potential resolver.

Example: The Atlas 2% term has no `effectiveFrom`/`effectiveTo` in the fixture (`atlas-terms.csv`). G3 temporal state: `UNKNOWN`. G3 may not assume it is current. A question about Atlas's current late fee must surface this uncertainty.

---

## Temporal Conflicts

Two candidates with overlapping effective periods and incompatible values produce a `OVERLAPPING_EFFECTIVE_PERIODS` conflict, regardless of precedence source type.

Conditions for overlap:
- Both candidates have `temporalApplicability.state` in `['CURRENT', 'UNKNOWN']` (UNKNOWN is treated as potentially overlapping).
- At least one of them has `effectiveTo = null` (open-ended or unknown end).
- Their `effectiveFrom` values do not definitively separate them (i.e., A's `effectiveTo < B's effectiveFrom` is not established).

When overlap cannot be ruled out, G3 must report the conflict.

---

## Temporal Hierarchy for the Acme/Atlas Scenario

```
Candidate C — founder-instruction.txt — "stopped charging late fees until approval"
  effectiveFrom: null (not stated)
  effectiveTo:   null (not stated — "until approval" is a condition, not a date)
  G3 temporal state: UNKNOWN (the start date of the moratorium is not in evidence)
  Interpretation: the instruction exists; when it was issued is unknown.

Candidate A — collections-policy.md — "5% late fee"
  effectiveFrom: null (not stated)
  effectiveTo:   null (not stated)
  G3 temporal state: UNKNOWN
  
Candidate B — atlas-terms.csv — "Atlas: 2% late fee"
  effectiveFrom: null (not stated — no contract date in fixture)
  effectiveTo:   null (not stated)
  G3 temporal state: UNKNOWN

Historical AR rule — "10% late fee"
  G1 claim class: HISTORICAL_PRECEDENT
  G3 temporal state: HISTORICAL (class-driven, not date-driven)
  Applies in: retrospective analysis only (R5)
```

All three active candidates (A, B, C) have `UNKNOWN` temporal state. G3 must not fabricate a temporal ordering between them. The company-wide question produces a multi-way `CONFLICTED` result with temporal uncertainty surfaced explicitly.

---

## Source Timestamps vs Effective Dates

G3 must distinguish:
- **Ingestion timestamp**: when DueWatch ingested the file — not a proxy for effective date.
- **Source modification timestamp**: when the file was last changed — not a proxy for effective date.
- **Stated effective date**: a date explicitly stated in the content of the source ("effective from 2025-01-01").
- **Contextual date signal**: a date inferred from surrounding context (e.g. an email's sent date) — must be explicitly marked as `inferredFrom: [claimId]` and cannot be treated as `explicit: true`.

If only an ingestion or modification timestamp is available, `effectiveFrom` must be set to `null` and `temporalApplicability.state = 'UNKNOWN'`. G3 must not silently use ingestion timestamps as effective-date proxies.

---

## Temporal Applicability in DW Intelligence Context

The `G3DwIntelligenceContext.temporalApplicability` array contains one `TemporalApplicability` entry per `PolicyCandidate` in `applicablePolicyCandidates`. This allows consumers to understand each candidate's temporal situation independently.

When `uncertainty.hasMissingEffectiveDates = true`, the DW Intelligence context must set `authorityBoundary.canActAutomatically = false` with `blockedBy` including the conflict IDs for all temporally unresolved candidates.

---

## Boundary: What G3 Will Never Do

- Treat `null` effective dates as "from the beginning" or "until now."
- Use ingestion timestamp as a proxy for effective-from.
- Resolve a temporal conflict by defaulting to the most-recently-ingested candidate.
- Assume a rule is still current because nothing explicitly revokes it (open-world assumption is rejected; closed-world assumption is rejected; UNKNOWN is the correct result).
- Assign a FUTURE rule to a CURRENT slot to fill a gap.
