# Phase 2B DW LIVE Feed Contract

`● LIVE` is evidence of persisted work transitions, not animation state.

Allowed vocabulary:

`ANALYZING → VERIFYING / PREPARING / WAITING / BLOCKED`

`VERIFYING → PREPARING / WAITING / BLOCKED`

`PREPARING → WAITING / HANDLED / BLOCKED`

`WAITING → ANALYZING / VERIFYING / PREPARING / HANDLED / BLOCKED`

`HANDLED` and `BLOCKED` are terminal for that run.

A run must begin with `ANALYZING`. Duplicate transitions are rejected. A terminal run cannot resume.

The Live Feed is read-only. A transition never grants authority, never creates execution permission, and never hides `real_side_effect=true` if malformed/imported evidence contains it.

`Join DW` is navigation metadata (`routeTarget`) only.

The same transition history is intended to become the evidence source for future Replay Shift and DW Check. Those future surfaces must consume persisted transitions rather than reconstructing theatrical activity from final case state.
