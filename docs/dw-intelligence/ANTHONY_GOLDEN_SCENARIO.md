# M1F — Anthony Golden Scenario v0

M1F is the executable acceptance scenario for the M1A–M1E System Brain / Ask DW work.

It does not add a second truth engine or a new execution path. It proves that the existing M1D case state and M1E case-aware runtime can hold a realistic multi-turn founder conversation without allowing conversation state to become financial truth or business authority.

## Golden conversation

The fixture exercises this sequence:

1. `What's going on with Anthony?`
   - resolver establishes the Anthony client reference
   - two invoice candidates are resolved
   - the first invoice becomes active
   - Ask DW performs a fresh invoice read

2. `What about the other invoice?`
   - the safe resolver emits an explicit invoice correction
   - invoice-derived artifact/evidence context from the old invoice is cleared
   - Ask DW reads the newly selected invoice fresh

3. `Make that shorter.`
   - presentation detail changes to `BRIEF`
   - entity focus remains unchanged
   - truth is re-read rather than copied into case state

4. `Don't do it yet.`
   - the exact pending action is suspended
   - no execution boundary is opened
   - no side effect occurs

5. `Actually do it.`
   - exact deterministic phrase gate confirms only the anchored action reference
   - state becomes `CONFIRMED_PENDING_REVALIDATION`
   - a fresh live read occurs
   - deterministic authority is re-checked
   - case state still reports `executionAuthorized: false`
   - M1F performs no direct execution

## Golden invariants

M1F fails if any of these regress:

- Anthony/client/invoice references lose continuity between turns.
- invoice correction does not invalidate old invoice-scoped work.
- presentation changes mutate entity truth.
- a suspended action executes.
- `Actually do it` becomes authority by itself.
- fresh live read is skipped before the execution boundary.
- fresh authority re-check is skipped.
- canonical balance or canonical truth is persisted into case state.
- the case-aware runtime reports a direct side effect.

## Scope

The golden scenario uses deterministic fixture live reads. This is intentional: it validates the conversation and authority contract without depending on a tenant having a production client literally named Anthony. Live Supabase/provider composition remains covered by the existing Ask DW live-runtime tests.
