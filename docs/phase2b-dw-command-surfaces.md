# Phase 2B — DW Command Surfaces

Status: local proof/UI contract only. Not deployed.

## Locked separation

- `● LIVE` — what DW is doing right now.
- `What's Done` — completed/investigated/escalated/watched/withheld DW work with proof.
- `Needs You` — founder judgment queue.
- `Autopilot` — what DW is allowed to do.
- `DW Check` — later inspection of plan vs execution and system integrity.

## What's Done

`projectWhatsDoneReadModel()` excludes any run whose persisted status is still `running`.
This prevents in-progress LIVE work from being represented as completed work.

The journal keeps intentionally withheld work visible. A blocked workflow is rendered as `WITHHELD`, not silently omitted.

Each entry carries proof integrity, authority, evidence counts, and real-side-effect truth.

## Needs You

`projectNeedsYouCommandReadModel()` includes only cases for which the proven case model says founder judgment is required.

Every queue item is structurally review-only:

- `directlyExecutable = false`
- `browserMayGrantAuthority = false`
- `boundary = REQUEST_BACKEND_REVALIDATION`

The browser may open the invoice case. A future founder Yes/No/Change action must still re-establish current state and authority at the existing server execution boundary.

## UI rule

The existing `SignatureSection` remains the existing Autopilot approval workflow. Increment 6 does not reuse it as the new DW Intelligence command queue because that component owns execution-capable approval behavior.

DW's `Needs You` queue is a separate read-only inspection/command surface until a later, explicitly proved server command path exists.

## Activity

The existing generic Activity Log remains intact. Increment 6 adds a DW-specific `What's Done` journal above it when a real `dwIntelligence.whatsDone` read model exists.

Production DataContext still fabricates nothing. With no DW read model, no new DW journal/queue renders.
